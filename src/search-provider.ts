import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
} from './web-search.js'

export type SearchProviderFailureReason = 'TIMEOUT' | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'DISABLED'

export interface SearchProviderOptions {
  maxResults?: number
  timeoutMs?: number
  mode?: 'GENERAL' | 'NEWS_RECENT'
  days?: 1 | 3
  startDate?: string
  endDate?: string
  signal?: AbortSignal
}

/** Provider-neutral result fields. Provider payloads must not cross this boundary. */
export interface SearchResult {
  title: string
  url: string
  snippet: string
  content?: string
  source: string
  provider: string
  publishedAt?: string | null
}

export interface SearchProviderMetadata {
  provider: string
  resultCount: number
  latencyMs?: number
}

export interface SearchProviderResponse {
  results: readonly SearchResult[]
  metadata: SearchProviderMetadata
}

export interface SearchProvider {
  readonly name?: string
  search(query: string, options: SearchProviderOptions): Promise<SearchProviderResponse>
}

export class SearchProviderError extends Error {
  public constructor(public readonly reason: SearchProviderFailureReason) {
    super(`Search provider failed: ${reason}`)
    this.name = 'SearchProviderError'
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) {
      const normalizedKey = key.toLocaleLowerCase()
      if (
        normalizedKey.startsWith('utm_') ||
        normalizedKey === 'spm' ||
        normalizedKey === 'from' ||
        normalizedKey === 'source' ||
        normalizedKey === 'ref' ||
        normalizedKey === 'ref_src'
      ) {
        parsed.searchParams.delete(key)
      }
    }
    return parsed.href
  } catch {
    return null
  }
}

function sourceFromRecord(record: Record<string, unknown>, url: string): string {
  const explicitSource = cleanText(record.source ?? record.engine, 160)
  if (explicitSource.length > 0) {
    return explicitSource
  }
  try {
    return new URL(url).hostname.toLocaleLowerCase()
  } catch {
    return ''
  }
}

/** Normalize the small provider-neutral result contract at the provider boundary. */
export function normalizeSearchResults(input: readonly unknown[], provider: string): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (const item of input) {
    const record = asRecord(item)
    if (record === null) {
      continue
    }
    const url = cleanUrl(record.url)
    if (url === null || seen.has(url)) {
      continue
    }
    const content = cleanText(record.content, 8_000)
    const title = cleanText(record.title, 160)
    const snippet = cleanText(record.snippet ?? content, 1_200)
    if ((title.length === 0 && snippet.length === 0 && content.length === 0)) {
      continue
    }
    seen.add(url)
    const result: SearchResult = {
      title,
      url,
      snippet,
      source: sourceFromRecord(record, url),
      provider,
    }
    if (content.length > 0) {
      result.content = content
    }
    const publishedAt = record.publishedAt ?? record.publishedDate ?? record.published_date
    if (typeof publishedAt === 'string') {
      result.publishedAt = publishedAt.slice(0, 80)
    }
    results.push(result)
  }
  return results
}

/** Keep existing search callers source-compatible while new Providers use the minimal interface. */
export function adaptSearchProvider(provider: SearchProvider): WebSearchProvider & { readonly providerName: string } {
  return {
    providerName: provider.name ?? 'unknown',
    search: async (request: WebSearchRequest): Promise<WebSearchResponse> => {
      const response = await provider.search(request.query, {
        maxResults: request.maxResults,
        timeoutMs: request.timeoutMs,
        mode: request.mode,
        days: request.days,
        startDate: request.startDate,
        endDate: request.endDate,
        signal: request.signal,
      })
      const results: WebSearchResult[] = response.results.map((result, index) => ({
        sourceId: `S${index + 1}`,
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        ...(result.publishedAt === undefined ? {} : { publishedAt: result.publishedAt }),
      }))
      return { results: results.slice(0, request.maxResults) }
    },
  }
}
