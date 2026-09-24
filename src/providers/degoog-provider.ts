import {
  normalizeSearchResults,
  SearchProviderError,
  type SearchProvider,
  type SearchProviderOptions,
  type SearchProviderResponse,
} from '../search-provider.js'

export const DEFAULT_DEGOOG_API_BASE = 'http://127.0.0.1:4444'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function resultsFromPayload(value: unknown): readonly unknown[] | null {
  const record = asRecord(value)
  if (record !== null && Array.isArray(record.results)) {
    return record.results
  }
  const data = record === null ? null : asRecord(record.data)
  return data !== null && Array.isArray(data.results) ? data.results : null
}

export class DegoogSearchProvider implements SearchProvider {
  public readonly name = 'degoog'

  public constructor(private readonly apiBase = DEFAULT_DEGOOG_API_BASE) {}

  public async search(query: string, options: SearchProviderOptions): Promise<SearchProviderResponse> {
    if (!this.apiBase) {
      throw new SearchProviderError('DISABLED')
    }

    let endpoint: URL
    try {
      const base = this.apiBase.replace(/\/+$/u, '')
      endpoint = new URL(base.endsWith('/api/search') ? base : `${base}/api/search`)
    } catch {
      throw new SearchProviderError('HTTP_ERROR')
    }
    endpoint.searchParams.set('q', query)
    endpoint.searchParams.set('lang', 'zh')

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
        response = await fetch(endpoint, { method: 'GET', signal: controller.signal })
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
      const rawResults = resultsFromPayload(payload)
      if (rawResults === null) {
        throw new SearchProviderError('INVALID_RESPONSE')
      }
      const results = normalizeSearchResults(rawResults, this.name).slice(0, options.maxResults ?? rawResults.length)
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
