export interface WebSearchRequest {
  query: string
  maxResults: number
  timeoutMs: number
  mode: WebSearchMode
  days?: 1 | 3
  startDate?: string
  endDate?: string
  signal?: AbortSignal
}

export type WebSearchMode = 'GENERAL' | 'NEWS_RECENT'
export type WebSearchWindow = 'GENERAL' | 'DAY_1' | 'DAY_3'

export interface WebSearchResult {
  sourceId: string
  title: string
  url: string
  snippet: string
  publishedAt?: string | null
}

export interface WebSearchResponse {
  results: readonly WebSearchResult[]
}

export interface GroundedSourceUsage {
  searchUsed: true
  availableSourceCount: number
  referencedSourceCount: number
  validReferencedSourceCount: number
  selectedSourceCount: number
  removedDanglingMarkerCount: number
  visibleMarkerCount: number
  appendedSourceCount: number
  result: 'PASS' | 'NO_REFERENCED_SOURCE'
}

export type GroundedSourceUsageReporter = (usage: GroundedSourceUsage) => void

function selectGroundedSources(
  answer: string,
  results: readonly WebSearchResult[],
  forbiddenValues: readonly string[],
): { safeResults: WebSearchResult[]; groundedIds: string[]; selected: WebSearchResult[] } {
  const safeResults = results.filter((item) => !containsForbiddenValue(`${item.title} ${item.url}`, forbiddenValues))
  const sourceById = new Map(safeResults.map((item) => [item.sourceId, item]))
  const groundedIds = [...new Set(
    [...answer.matchAll(/\[(S\d+)\]/gu)]
      .map((match) => match[1])
      .filter((sourceId): sourceId is string => sourceId !== undefined && sourceById.has(sourceId)),
  )]
  const selected = groundedIds.map((sourceId) => sourceById.get(sourceId)!)
  return { safeResults, groundedIds, selected }
}

/** Inspect grounding without changing the answer or appending sources. */
export function inspectGroundedSources(
  answer: string,
  results: readonly WebSearchResult[],
  forbiddenValues: readonly string[] = [],
): GroundedSourceUsage {
  const selection = selectGroundedSources(answer, results, forbiddenValues)
  const selectedIds = new Set(selection.selected.map((item) => item.sourceId))
  const removedDanglingMarkerCount = [...answer.matchAll(/\[(S\d+)\]/gu)]
    .filter((match) => !selectedIds.has(match[1] ?? ''))
    .length
  return {
    searchUsed: true,
    availableSourceCount: selection.safeResults.length,
    referencedSourceCount: selection.groundedIds.length,
    validReferencedSourceCount: selection.groundedIds.length,
    selectedSourceCount: selection.selected.length,
    removedDanglingMarkerCount,
    visibleMarkerCount: 0,
    appendedSourceCount: selection.selected.length,
    result: selection.selected.length > 0 ? 'PASS' : 'NO_REFERENCED_SOURCE',
  }
}

export interface WebSearchProvider {
  search(request: WebSearchRequest): Promise<WebSearchResponse>
}

export type WebSearchFailureReason = 'TIMEOUT' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'NO_RESULTS' | 'DISABLED'

export class WebSearchError extends Error {
  public constructor(public readonly reason: Exclude<WebSearchFailureReason, 'NO_RESULTS'>) {
    super(`Web search failed: ${reason}`)
    this.name = 'WebSearchError'
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') {
    return ''
  }
  return value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxChars)
}

function cleanUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return null
  }
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    return parsed.href
  } catch {
    return null
  }
}

/** Normalize provider-shaped data before it can enter a prompt or final source list. */
export function normalizeWebSearchResults(input: readonly unknown[]): WebSearchResult[] {
  const results: WebSearchResult[] = []
  const seen = new Set<string>()
  for (const item of input) {
    const record = asRecord(item)
    if (!record) {
      continue
    }
    const url = cleanUrl(record.url)
    const title = cleanText(record.title, 160)
    const snippet = cleanText(record.snippet ?? record.content, 1200)
    if (url === null || (title.length === 0 && snippet.length === 0) || seen.has(url)) {
      continue
    }
    seen.add(url)
    const publishedValue = record.publishedAt ?? record.publishedDate ?? record.published_date
    const normalized: WebSearchResult = { sourceId: `S${results.length + 1}`, title, url, snippet }
    if (typeof publishedValue === 'string') {
      normalized.publishedAt = publishedValue.slice(0, 80)
    }
    results.push(normalized)
  }
  return results
}

export interface WebSearchContext {
  text: string
  results: readonly WebSearchResult[]
  chars: number
  truncated: boolean
}

/** Render only bounded title/snippet data; URLs remain outside the model prompt. */
export function buildWebSearchContext(results: readonly WebSearchResult[], maxChars: number): WebSearchContext {
  const header = '[Web Search Results]\n'
  const budget = Math.max(0, maxChars)
  if (budget <= 0) {
    return { text: '', results: [], chars: 0, truncated: results.length > 0 }
  }

  let text = header.slice(0, budget)
  const selected: WebSearchResult[] = []
  let truncated = text.length < header.length
  for (const item of results) {
    if (text.length >= budget) {
      truncated = true
      break
    }
    const publishedAt = item.publishedAt ? `PublishedAt: ${item.publishedAt}\n` : ''
    const block = `[${item.sourceId}]\n${publishedAt}Title: ${item.title}\nSnippet: ${item.snippet}\n`
    const remaining = budget - text.length
    if (block.length <= remaining) {
      text += block
      selected.push(item)
      continue
    }
    text += block.slice(0, remaining)
    selected.push(item)
    truncated = true
    break
  }

  if (selected.length < results.length) {
    truncated = true
  }
  return { text, results: selected, chars: text.length, truncated }
}

function containsForbiddenValue(value: string, forbiddenValues: readonly string[]): boolean {
  return forbiddenValues.some((forbidden) => forbidden.length > 0 && value.includes(forbidden))
}

function cleanupCitationPresentation(answer: string): string {
  return answer
    .replace(/\[\]/gu, '')
    .replace(/[ \t]+([,，。！？；：.!?;:])/gu, '$1')
    .replace(/([。！？；])[ \t]+(?=[\p{Script=Han}])/gu, '$1')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n')
    .trim()
}

/** Ground source selection before hiding internal markers and remove model-created URLs. */
export function appendGroundedSources(
  answer: string,
  results: readonly WebSearchResult[],
  forbiddenValues: readonly string[] = [],
  reportUsage?: GroundedSourceUsageReporter,
): string {
  const selection = selectGroundedSources(answer, results, forbiddenValues)
  const { safeResults, groundedIds, selected } = selection
  const selectedIds = new Set(selected.map((item) => item.sourceId))
  let removedDanglingMarkerCount = 0

  const groundedAnswer = cleanupCitationPresentation(answer
    .replace(/https?:\/\/[^\s)\]}>]+/gu, (url) => {
      return safeResults.some((item) => item.url === url) ? url : ''
    })
    .replace(/\[(S\d+)\]/gu, (marker, sourceId: string) => {
      if (!selectedIds.has(sourceId)) {
        removedDanglingMarkerCount += 1
      }
      return ''
    }))

  if (reportUsage !== undefined) {
    reportUsage({
      searchUsed: true,
      availableSourceCount: safeResults.length,
      referencedSourceCount: groundedIds.length,
      validReferencedSourceCount: groundedIds.length,
      selectedSourceCount: selected.length,
      removedDanglingMarkerCount,
      visibleMarkerCount: 0,
      appendedSourceCount: selected.length,
      result: selected.length > 0 ? 'PASS' : 'NO_REFERENCED_SOURCE',
    })
  }

  if (selected.length === 0) {
    return groundedAnswer
  }

  const sourceLines = selected.map((item, index) => `${index + 1}. ${item.title} ${item.url}`).join('\n')
  return `${groundedAnswer}\n\n来源：\n${sourceLines}`
}

export class TavilyWebSearchProvider implements WebSearchProvider {
  public constructor(
    private readonly apiBase: string,
    private readonly apiKey: string,
  ) {}

  public async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    if (!this.apiBase || !this.apiKey) {
      throw new WebSearchError('DISABLED')
    }

    const endpoint = this.apiBase.replace(/\/$/u, '').endsWith('/search')
      ? this.apiBase
      : `${this.apiBase.replace(/\/$/u, '')}/search`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.max(1, request.timeoutMs))
    const abortExternal = (): void => controller.abort()
    request.signal?.addEventListener('abort', abortExternal, { once: true })
    try {
      let response: Response
      try {
        const body: Record<string, unknown> = {
          query: request.query,
          search_depth: 'basic',
          max_results: request.maxResults,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
        }
        if (request.mode === 'NEWS_RECENT') {
          body.topic = 'news'
          body.include_published_date = true
          body.filter_by_published_date = true
          if (request.startDate !== undefined) body.start_date = request.startDate
          if (request.endDate !== undefined) body.end_date = request.endDate
        }
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new WebSearchError('TIMEOUT')
        }
        throw new WebSearchError('HTTP_ERROR')
      }

      if (!response.ok) {
        throw new WebSearchError('HTTP_ERROR')
      }

      let data: unknown
      try {
        data = await response.json()
      } catch {
        throw new WebSearchError('INVALID_RESPONSE')
      }
      const record = asRecord(data)
      if (!record || !Array.isArray(record.results)) {
        throw new WebSearchError('INVALID_RESPONSE')
      }
      return { results: normalizeWebSearchResults(record.results).slice(0, request.maxResults) }
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', abortExternal)
    }
  }
}

export class SearXNGWebSearchProvider implements WebSearchProvider {
  private readonly engines: readonly string[]

  public constructor(
    private readonly apiBase: string,
    engines: readonly string[] = ['360search', 'sogou'],
  ) {
    this.engines = engines.map((engine) => engine.trim()).filter((engine) => engine.length > 0)
  }

  public async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    if (!this.apiBase) {
      throw new WebSearchError('DISABLED')
    }

    const base = this.apiBase.replace(/\/+$/u, '')
    const endpoint = base.endsWith('/search') ? base : `${base}/search`
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      throw new WebSearchError('HTTP_ERROR')
    }
    url.searchParams.set('q', request.query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('language', 'zh-CN')
    if (this.engines.length > 0) {
      url.searchParams.set('engines', this.engines.join(','))
    }
    if (request.mode === 'NEWS_RECENT' && request.days !== undefined) {
      // SearXNG exposes a day-level range, not the exact three-day bounds used
      // by Tavily. Keep the window bounded and let NEWS_RECENT prefer Tavily.
      url.searchParams.set('time_range', 'day')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.max(1, request.timeoutMs))
    const abortExternal = (): void => controller.abort()
    if (request.signal?.aborted) {
      controller.abort()
    }
    request.signal?.addEventListener('abort', abortExternal, { once: true })
    try {
      let response: Response
      try {
        response = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new WebSearchError('TIMEOUT')
        }
        throw new WebSearchError('HTTP_ERROR')
      }

      if (!response.ok) {
        throw new WebSearchError('HTTP_ERROR')
      }

      let data: unknown
      try {
        data = await response.json()
      } catch {
        throw new WebSearchError('INVALID_RESPONSE')
      }
      const record = asRecord(data)
      if (!record || !Array.isArray(record.results)) {
        throw new WebSearchError('INVALID_RESPONSE')
      }

      const mappedResults = record.results.map((item) => {
        const result = asRecord(item)
        if (!result) {
          return item
        }
        const mapped: Record<string, unknown> = {
          title: result.title,
          url: result.url,
          snippet: result.content,
        }
        if (Object.prototype.hasOwnProperty.call(result, 'publishedDate')) {
          mapped.publishedAt = result.publishedDate
        }
        return mapped
      })
      return { results: normalizeWebSearchResults(mappedResults).slice(0, request.maxResults) }
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', abortExternal)
    }
  }
}
