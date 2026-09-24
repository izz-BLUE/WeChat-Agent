import {
  normalizeSearchResults,
  SearchProviderError,
  type SearchProvider,
  type SearchProviderOptions,
  type SearchProviderResponse,
} from '../search-provider.js'

export class TavilySearchProvider implements SearchProvider {
  public readonly name = 'tavily'

  public constructor(
    private readonly apiBase: string,
    private readonly apiKey: string,
  ) {}

  public async search(query: string, options: SearchProviderOptions): Promise<SearchProviderResponse> {
    if (!this.apiBase || !this.apiKey) {
      throw new SearchProviderError('DISABLED')
    }

    const base = this.apiBase.replace(/\/$/u, '')
    const endpoint = base.endsWith('/search') ? this.apiBase : `${base}/search`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? 8_000))
    const abortExternal = (): void => controller.abort()
    options.signal?.addEventListener('abort', abortExternal, { once: true })
    try {
      let response: Response
      try {
        const body: Record<string, unknown> = {
          query,
          search_depth: 'basic',
          max_results: options.maxResults ?? 5,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
        }
        if (options.mode === 'NEWS_RECENT') {
          body.topic = 'news'
          body.include_published_date = true
          body.filter_by_published_date = true
          if (options.startDate !== undefined) body.start_date = options.startDate
          if (options.endDate !== undefined) body.end_date = options.endDate
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
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new SearchProviderError('INVALID_RESPONSE')
      }
      const record = payload as Record<string, unknown>
      if (!Array.isArray(record.results)) {
        throw new SearchProviderError('INVALID_RESPONSE')
      }
      const results = normalizeSearchResults(record.results, this.name).slice(0, options.maxResults ?? record.results.length)
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
