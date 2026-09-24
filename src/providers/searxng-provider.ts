import {
  normalizeSearchResults,
  SearchProviderError,
  type SearchProvider,
  type SearchProviderOptions,
  type SearchProviderResponse,
} from '../search-provider.js'

export class SearXNGSearchProvider implements SearchProvider {
  public readonly name = 'searxng'
  private readonly engines: readonly string[]

  public constructor(
    private readonly apiBase: string,
    engines: readonly string[] = ['360search', 'sogou'],
  ) {
    this.engines = engines.map((engine) => engine.trim()).filter((engine) => engine.length > 0)
  }

  public async search(query: string, options: SearchProviderOptions): Promise<SearchProviderResponse> {
    if (!this.apiBase) {
      throw new SearchProviderError('DISABLED')
    }

    const base = this.apiBase.replace(/\/+$/u, '')
    const endpoint = base.endsWith('/search') ? base : `${base}/search`
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      throw new SearchProviderError('HTTP_ERROR')
    }
    url.searchParams.set('q', query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('language', 'zh-CN')
    if (this.engines.length > 0) {
      url.searchParams.set('engines', this.engines.join(','))
    }
    if (options.mode === 'NEWS_RECENT' && options.days !== undefined) {
      // SearXNG exposes a day-level range; keep the existing bounded behavior.
      url.searchParams.set('time_range', 'day')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? 8_000))
    const abortExternal = (): void => controller.abort()
    if (options.signal?.aborted) {
      controller.abort()
    }
    options.signal?.addEventListener('abort', abortExternal, { once: true })
    try {
      let response: Response
      try {
        response = await fetch(url, { method: 'GET', signal: controller.signal })
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new SearchProviderError('TIMEOUT')
        }
        throw new SearchProviderError('HTTP_ERROR')
      }
      if (!response.ok) {
        throw new SearchProviderError('HTTP_ERROR')
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new SearchProviderError('INVALID_RESPONSE')
      }
      const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null
      if (record === null || !Array.isArray(record.results)) {
        throw new SearchProviderError('INVALID_RESPONSE')
      }
      const mappedResults = record.results.map((item) => {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) {
          return item
        }
        const result = item as Record<string, unknown>
        return {
          title: result.title,
          url: result.url,
          snippet: result.content ?? result.snippet,
          content: result.content,
          source: result.source ?? result.engine,
          publishedAt: result.publishedDate ?? result.publishedAt,
        }
      })
      const results = normalizeSearchResults(mappedResults, this.name).slice(0, options.maxResults ?? mappedResults.length)
      return {
        results,
        metadata: {
          provider: this.name,
          resultCount: results.length,
        },
      }
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abortExternal)
    }
  }
}
