import assert from 'node:assert/strict'
import {
  ChatService,
  MIN_FINAL_ANSWER_BUDGET_MS,
  MIN_GROUNDING_REPAIR_BUDGET_MS,
  WEB_SEARCH_GROUNDING_FAILURE_REPLY,
  type ChatRequestContext,
} from './chat.js'
import type { AgentRequest } from './agent-adapter.js'
import type { GroupMessage } from './context.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import { isRequestDeadlineExceeded, RequestDeadline, withRequestDeadline } from './request-deadline.js'
import { YEYE_REPLY_SIGNATURE } from './chat-renderer.js'
import type { WebSearchProvider } from './web-search.js'

const FALLBACK = '这次处理有点超时了，稍后再问我一次。'

const REQUEST: AgentRequest = {
  conversationKey: 'group:deadline-room@chatroom',
  messageId: 'deadline-request-1',
  conversationType: 'GROUP',
  conversationId: 'deadline-room@chatroom',
  senderId: 'deadline-sender',
  requesterId: 'deadline-sender',
  requesterSource: 'TEST',
  requesterRole: 'MEMBER',
  ownerConfigured: false,
  ownerDisplayName: null,
  publicDisplayName: '测试成员',
  senderName: '测试成员',
  text: '请回答这个长请求',
  timestamp: Date.now(),
  mentionState: 'MENTIONED',
  botMentionSpans: { trust: 'VALID', spans: [] },
  userContentSpan: { trust: 'VALID', span: { start: 0, length: 10 } },
  metadata: { rawMessageType: 1 },
}

const SEARCH_RESULT = {
  sourceId: 'S1',
  title: '测试来源',
  url: 'https://example.test/source',
  snippet: '测试资料',
}

function completionResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function withMockFetch(
  handler: (init?: RequestInit) => Promise<Response>,
  action: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => handler(init)) as typeof fetch
  try {
    await action()
  } finally {
    globalThis.fetch = originalFetch
  }
}

function searchAgent(
  chatService: ChatService,
  provider: WebSearchProvider,
  requestDeadlineMs = 500,
): ProductionChatAgent {
  return new ProductionChatAgent(chatService, {
    requestDeadlineMs,
    webSearchPlanner: {
      async plan() {
        return {
          result: 'PASS' as const,
          decision: {
            action: 'SEARCH' as const,
            query: '测试资料',
            reasonCode: 'EXPLICIT_SEARCH_REQUEST' as const,
            mode: 'GENERAL' as const,
            recencyWindow: 'NONE' as const,
          },
          attempts: 1,
        }
      },
    },
    webSearchProvider: provider,
    webSearchTimeoutMs: 8_000,
  })
}

const GROUNDING_REQUEST: ChatRequestContext = {
  botDisplayName: '椰椰',
  mention: 'MENTIONED',
  requesterRole: 'MEMBER',
  ownerConfigured: false,
  webSearch: {
    used: true,
    status: 'PASS',
    results: [SEARCH_RESULT],
    mode: 'GENERAL',
    window: 'GENERAL',
  },
}

const GROUNDING_QUESTION: GroupMessage = {
  senderId: 'sender',
  senderName: 'CURRENT_REQUESTER',
  publicDisplayName: '测试成员',
  text: '测试搜索问题',
  timestamp: 1,
  messageId: 'grounding-request',
}

const FINAL_REQUEST: ChatRequestContext = {
  botDisplayName: '椰椰',
  mention: 'MENTIONED',
  requesterRole: 'MEMBER',
  ownerConfigured: false,
}

const FINAL_QUESTION: GroupMessage = {
  senderId: 'sender',
  senderName: 'CURRENT_REQUESTER',
  publicDisplayName: '测试成员',
  text: '低预算测试',
  timestamp: 1,
  messageId: 'final-budget-request',
}

async function testDirectSufficient(): Promise<void> {
  let calls = 0
  await withMockFetch(async () => {
    calls += 1
    return completionResponse('正常回复')
  }, async () => {
    const agent = new ProductionChatAgent(
      new ChatService('https://provider.invalid/v1', 'test-key', 'test-model'),
      { requestDeadlineMs: 500 },
    )
    const result = await agent.complete({
      ...REQUEST,
      conversationType: 'DIRECT',
      conversationId: 'direct-sufficient',
      mentionState: 'NOT_MENTIONED',
      botMentionSpans: undefined,
      userContentSpan: undefined,
    })
    assert.equal(result, `正常回复${YEYE_REPLY_SIGNATURE}`)
    assert.equal(calls, 1)
    assert.notEqual(agent.takeOutboundIdentity({ ...REQUEST, conversationType: 'DIRECT', conversationId: 'direct-sufficient' }, result), null)
  })
}

async function testFinalAnswerRunsWithLowBudget(): Promise<void> {
  let calls = 0
  const deadline = new RequestDeadline(MIN_FINAL_ANSWER_BUDGET_MS - 1, () => 0, 0)
  await withMockFetch(async () => {
    calls += 1
    return completionResponse('低预算仍然执行最终回答')
  }, async () => {
    const result = await new ChatService('https://provider.invalid/v1', 'test-key', 'test-model').reply(
      [],
      FINAL_QUESTION,
      FINAL_REQUEST,
      [],
      undefined,
      FINAL_QUESTION.messageId,
      deadline,
    )
    assert.equal(result, '低预算仍然执行最终回答')
    assert.equal(calls, 1)
  })
}

async function testProviderControlRepairBudgetGate(): Promise<void> {
  let calls = 0
  let now = 0
  const deadline = new RequestDeadline(MIN_FINAL_ANSWER_BUDGET_MS + 1, () => now, 0)
  await withMockFetch(async () => {
    calls += 1
    now = 100
    return completionResponse('<tool_call>search</tool_call>')
  }, async () => {
    await assert.rejects(
      () => new ChatService('https://provider.invalid/v1', 'test-key', 'test-model').reply(
        [],
        FINAL_QUESTION,
        FINAL_REQUEST,
        [],
        undefined,
        FINAL_QUESTION.messageId,
        deadline,
      ),
      /Provider control markup was blocked/u,
    )
    assert.equal(calls, 1)
    assert.ok(deadline.remainingMs() < MIN_FINAL_ANSWER_BUDGET_MS)
  })
}

async function testAnswerGuardRegenerationBudgetGate(): Promise<void> {
  let calls = 0
  let now = 0
  const deadline = new RequestDeadline(MIN_FINAL_ANSWER_BUDGET_MS + 1, () => now, 0)
  const context: GroupMessage[] = [{
    senderId: 'other-sender',
    senderName: 'MEMBER_1',
    publicDisplayName: '其他成员',
    text: '给你取了名字',
    timestamp: 1,
    messageId: 'other-message',
  }]
  await withMockFetch(async () => {
    calls += 1
    now = 100
    return completionResponse('你就是 MEMBER_1，刚才给我取了名字。')
  }, async () => {
    await assert.rejects(
      () => new ChatService('https://provider.invalid/v1', 'test-key', 'test-model').reply(
        context,
        FINAL_QUESTION,
        { ...FINAL_REQUEST, currentSpeakerLabel: 'CURRENT_REQUESTER' },
        [],
        undefined,
        FINAL_QUESTION.messageId,
        deadline,
      ),
      /internal runtime labels/u,
    )
    assert.equal(calls, 1)
    assert.ok(deadline.remainingMs() < MIN_FINAL_ANSWER_BUDGET_MS)
  })
}

async function testSearchAndFinalWithinDeadline(): Promise<void> {
  let calls = 0
  const logs: string[] = []
  const provider: WebSearchProvider = {
    async search() {
      return { results: [SEARCH_RESULT] }
    },
  }
  const originalLog = console.log
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '))
  await withMockFetch(async (init) => {
    calls += 1
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> }
    const system = body.messages?.[0]?.content ?? ''
    return completionResponse(system.includes('Retrieval Quality Gate')
      ? 'DECISION=ANSWERABLE\nREASON=ROUND1_SUFFICIENT\nMISSING_EVIDENCE=\nRETRY_QUERY=\nRETRY_ALT_QUERY=\nSEARCH_MODE=GENERAL\nRECENCY_WINDOW=NONE'
      : '搜索结论 [S1]')
  }, async () => {
    try {
      const result = await searchAgent(
        new ChatService('https://provider.invalid/v1', 'test-key', 'test-model'),
        provider,
        50_000,
      ).complete(REQUEST)
      assert.match(result, /搜索结论/u)
      assert.ok(logs.some((line) => line.includes('phase=RETRIEVAL_QUALITY_GATE')), 'Quality Gate phase was not observed')
      assert.ok(logs.some((line) => line.includes('phase=FINAL_ANSWER')), 'Final Answer phase was not observed')
      assert.ok(logs.some((line) => line.includes('budgetMs=50000') && line.includes('result=COMPLETED')), '50s deadline did not complete')
      assert.ok(calls >= 2, 'Quality Gate and Final Answer did not both reach the provider')
    } finally {
      console.log = originalLog
    }
  })
}

async function testGroundingRepairAllowed(): Promise<void> {
  let calls = 0
  const provider: WebSearchProvider = { async search() { return { results: [SEARCH_RESULT] } } }
  await withMockFetch(async () => {
    calls += 1
    return completionResponse(calls === 1 ? '没有引用的结论' : '补充来源 [S1]')
  }, async () => {
    const result = await searchAgent(
      new ChatService('https://provider.invalid/v1', 'test-key', 'test-model'),
      provider,
      20_000,
    ).complete(REQUEST)
    assert.match(result, /补充来源/u)
    assert.equal(calls, 2)
  })
}

async function testGroundingRepairBudgetGate(): Promise<void> {
  let now = 0
  let calls = 0
  const deadline = new RequestDeadline(MIN_GROUNDING_REPAIR_BUDGET_MS + 1, () => now, 0)
  await withMockFetch(async () => {
    calls += 1
    now = 250
    return completionResponse('没有引用的结论')
  }, async () => {
    const result = await new ChatService('https://provider.invalid/v1', 'test-key', 'test-model').reply(
      [],
      GROUNDING_QUESTION,
      GROUNDING_REQUEST,
      [],
      undefined,
      GROUNDING_QUESTION.messageId,
      deadline,
    )
    assert.equal(result, WEB_SEARCH_GROUNDING_FAILURE_REPLY)
    assert.equal(calls, 1)
    assert.ok(deadline.remainingMs() < MIN_GROUNDING_REPAIR_BUDGET_MS)
  })
}

async function testTavilyTimeoutIsNotExpanded(): Promise<void> {
  let capturedTimeout = 0
  const provider: WebSearchProvider = {
    async search(request) {
      capturedTimeout = request.timeoutMs
      return { results: [SEARCH_RESULT] }
    },
  }
  await withMockFetch(async () => completionResponse('搜索结论 [S1]'), async () => {
    await searchAgent(
      new ChatService('https://provider.invalid/v1', 'test-key', 'test-model'),
      provider,
      20_000,
    ).complete(REQUEST)
  })
  assert.equal(capturedTimeout, 8_000)
}

function testRequestDeadlinePhaseAccounting(): void {
  let oldNow = 0
  const oldChain = new RequestDeadline(120, () => oldNow, 0)
  oldChain.mark('OWNER_DISPATCH_PLANNER')
  oldNow = 35
  oldChain.mark('WEB_SEARCH_PLANNER')
  oldNow = 55
  oldChain.mark('FINAL_ANSWER')
  oldNow = 125
  assert.equal(oldChain.phaseLatencyMs('OWNER_DISPATCH_PLANNER'), 35)
  assert.equal(oldChain.phaseLatencyMs('WEB_SEARCH_PLANNER'), 20)
  assert.equal(oldChain.phaseLatencyMs('FINAL_ANSWER'), 70)
  assert.equal(oldChain.expired(), true)

  let fastNow = 0
  const fastChain = new RequestDeadline(120, () => fastNow, 0)
  fastChain.mark('WEB_SEARCH_PLANNER')
  fastNow = 20
  fastChain.mark('FINAL_ANSWER')
  fastNow = 90
  assert.equal(fastChain.phaseLatencyMs('WEB_SEARCH_PLANNER'), 20)
  assert.equal(fastChain.phaseLatencyMs('FINAL_ANSWER'), 70)
  assert.equal(fastChain.remainingMs(), 30)
  assert.equal(fastChain.expired(), false)
  console.log('REQUEST_DEADLINE_PHASE_ACCOUNTING=PASS')
}

async function testPreProviderDeadlineFailClosed(): Promise<void> {
  let fetchCalls = 0
  const preExpiredAt = Date.now()
  const preExpiredDeadline = new RequestDeadline(25, () => preExpiredAt + 25, preExpiredAt)
  await withMockFetch(async () => {
    fetchCalls += 1
    return completionResponse('不应启动 Provider')
  }, async () => {
    const agent = new ProductionChatAgent(
      new ChatService('https://provider.invalid/v1', 'test-key', 'test-model'),
      {
        requestDeadlineMs: 25,
        requestDeadlineFactory: () => preExpiredDeadline,
      },
    )
    const result = await agent.complete(REQUEST)
    assert.equal(result, `${FALLBACK}${YEYE_REPLY_SIGNATURE}`)
    assert.equal(fetchCalls, 0)
    assert.notEqual(agent.takeOutboundIdentity(REQUEST, result), null)
  })
  console.log('PRE_PROVIDER_DEADLINE_FAIL_CLOSED=PASS')
}

async function testInFlightProviderAbort(): Promise<void> {
  let fetchCalls = 0
  let aborted = false
  let triggerDeadline: (() => void) | undefined
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    triggerDeadline = () => callback()
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as typeof globalThis.setTimeout
  globalThis.clearTimeout = ((_handle: ReturnType<typeof setTimeout>) => {}) as typeof globalThis.clearTimeout

  try {
    const deadline = new RequestDeadline(1_000, () => 0, 0)
    await withMockFetch(async (init) => {
      fetchCalls += 1
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true
          reject(Object.assign(new Error('provider aborted'), { name: 'AbortError' }))
        }, { once: true })
      })
    }, async () => {
      const completion = new ChatService('https://provider.invalid/v1', 'test-key', 'test-model').reply(
        [],
        FINAL_QUESTION,
        FINAL_REQUEST,
        [],
        undefined,
        FINAL_QUESTION.messageId,
        deadline,
      )
      assert.equal(fetchCalls, 1)
      assert.ok(triggerDeadline)
      triggerDeadline?.()
      await assert.rejects(completion, isRequestDeadlineExceeded)
    })
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }

  assert.equal(fetchCalls, 1)
  assert.equal(aborted, true)
  console.log('IN_FLIGHT_PROVIDER_ABORT=PASS')
}

async function run(): Promise<void> {
  await testDirectSufficient()
  await testFinalAnswerRunsWithLowBudget()
  await testProviderControlRepairBudgetGate()
  await testAnswerGuardRegenerationBudgetGate()
  await testSearchAndFinalWithinDeadline()
  await testGroundingRepairAllowed()
  await testGroundingRepairBudgetGate()
  await testTavilyTimeoutIsNotExpanded()
  testRequestDeadlinePhaseAccounting()
  await testPreProviderDeadlineFailClosed()
  await testInFlightProviderAbort()
  console.log('[REQUEST_DEADLINE_CASE] cases=1,2,3,4,5,6,7,8,9,10 result=PASS')
}

await run()
console.log('[REQUEST_DEADLINE_CASE] name=deadline admission and in-flight abort contracts=PASS')
