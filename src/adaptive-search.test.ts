import { strict as assert } from 'node:assert'
import {
  buildAdaptiveSearchGateUserPrompt,
  isAdaptiveSearchCandidate,
  parseAdaptiveSearchRecoveryProtocol,
} from './adaptive-search.js'
import { ChatService } from './chat.js'
import type { AgentRequest } from './agent-adapter.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import type { RetrievalQualityGateLike } from './retrieval-quality.js'
import type { WebSearchProvider, WebSearchResult } from './web-search.js'
import type { WebSearchPlannerLike } from './web-search-planner.js'

let cases = 0
let failures = 0

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function test(name: string, body: () => Promise<void> | void): Promise<void> {
  cases += 1
  try {
    await body()
    console.log(`[ADAPTIVE_SEARCH_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(`[ADAPTIVE_SEARCH_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
  }
}

const REQUESTER_ID = 'adaptive-requester-secret'
const RUNTIME_TIME = {
  utcIso: '2026-09-17T04:00:00.000Z',
  localDate: '2026-09-17',
  localDateTime: '2026-09-17T12:00:00',
  timeZone: 'Asia/Shanghai',
}

function request(text: string): AgentRequest {
  return {
    conversationKey: 'direct:adaptive-test',
    messageId: `adaptive-${String(cases)}`,
    conversationType: 'DIRECT',
    conversationId: 'conversation-adaptive-secret',
    senderId: REQUESTER_ID,
    requesterId: REQUESTER_ID,
    requesterSource: 'Signature',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    ownerDisplayName: null,
    senderName: '测试用户',
    text,
    rawText: text,
    timestamp: 1_757_000_000_000,
    mentionState: 'NOT_MENTIONED',
    botMentionSpans: { trust: 'VALID', spans: [] },
    userContentSpan: { trust: 'VALID', span: { start: 0, length: text.length } },
    metadata: { rawMessageType: 1 },
  }
}

function directPlanner(): WebSearchPlannerLike {
  return {
    plan: async () => ({
      result: 'PASS',
      decision: {
        action: 'DIRECT',
        query: null,
        reasonCode: 'DIRECT_SUFFICIENT',
        mode: 'GENERAL',
        recencyWindow: 'NONE',
      },
    }),
  }
}

function searchPlanner(): WebSearchPlannerLike {
  return {
    plan: async () => ({
      result: 'PASS',
      decision: {
        action: 'SEARCH',
        query: '已经执行的搜索',
        reasonCode: 'EXTERNAL_VERIFICATION',
        mode: 'GENERAL',
        recencyWindow: 'NONE',
      },
    }),
  }
}

function provider(): { provider: WebSearchProvider; get calls(): number } {
  let calls = 0
  const result: WebSearchResult = {
    sourceId: 'S1',
    title: '公开事实来源',
    url: 'https://example.com/adaptive-source',
    snippet: '公开资料摘要',
  }
  return {
    provider: {
      search: async () => {
        calls += 1
        return { results: [result] }
      },
    },
    get calls() {
      return calls
    },
  }
}

function answerableRetrievalQualityGate(onDecide: () => void): RetrievalQualityGateLike {
  return {
    decide: async () => {
      onDecide()
      return {
        result: 'PASS' as const,
        decision: {
          decision: 'ANSWERABLE' as const,
          reason: 'TEST_FIXTURE_ANSWERABLE',
          missingEvidence: '',
          retryQuery: null,
          retryAlternateQuery: null,
          mode: 'GENERAL' as const,
          window: 'GENERAL' as const,
        },
      }
    },
  }
}

function finalChat(responses: readonly string[]): { chat: ChatService; calls: string[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> }
    const system = body.messages?.[0]?.content ?? ''
    calls.push(system)
    const answer = responses[Math.min(calls.length - 1, responses.length - 1)] ?? ''
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: answer } }] }),
    }
  }) as unknown as typeof fetch
  return {
    chat: new ChatService('https://provider.invalid/v1', 'chat-key', 'adaptive-test-model'),
    calls,
    restore: () => { globalThis.fetch = original },
  }
}

async function runAgent(
  responses: readonly string[],
  planner: WebSearchPlannerLike,
  search: { provider: WebSearchProvider; get calls(): number },
  text: string,
  options: { memory?: unknown; requestDeadlineMs?: number; retrievalQualityGate?: RetrievalQualityGateLike } = {},
): Promise<{ answer: string; calls: string[]; searchCalls: number }> {
  const final = finalChat(responses)
  try {
    const agent = new ProductionChatAgent(final.chat, {
      webSearchPlanner: planner,
      webSearchProvider: search.provider,
      memory: options.memory as never,
      retrievalQualityGate: options.retrievalQualityGate,
      requestDeadlineMs: options.requestDeadlineMs,
      runtimeClock: { now: () => new Date(RUNTIME_TIME.utcIso) },
      runtimeTimeZone: RUNTIME_TIME.timeZone,
    })
    const answer = await agent.complete(request(text))
    return { answer, calls: final.calls, searchCalls: search.calls }
  } finally {
    final.restore()
  }
}

await test('strict gate protocol and cheap candidate are narrow', () => {
  check(isAdaptiveSearchCandidate('我不确定目前谁是最大的主播。'), 'public knowledge gap was not a candidate')
  check(!isAdaptiveSearchCandidate('最大的主播是甲。'), 'confident answer became a candidate')
  const parsed = parseAdaptiveSearchRecoveryProtocol(
    'ACTION=SEARCH_RECOVERY\nREASON=EXTERNALLY_RESOLVABLE_KNOWLEDGE_GAP\nQUERY=燕云十六声 最大主播\nSEARCH_MODE=GENERAL\nRECENCY_WINDOW=NONE',
  )
  assert.equal(parsed.valid, true)
  const keep = parseAdaptiveSearchRecoveryProtocol(
    'ACTION=KEEP_DIRECT\nREASON=NOT_EXTERNALLY_RESOLVABLE\nQUERY=\nSEARCH_MODE=GENERAL\nRECENCY_WINDOW=NONE',
  )
  assert.equal(keep.valid, true)
  check(buildAdaptiveSearchGateUserPrompt({ question: '谁是最大的主播？', draft: '我不确定。', authorizedMemory: [] }).includes('Authorized Memory'), 'gate prompt lost memory boundary')
})

await test('public fact recovery searches once and reuses grounding', async () => {
  const search = provider()
  const result = await runAgent([
    '我不确定目前谁是最大的主播。',
    'ACTION=SEARCH_RECOVERY\nREASON=EXTERNALLY_RESOLVABLE_KNOWLEDGE_GAP\nQUERY=燕云十六声 最大主播\nSEARCH_MODE=GENERAL\nRECENCY_WINDOW=NONE',
    'DECISION=ANSWERABLE\nREASON=ROUND1_SUFFICIENT\nMISSING_EVIDENCE=\nRETRY_QUERY=\nRETRY_ALT_QUERY=\nSEARCH_MODE=GENERAL\nRECENCY_WINDOW=NONE',
    '目前能确认的公开资料是甲。[S1]',
  ], directPlanner(), search, '燕云十六声最大的主播是谁？')
  check(result.searchCalls === 1, `expected one recovery search, got ${result.searchCalls}`)
  check(result.calls.length === 4, `expected draft, adaptive gate, quality gate, regenerated final, got ${result.calls.length}`)
  check(result.answer.includes('目前能确认的公开资料是甲。') && !result.answer.includes('[S1]') && !result.answer.includes('公开事实来源') && !result.answer.includes('https://example.com/adaptive-source') && !result.answer.includes('来源：'), 'recovery final did not use normal grounding')
  console.log('ADAPTIVE_SEARCH_PUBLIC_FACT=PASS')
  console.log('ADAPTIVE_SEARCH_GROUNDING_REUSED=PASS')
})

await test('private/local fact is blocked by the semantic gate', async () => {
  const search = provider()
  const result = await runAgent([
    '我不知道你昨天吃了什么。',
    'ACTION=KEEP_DIRECT\nREASON=NOT_EXTERNALLY_RESOLVABLE\nQUERY=\nSEARCH_MODE=GENERAL\nRECENCY_WINDOW=NONE',
  ], directPlanner(), search, '我昨天吃了什么？')
  check(result.searchCalls === 0 && result.calls.length === 2, 'private fact triggered search')
  console.log('ADAPTIVE_SEARCH_PRIVATE_FACT_BLOCKED=PASS')
})

await test('memory-sufficient fact is blocked by the semantic gate', async () => {
  const search = provider()
  const memory = {
    isEnabled: true,
    tryHandleSelfAddressPreference: async () => ({ handled: false, reply: '' }),
    tryHandleExplicit: async () => ({ handled: false, reply: '' }),
    observeHumanMessage: () => undefined,
    retrieveForChat: async () => [{ scope: 'GROUP', content: '噗噗是群里对某人的称呼' }],
  }
  const result = await runAgent([
    '我不确定噗噗是谁。',
    'ACTION=KEEP_DIRECT\nREASON=NOT_A_REAL_KNOWLEDGE_GAP\nQUERY=\nSEARCH_MODE=GENERAL\nRECENCY_WINDOW=NONE',
  ], directPlanner(), search, '噗噗是谁？', { memory })
  check(result.searchCalls === 0, 'memory-sufficient question triggered search')
  console.log('ADAPTIVE_SEARCH_MEMORY_SUFFICIENT_BLOCKED=PASS')
})

await test('math and programming remain direct without a gate call', async () => {
  const search = provider()
  const result = await runAgent(['1+1 等于 2。'], directPlanner(), search, '1+1 等于几？')
  check(result.searchCalls === 0 && result.calls.length === 1, 'stable knowledge added recovery call')
})

await test('already searched turns never recover a second time', async () => {
  const search = provider()
  let qualityGateCalls = 0
  const result = await runAgent(
    ['已经查到资料了。[S1]'],
    searchPlanner(),
    search,
    '当前产品现在多少钱？',
    { retrievalQualityGate: answerableRetrievalQualityGate(() => { qualityGateCalls += 1 }) },
  )
  check(result.searchCalls === 1 && qualityGateCalls === 1 && result.calls.length === 1, 'normal SEARCH performed an adaptive recovery')
  console.log('ADAPTIVE_SEARCH_ALREADY_SEARCHED_BLOCKED=PASS')
})

await test('gate failure fails closed', async () => {
  const search = provider()
  const result = await runAgent(['我不确定目前的公开状态。', 'malformed'], directPlanner(), search, '某公司最近有什么变化？')
  check(result.searchCalls === 0 && result.answer.includes('我不确定'), 'gate failure did not keep the direct draft')
  console.log('ADAPTIVE_SEARCH_GATE_FAILURE_FAIL_CLOSED=PASS')
})

await test('deadline guard skips recovery before gate or search', async () => {
  const search = provider()
  const result = await runAgent(['我不确定目前谁是最大的主播。'], directPlanner(), search, '燕云十六声最大的主播是谁？', { requestDeadlineMs: 1_000 })
  check(result.searchCalls === 0 && result.calls.length === 1, 'insufficient deadline budget started recovery')
  console.log('ADAPTIVE_SEARCH_DEADLINE_GUARD=PASS')
})

await test('recovery is at most one attempt and diagnostics do not expose identities', async () => {
  const search = provider()
  const originalLog = console.log
  const logs: string[] = []
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '))
  try {
    const result = await runAgent([
      '我不确定目前谁是最大的主播。',
      `ACTION=SEARCH_RECOVERY\nREASON=EXTERNALLY_RESOLVABLE_KNOWLEDGE_GAP\nQUERY=${REQUESTER_ID}\nSEARCH_MODE=GENERAL\nRECENCY_WINDOW=NONE`,
    ], directPlanner(), search, `谁是最大的主播？${REQUESTER_ID}`)
    check(result.searchCalls === 0, 'identity-bearing recovery query reached provider')
    check(logs.filter((line) => line.includes('[ADAPTIVE_SEARCH_RECOVERY]')).length <= 3, 'recovery emitted more than one attempt')
    check(!logs.some((line) => line.includes(REQUESTER_ID)), 'raw identity appeared in recovery diagnostics')
    originalLog('ADAPTIVE_SEARCH_MAX_ONE_ATTEMPT=PASS')
    originalLog('ADAPTIVE_SEARCH_NO_RAW_IDENTITY_LOG=PASS')
  } finally {
    console.log = originalLog
  }
})

console.log(`[ADAPTIVE_SEARCH_TEST_SUMMARY] cases=${cases} failures=${failures}`)
if (failures > 0) process.exitCode = 1
