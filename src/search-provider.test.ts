import { strict as assert } from 'node:assert'
import { config } from './config.js'
import { DegoogSearchProvider } from './providers/degoog-provider.js'
import { SearXNGSearchProvider } from './providers/searxng-provider.js'
import { createProductionAgent } from './production-agent-receiver.js'
import { SearchProviderError, type SearchProvider } from './search-provider.js'
import type { WebSearchProvider, WebSearchRequest } from './web-search.js'

let cases = 0
let failures = 0

async function test(name: string, body: () => Promise<void> | void): Promise<void> {
  cases += 1
  try {
    await body()
    console.log(`[SEARCH_PROVIDER_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(`[SEARCH_PROVIDER_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
  }
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response
}

const options = { maxResults: 3, timeoutMs: 100, mode: 'GENERAL' as const }

type ProductionSearchFields = {
  webSearchPlanner: unknown | null
  configuredSearchProvider: (WebSearchProvider & { providerName?: string }) | null
  configuredSearchFallbackProvider: (WebSearchProvider & { providerName?: string }) | null
  tavilyWebSearchProvider: (WebSearchProvider & { providerName?: string }) | null
  searxngWebSearchProvider: (WebSearchProvider & { providerName?: string }) | null
}

function productionSearchFields(agent: unknown): ProductionSearchFields {
  return agent as ProductionSearchFields
}

function createRoutedAgent(): ProductionSearchFields {
  const previousLog = console.log
  console.log = () => undefined
  try {
    return productionSearchFields(createProductionAgent({ pipeName: 'search-provider-route-test', mode: 'real' }))
  } finally {
    console.log = previousLog
  }
}

await test('Degoog success', async () => {
  const original = globalThis.fetch
  let requestUrl = ''
  let requestMethod = ''
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input)
      requestMethod = init?.method ?? ''
      return jsonResponse({ results: [{
        title: '本地聚合标题',
        url: 'https://example.com/degoog',
        snippet: '<p>聚合摘要</p>',
        content: '<p>正文证据</p>',
        source: 'public-web',
        engine: 'must-not-leak',
      }] })
    }) as typeof fetch
    const response = await new DegoogSearchProvider('http://127.0.0.1:4444').search('中文问题', options)
    const url = new URL(requestUrl)
    assert.equal(requestMethod, 'GET')
    assert.equal(url.pathname, '/api/search')
    assert.equal(url.searchParams.get('q'), '中文问题')
    assert.equal(url.searchParams.get('lang'), 'zh')
    assert.equal(response.metadata.provider, 'degoog')
    assert.equal(response.metadata.resultCount, 1)
    assert.deepEqual(response.results[0], {
      title: '本地聚合标题',
      url: 'https://example.com/degoog',
      snippet: '聚合摘要',
      content: '正文证据',
      source: 'public-web',
      provider: 'degoog',
    })
    assert.equal(Object.prototype.hasOwnProperty.call(response.results[0], 'engine'), false)
  } finally {
    globalThis.fetch = original
  }
})

await test('SearXNG success', async () => {
  const original = globalThis.fetch
  let requestUrl = ''
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestUrl = String(input)
      return jsonResponse({ results: [{
        title: '兼容标题',
        url: 'https://example.com/searxng',
        content: '<p>兼容摘要</p>',
        engine: 'sogou',
        publishedDate: '2026-09-18',
      }] })
    }) as typeof fetch
    const response = await new SearXNGSearchProvider('http://127.0.0.1:8088', ['360search', 'sogou'])
      .search('中文查询', { ...options, mode: 'NEWS_RECENT', days: 1 })
    const url = new URL(requestUrl)
    assert.equal(url.pathname, '/search')
    assert.equal(url.searchParams.get('q'), '中文查询')
    assert.equal(url.searchParams.get('format'), 'json')
    assert.equal(url.searchParams.get('language'), 'zh-CN')
    assert.equal(url.searchParams.get('engines'), '360search,sogou')
    assert.equal(url.searchParams.get('time_range'), 'day')
    assert.equal(response.results[0]?.source, 'sogou')
    assert.equal(response.results[0]?.provider, 'searxng')
    assert.equal(response.results[0]?.publishedAt, '2026-09-18')
  } finally {
    globalThis.fetch = original
  }
})

await test('Provider switch degoog to searxng', async () => {
  const original = globalThis.fetch
  const paths: string[] = []
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      paths.push(new URL(String(input)).pathname)
      return jsonResponse({ results: [{ title: '结果', url: `https://example.com/${paths.length}`, snippet: '摘要' }] })
    }) as typeof fetch
    let provider: SearchProvider = new DegoogSearchProvider('http://127.0.0.1:4444')
    const first = await provider.search('切换前', options)
    provider = new SearXNGSearchProvider('http://127.0.0.1:8088')
    const second = await provider.search('切换后', options)
    assert.deepEqual(paths, ['/api/search', '/search'])
    assert.equal(first.metadata.provider, 'degoog')
    assert.equal(second.metadata.provider, 'searxng')
  } finally {
    globalThis.fetch = original
  }
})

await test('Degoog timeout', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })) as typeof fetch
    await assert.rejects(
      () => new DegoogSearchProvider().search('超时', { ...options, timeoutMs: 5 }),
      (error: unknown) => error instanceof SearchProviderError && error.reason === 'TIMEOUT',
    )
  } finally {
    globalThis.fetch = original
  }
})

await test('empty result', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = (async () => jsonResponse({ results: [] })) as typeof fetch
    const response = await new DegoogSearchProvider().search('没有结果', options)
    assert.deepEqual(response.results, [])
    assert.equal(response.metadata.resultCount, 0)
  } finally {
    globalThis.fetch = original
  }
})

await test('production factory routes configured providers and keeps disabled search inert', async () => {
  const configKeys = [
    'openAiApiBase', 'openAiApiKey', 'openAiModel', 'memoryEnabled', 'webSearchEnabled',
    'searchProvider', 'webSearchProvider', 'degoogApiBase', 'tavilyApiBase', 'tavilyApiKey',
    'searxngEnabled', 'searxngApiBase', 'searxngEngines',
  ] as const
  const savedConfig = Object.fromEntries(configKeys.map((key) => [key, config[key]]))
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const requests: Array<{ url: URL; authorization: string | null; body: string }> = []
  const baseConfig = {
    openAiApiBase: 'https://completion.invalid/v1',
    openAiApiKey: 'test-completion-key',
    openAiModel: 'test-model',
    memoryEnabled: false,
    webSearchEnabled: false,
    searchProvider: 'degoog',
    webSearchProvider: 'degoog',
    degoogApiBase: 'https://degoog.test',
    tavilyApiBase: '',
    tavilyApiKey: '',
    searxngEnabled: false,
    searxngApiBase: 'https://searxng.test',
    searxngEngines: ['360search', 'sogou'],
  }
  const request: WebSearchRequest = {
    query: 'provider routing probe',
    maxResults: 2,
    timeoutMs: 100,
    mode: 'GENERAL',
  }

  try {
    console.log = () => undefined
    Object.assign(config, baseConfig)
    const disabled = createRoutedAgent()
    assert.equal(disabled.webSearchPlanner, null)
    assert.equal(disabled.configuredSearchProvider, null)
    assert.equal(disabled.configuredSearchFallbackProvider, null)
    assert.equal(disabled.tavilyWebSearchProvider, null)
    assert.equal(disabled.searxngWebSearchProvider, null)

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
        body: String(init?.body ?? ''),
      })
      const resultUrl = `https://results.test/${url.hostname}`
      return jsonResponse({ results: [{ title: 'routing result', url: resultUrl, snippet: 'snippet', content: 'content' }] })
    }) as typeof fetch

    Object.assign(config, { ...baseConfig, webSearchEnabled: true, searxngEnabled: true })
    const degoog = createRoutedAgent()
    assert.equal(degoog.webSearchPlanner !== null, true)
    assert.equal(degoog.configuredSearchProvider?.providerName, 'degoog')
    assert.equal(degoog.configuredSearchFallbackProvider?.providerName, 'searxng')
    assert.equal(degoog.tavilyWebSearchProvider, null)
    await degoog.configuredSearchProvider!.search(request)
    await degoog.configuredSearchFallbackProvider!.search(request)
    assert.equal(requests[0]?.url.origin, 'https://degoog.test')
    assert.equal(requests[0]?.url.pathname, '/api/search')
    assert.equal(requests[0]?.url.searchParams.get('q'), request.query)
    assert.equal(requests[0]?.url.searchParams.get('lang'), 'zh')
    assert.equal(requests[1]?.url.origin, 'https://searxng.test')
    assert.equal(requests[1]?.url.searchParams.get('engines'), '360search,sogou')

    Object.assign(config, { ...baseConfig, webSearchEnabled: true, searchProvider: 'searxng', webSearchProvider: 'searxng', searxngEnabled: true })
    const searxng = createRoutedAgent()
    assert.equal(searxng.configuredSearchProvider?.providerName, 'searxng')
    assert.equal(searxng.configuredSearchFallbackProvider, null)
    await searxng.configuredSearchProvider!.search(request)
    assert.equal(requests[2]?.url.origin, 'https://searxng.test')
    assert.equal(requests[2]?.url.searchParams.get('engines'), '360search,sogou')

    Object.assign(config, {
      ...baseConfig,
      webSearchEnabled: true,
      searchProvider: 'tavily',
      webSearchProvider: 'tavily',
      tavilyApiBase: 'https://tavily.test',
      tavilyApiKey: 'test-tavily-key',
    })
    const tavily = createRoutedAgent()
    assert.equal(tavily.configuredSearchProvider, null)
    assert.equal(tavily.tavilyWebSearchProvider?.providerName, 'tavily')
    await tavily.tavilyWebSearchProvider!.search(request)
    assert.equal(requests[3]?.url.origin, 'https://tavily.test')
    assert.equal(requests[3]?.url.pathname, '/search')
    assert.equal(requests[3]?.authorization, 'Bearer test-tavily-key')
    assert.equal(JSON.parse(requests[3]?.body ?? '{}').include_answer, false)
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
    Object.assign(config, savedConfig)
  }
})

console.log(`[SEARCH_PROVIDER_TEST_SUMMARY] cases=${cases} failures=${failures}`)
if (failures > 0) {
  process.exitCode = 1
}
