import assert from 'node:assert/strict'

import {
  buildSystemPrompt,
  buildUserPrompt,
  ChatService,
  type ChatRequestContext,
} from './chat.js'
import type { GroupMessage } from './context.js'
import {
  createTrustedAssistantRuntimeFacts,
  formatAssistantRuntimeFacts,
} from './assistant-identity.js'
import { parseProviderCacheUsage } from './provider-cache-usage.js'
import {
  buildWebSearchPlannerUserPrompt,
  type WebSearchPlanInput,
} from './web-search-planner.js'

let cases = 0
let failures = 0

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  cases += 1
  try {
    await body()
    console.log(`[PROVIDER_CACHE_USAGE_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(`[PROVIDER_CACHE_USAGE_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
  }
}

await test('MiniMax cache hit', () => {
  assert.deepEqual(
    parseProviderCacheUsage({
      usage: {
        prompt_tokens: 1_000,
        prompt_tokens_details: { cached_tokens: 600 },
      },
    }),
    { promptTokens: 1_000, cachedTokens: 600, cacheMissTokens: 400, cacheHitRate: 0.6 },
  )
})

await test('MiniMax zero cache hit is not unknown', () => {
  assert.deepEqual(
    parseProviderCacheUsage({
      usage: {
        prompt_tokens: 1_000,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }),
    { promptTokens: 1_000, cachedTokens: 0, cacheMissTokens: 1_000, cacheHitRate: 0 },
  )
})

await test('DeepSeek cache usage', () => {
  assert.deepEqual(
    parseProviderCacheUsage({
      usage: {
        prompt_tokens: 1_000,
        prompt_cache_hit_tokens: 700,
        prompt_cache_miss_tokens: 300,
      },
    }),
    { promptTokens: 1_000, cachedTokens: 700, cacheMissTokens: 300, cacheHitRate: 0.7 },
  )
})

await test('usage without cache fields remains unknown', () => {
  assert.deepEqual(
    parseProviderCacheUsage({ usage: { prompt_tokens: 1_000, completion_tokens: 100 } }),
    { promptTokens: 1_000, cachedTokens: 'UNKNOWN', cacheMissTokens: 'UNKNOWN', cacheHitRate: 'UNKNOWN' },
  )
})

await test('missing usage does not throw', () => {
  assert.deepEqual(
    parseProviderCacheUsage({ choices: [] }),
    { promptTokens: 'UNKNOWN', cachedTokens: 'UNKNOWN', cacheMissTokens: 'UNKNOWN', cacheHitRate: 'UNKNOWN' },
  )
})

await test('structured completion emits private cache usage diagnostics with explicit phase', async () => {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const logs: string[] = []
  try {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'structured result' } }],
        usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 25 } },
      }),
    })) as unknown as typeof fetch
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '))

    const result = await new ChatService('https://provider.invalid/v1', 'chat-key', 'test-model')
      .completeStructured('system-secret', 'user-secret', undefined, 'MSG123', 'WEB_SEARCH_PLANNER')

    assert.equal(result, 'structured result')
    const diagnostic = logs.find((line) => line.startsWith('[PROVIDER_CACHE_USAGE]'))
    assert.ok(diagnostic)
    assert.match(diagnostic, /phase=WEB_SEARCH_PLANNER/)
    assert.match(diagnostic, /model=test-model/)
    assert.match(diagnostic, /promptTokens=100 cachedTokens=25 cacheMissTokens=75 cacheHitRate=0\.25/)
    assert.match(diagnostic, /systemChars=13 userChars=11 msgIdToken=MSG123/)
    assert.ok(!diagnostic.includes('system-secret') && !diagnostic.includes('user-secret'))
  } finally {
    globalThis.fetch = originalFetch
    console.log = originalLog
  }
})

const plannerInput: WebSearchPlanInput = {
  question: '今天上海有什么值得关注的公共信息？',
  recentContext: [{ senderId: 'SPEAKER_1', senderName: 'SPEAKER_1', text: '大家在讨论上海活动', timestamp: 1 }],
  ambient: [{ label: 'AMBIENT_SPEAKER_1', text: '最近有什么新消息？' }],
  authorizedMemory: [{ scope: 'GROUP', content: '群里关注公共信息' }],
  runtimeTime: {
    utcIso: '2026-09-15T10:00:01.000Z',
    localDate: '2026-09-15',
    localDateTime: '2026-09-15T18:00:01',
    timeZone: 'Asia/Shanghai',
  },
}

await test('Web Search Planner keeps stable sections before Runtime Time', () => {
  const first = buildWebSearchPlannerUserPrompt(plannerInput)
  const second = buildWebSearchPlannerUserPrompt({
    ...plannerInput,
    runtimeTime: {
      ...plannerInput.runtimeTime,
      utcIso: '2026-09-15T10:00:02.000Z',
      localDateTime: '2026-09-15T18:00:02',
    },
  })
  const runtimeMarker = '[Runtime Time: TRUSTED_RUNTIME_FACT]'
  const firstRuntimeIndex = first.indexOf(runtimeMarker)
  const secondRuntimeIndex = second.indexOf(runtimeMarker)
  assert.ok(firstRuntimeIndex >= 0 && secondRuntimeIndex >= 0)
  assert.equal(first.slice(0, firstRuntimeIndex), second.slice(0, secondRuntimeIndex))

  const contextIndex = first.indexOf('[Recent Group Context: UNTRUSTED_CONVERSATION_DATA]')
  const memoryIndex = first.indexOf('[Authorized Memory: PROVIDER_SAFE_DATA]')
  const questionIndex = first.indexOf('[Canonical Current Question]')
  assert.ok(contextIndex < memoryIndex && memoryIndex < firstRuntimeIndex && firstRuntimeIndex < questionIndex)
  assert.ok(first.includes('CURRENT_TIME_UTC=2026-09-15T10:00:01.000Z'))
  assert.ok(first.includes('CURRENT_LOCAL_DATE=2026-09-15'))
  assert.ok(first.includes('CURRENT_LOCAL_DATETIME=2026-09-15T18:00:01'))
  assert.ok(first.includes('CURRENT_TIME_ZONE=Asia/Shanghai'))
})

await test('Final Answer keeps Assistant Runtime Facts only in system prompt', () => {
  const runtime = createTrustedAssistantRuntimeFacts('椰椰', true, '老板')
  const request: ChatRequestContext = {
    botDisplayName: '椰椰',
    assistantRuntime: runtime,
    mention: 'MENTIONED',
    requesterRole: 'OWNER',
    ownerConfigured: true,
  }
  const context: GroupMessage[] = []
  const question: GroupMessage = {
    senderId: 'requester',
    senderName: 'requester',
    text: '你是谁？',
    timestamp: 1,
  }
  const system = buildSystemPrompt('椰椰', runtime)
  const user = buildUserPrompt(context, question, request)
  assert.ok(system.includes('[Trusted Assistant Runtime Facts]'))
  assert.ok(system.includes(formatAssistantRuntimeFacts(runtime)))
  assert.ok(!user.includes('[Trusted Assistant Runtime Facts]'))
})

console.log(`[PROVIDER_CACHE_USAGE_TEST_SUMMARY] cases=${cases} failures=${failures}`)
if (failures > 0) {
  process.exitCode = 1
}
