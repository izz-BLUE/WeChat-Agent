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
import { RequestDeadline } from './request-deadline.js'
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
  const provider: WebSearchProvider = {
    async search() {
      return { results: [SEARCH_RESULT] }
    },
  }
  await withMockFetch(async () => {
    calls += 1
    return completionResponse('搜索结论 [S1]')
  }, async () => {
    const result = await searchAgent(
      new ChatService('https://provider.invalid/v1', 'test-key', 'test-model'),
      provider,
      20_000,
    ).complete(REQUEST)
    assert.match(result, /搜索结论/u)
    assert.equal(calls, 1)
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

function testOwnerFastPathDeadlineRegression(): void {
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
  console.log('OWNER_FAST_PATH_DEADLINE_REGRESSION=PASS')
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  let aborted = false

  globalThis.fetch = async (_input, init) => {
    fetchCalls += 1
    const signal = init?.signal
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        aborted = true
        reject(Object.assign(new Error('provider aborted'), { name: 'AbortError' }))
      }, { once: true })
    })
  }

  try {
    const agent = new ProductionChatAgent(
      new ChatService('https://provider.invalid/v1', 'test-key', 'test-model'),
      { requestDeadlineMs: 25 },
    )
    const result = await Promise.race([
      agent.complete(REQUEST),
      new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error('request deadline regression: complete hung')), 200)
      }),
    ])

    assert.equal(result, `${FALLBACK}${YEYE_REPLY_SIGNATURE}`)
    assert.equal(fetchCalls, 1)
    assert.equal(aborted, true)
    assert.notEqual(agent.takeOutboundIdentity(REQUEST, result), null)
  } finally {
    globalThis.fetch = originalFetch
  }

  await testDirectSufficient()
  await testFinalAnswerRunsWithLowBudget()
  await testProviderControlRepairBudgetGate()
  await testAnswerGuardRegenerationBudgetGate()
  await testSearchAndFinalWithinDeadline()
  await testGroundingRepairAllowed()
  await testGroundingRepairBudgetGate()
  await testTavilyTimeoutIsNotExpanded()
  testOwnerFastPathDeadlineRegression()
  console.log('[REQUEST_DEADLINE_CASE] cases=1,2,3,4,5,6,7,8 result=PASS')
}

await run()
console.log('[REQUEST_DEADLINE_CASE] name=provider timeout returns one staged deterministic fallback result=PASS')
