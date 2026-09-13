import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { ChatService } from './chat.js'
import type { AgentRequest } from './agent-adapter.js'
import { sha256Utf8 } from './outbound-delivery.js'
import { GroupAmbientContext } from './group-ambient-context.js'
import {
  isOwnerDispatchCandidate,
  OwnerDispatchPlanner,
  parseOwnerDispatchProtocol,
  type OwnerDispatchPlannerLike,
} from './owner-dispatch-planner.js'
import { ProductionAgentTransportServer } from './production-agent-transport.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import { ProactiveGroupQueue } from './proactive-group-queue.js'
import { YEYE_REPLY_SIGNATURE } from './chat-renderer.js'

const ROOM = 'owner-dispatch@chatroom'
const OWNER = 'owner-secret'

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  const rawText = '@椰椰\u2005跟大家说一下今晚十点开会，别迟到'
  return {
    conversationKey: `group:${ROOM}`,
    messageId: 'owner-request-1',
    conversationType: 'GROUP',
    conversationId: ROOM,
    senderId: OWNER,
    requesterId: OWNER,
    requesterSource: 'Signature',
    requesterRole: 'OWNER',
    ownerConfigured: true,
    ownerDisplayName: '主人',
    senderName: 'Synthetic Owner',
    text: '跟大家说一下今晚十点开会，别迟到',
    rawText,
    timestamp: 1_757_000_000_000,
    mentionState: 'MENTIONED',
    botMentionSpans: { trust: 'VALID', spans: [{ start: 0, length: 4 }] },
    userContentSpan: { trust: 'VALID', span: { start: 0, length: rawText.length } },
    metadata: { rawMessageType: 1 },
    ...overrides,
  }
}

function ownerRequest(content: string, overrides: Partial<AgentRequest> = {}): AgentRequest {
  const rawText = `@椰椰\u2005${content}`
  return request({
    ...overrides,
    text: content,
    rawText,
    botMentionSpans: { trust: 'VALID', spans: [{ start: 0, length: 4 }] },
    userContentSpan: { trust: 'VALID', span: { start: 0, length: rawText.length } },
  })
}

function chat(answer: string, calls: { count: number }): ChatService {
  return {
    reply: async () => {
      calls.count += 1
      return answer
    },
  } as unknown as ChatService
}

function dispatchPlanner(message = '大家今晚十点开会，别迟到哈', calls?: { count: number }): OwnerDispatchPlannerLike {
  return {
    plan: async () => {
      if (calls !== undefined) calls.count += 1
      return {
        result: 'PASS' as const,
        decision: { action: 'DISPATCH_NOW' as const, message },
        attempts: 1,
      }
    },
  }
}

const ownerPlannerFixtures: readonly [question: string, action: 'CHAT' | 'DISPATCH_NOW'][] = [
  ['你觉得虚拟线程适合我们这种项目吗', 'CHAT'],
  ['你怎么看这个方案', 'CHAT'],
  ['帮我查一下 OpenAI 最近有什么新闻', 'CHAT'],
  ['帮我写一段开会通知', 'CHAT'],
  ['详细讲讲 Java 虚拟线程', 'CHAT'],
  ['帮我跟大家说一下今晚十点开会，别迟到', 'DISPATCH_NOW'],
  ['替我通知大家部署完成了', 'DISPATCH_NOW'],
  ['帮我问一下大家今晚谁有空', 'DISPATCH_NOW'],
]

const ownerDispatchGateFixtures: readonly [question: string, candidate: boolean][] = [
  ['你好', false],
  ['你怎么看这个方案', false],
  ['你觉得虚拟线程怎么样', false],
  ['帮我分析一下这个报错', false],
  ['帮我查一下 OpenAI 最近有什么新闻', false],
  ['搜一下今天有什么有意思的新闻', false],
  ['我想要更亲密的剧情', false],
  ['帮我写一段开会通知', false],
  ['详细讲讲 Java 虚拟线程', false],
  ['大家觉得这个怎么样', false],
  ['这个群最近挺热闹', false],
  ['帮我跟大家说一下今晚十点开会，别迟到', true],
  ['替我通知大家部署完成了', true],
  ['替我通知群里明天不用来公司', true],
  ['帮我问一下大家今晚谁有空', true],
  ['跟大家说部署已经完成了', true],
  ['写一段通知并发给大家', true],
]

function assertOwnerDispatchGateFixtures(): void {
  for (const [question, candidate] of ownerDispatchGateFixtures) {
    assert.equal(isOwnerDispatchCandidate(question), candidate, question)
  }
}

async function assertOwnerPlannerFixtures(): Promise<void> {
  const expected = new Map(ownerPlannerFixtures)
  const planner = new OwnerDispatchPlanner(async (systemPrompt, userPrompt) => {
    const question = userPrompt.replace('[Canonical Owner Request]\n', '')
    const action = expected.get(question)
    assert(action)

    // This fixture models a provider following the published Planner contract.
    // Without the explicit delegation examples, the old prompt reproduces the
    // observed false positive for ordinary Owner questions.
    const hasDelegationExamples = [
      '你觉得虚拟线程适合我们这种项目吗',
      '你怎么看这个方案',
      '帮我查一下 OpenAI 最近有什么新闻',
      '帮我分析一下这个报错',
      '帮我写一段开会通知',
      '这个方案有什么问题',
      '现在几点',
      '详细讲讲 Java 虚拟线程',
      '帮我跟大家说一下今晚十点开会，别迟到',
      '替我通知群里明天不用来公司',
      '帮我问一下大家今晚谁有空',
      '跟大家说部署已经完成了',
      '写一段通知并发给大家',
      '帮我问大家觉得',
    ].every((example) => systemPrompt.includes(example))

    if (action === 'CHAT' && !hasDelegationExamples) {
      return 'ACTION=DISPATCH_NOW\nMESSAGE=大家觉得这个问题怎么样？'
    }
    return action === 'CHAT'
      ? 'ACTION=CHAT\nMESSAGE='
      : 'ACTION=DISPATCH_NOW\nMESSAGE=大家今晚十点开会，别迟到'
  })

  for (const [question, action] of ownerPlannerFixtures) {
    const result = await planner.plan(question, [OWNER, ROOM])
    assert.equal(result.result, 'PASS', question)
    assert.equal(result.decision.action, action, question)
  }
}

async function readLine(socket: ReturnType<typeof createConnection>, state: { buffer: string }): Promise<Record<string, unknown>> {
  while (!state.buffer.includes('\n')) {
    const chunk = await new Promise<string>((resolve, reject) => {
      const onData = (value: Buffer | string): void => {
        socket.off('error', onError)
        resolve(value.toString())
      }
      const onError = (error: Error): void => {
        socket.off('data', onData)
        reject(error)
      }
      socket.once('data', onData)
      socket.once('error', onError)
    })
    state.buffer += chunk
  }
  const end = state.buffer.indexOf('\n')
  const line = state.buffer.slice(0, end)
  state.buffer = state.buffer.slice(end + 1)
  return JSON.parse(line) as Record<string, unknown>
}

async function main(): Promise<void> {
  await assertOwnerPlannerFixtures()
  assertOwnerDispatchGateFixtures()

  assert.deepEqual(parseOwnerDispatchProtocol('ACTION=CHAT\nMESSAGE='), {
    valid: true,
    decision: { action: 'CHAT', message: null },
  })
  assert.equal(parseOwnerDispatchProtocol('ACTION=DISPATCH_NOW\nMESSAGE=hello').valid, true)
  assert.equal(parseOwnerDispatchProtocol('ACTION=DISPATCH_NOW\nMESSAGE=<think>x</think>hello').valid, false)
  assert.equal(parseOwnerDispatchProtocol(`ACTION=DISPATCH_NOW\nMESSAGE=${OWNER}`, [OWNER]).valid, false)
  assert.equal(parseOwnerDispatchProtocol(`ACTION=DISPATCH_NOW\nMESSAGE=${'x'.repeat(501)}`).valid, false)

  let plannerCalls = 0
  const planner = new OwnerDispatchPlanner(async () => {
    plannerCalls += 1
    return 'bad'
  })
  const planned = await planner.plan('提醒大家开会', [OWNER, ROOM])
  assert.equal(planned.result, 'FAIL')
  assert.equal(planned.attempts, 1)
  assert.equal(plannerCalls, 1)

  const validPlanner = new OwnerDispatchPlanner(async () => 'ACTION=DISPATCH_NOW\nMESSAGE=提醒大家开会')
  const validPlan = await validPlanner.plan('提醒大家开会', [OWNER, ROOM])
  assert.equal(validPlan.result, 'PASS')
  assert.equal(validPlan.attempts, 1)
  assert.equal(validPlan.decision.message, '提醒大家开会')

  const calls = { count: 0 }
  const ambient = new GroupAmbientContext({ now: () => Date.now() })
  const dispatchPlannerCalls = { count: 0 }
  const agent = new ProductionChatAgent(chat('normal answer', calls), {
    ownerDispatchPlanner: dispatchPlanner(undefined, dispatchPlannerCalls),
    ambientContext: ambient,
  })
  assert.equal(await agent.complete(ownerRequest('帮我跟大家说一下今晚十点开会，别迟到')), '')
  assert.equal(calls.count, 0)
  assert.equal(dispatchPlannerCalls.count, 1)
  const command = agent.pollProactiveOutbound()
  assert(command)
  assert.equal(command.conversationType, 'GROUP')
  assert.equal(command.conversationId, ROOM)
  assert.equal(command.requestMessageId.startsWith('proactive:'), true)
  assert.equal(command.contentSha256, sha256Utf8(command.text))
  assert.equal(agent.pollProactiveOutbound(), null)
  assert.equal((agent.observeOutboundDelivery({
    outboundId: command.outboundId,
    requestMessageId: command.requestMessageId,
    status: 'SENT',
    contentSha256: command.contentSha256,
    errorCode: '',
  })).reason, 'SENT_COMMITTED')
  assert.equal(ambient.entries(ROOM).filter((line) => line.speakerType === 'ASSISTANT').length, 1)
  assert.equal(agent.observeOutboundDelivery({
    outboundId: command.outboundId,
    requestMessageId: command.requestMessageId,
    status: 'SENT',
    contentSha256: command.contentSha256,
    errorCode: '',
  }).reason, 'DUPLICATE_ACK')

  const failedAmbient = new GroupAmbientContext({ now: () => Date.now() })
  const failedAgent = new ProductionChatAgent(chat('unused', { count: 0 }), {
    ownerDispatchPlanner: dispatchPlanner('失败也不应进 ambient'),
    ambientContext: failedAmbient,
  })
  await failedAgent.complete(request({ messageId: 'owner-failed' }))
  const failed = failedAgent.pollProactiveOutbound()
  assert(failed)
  assert.equal(failedAgent.observeOutboundDelivery({
    outboundId: failed.outboundId,
    requestMessageId: failed.requestMessageId,
    status: 'FAILED',
    contentSha256: failed.contentSha256,
    errorCode: 'NATIVE_ERROR',
  }).reason, 'FAILED_DISCARDED')
  assert.equal(failedAmbient.entries(ROOM).some((line) => line.speakerType === 'ASSISTANT'), false)

  const memberCalls = { count: 0 }
  let memberPlannerCalls = 0
  const memberAgent = new ProductionChatAgent(chat('member normal', memberCalls), {
    ownerDispatchPlanner: { plan: async () => { memberPlannerCalls += 1; return (await dispatchPlanner()).plan('x') } },
  })
  assert.equal(await memberAgent.complete(request({ requesterRole: 'MEMBER', ownerConfigured: false })), `member normal${YEYE_REPLY_SIGNATURE}`)
  assert.equal(memberCalls.count, 1)
  assert.equal(memberPlannerCalls, 0)
  assert.equal(memberAgent.pollProactiveOutbound(), null)

  const normalOwnerCalls = { count: 0 }
  const normalOwnerPlannerCalls = { count: 0 }
  const normalOwnerAgent = new ProductionChatAgent(chat('owner normal', normalOwnerCalls), {
    ownerDispatchPlanner: {
      plan: async () => {
        normalOwnerPlannerCalls.count += 1
        return {
        result: 'PASS' as const,
        decision: { action: 'CHAT' as const, message: null },
        attempts: 1,
        }
      },
    },
  })
  assert.equal(await normalOwnerAgent.complete(ownerRequest('你好', { messageId: 'owner-normal' })), `owner normal${YEYE_REPLY_SIGNATURE}`)
  assert.equal(normalOwnerCalls.count, 1)
  assert.equal(normalOwnerPlannerCalls.count, 0)
  assert.equal(normalOwnerAgent.pollProactiveOutbound(), null)

  let ordinarySearchOwnerPlannerCalls = 0
  let webSearchPlannerCalls = 0
  let webSearchProviderCalls = 0
  const ordinarySearchAgent = new ProductionChatAgent(chat('search answer', { count: 0 }), {
    ownerDispatchPlanner: {
      plan: async () => {
        ordinarySearchOwnerPlannerCalls += 1
        return dispatchPlanner().plan('unexpected')
      },
    },
    webSearchPlanner: {
      plan: async () => {
        webSearchPlannerCalls += 1
        return {
          result: 'PASS' as const,
          decision: {
            action: 'SEARCH' as const,
            query: '今天新闻',
            alternateQuery: null,
            reasonCode: 'EXPLICIT_SEARCH_REQUEST' as const,
            mode: 'GENERAL' as const,
            recencyWindow: 'NONE' as const,
          },
          attempts: 1,
        }
      },
    },
    webSearchProvider: {
      search: async () => {
        webSearchProviderCalls += 1
        return { results: [{ sourceId: 'S1', title: '新闻', url: 'https://example.com/news', snippet: '公开新闻' }] }
      },
    },
  })
  assert.equal(await ordinarySearchAgent.complete(ownerRequest('搜一下今天有什么新闻', { messageId: 'owner-search' })), `search answer${YEYE_REPLY_SIGNATURE}`)
  assert.equal(ordinarySearchOwnerPlannerCalls, 0)
  assert.equal(webSearchPlannerCalls, 1)
  assert.equal(webSearchProviderCalls, 1)
  assert.equal(ordinarySearchAgent.pollProactiveOutbound(), null)

  const plannerChatCalls = { count: 0 }
  const plannerChatAgent = new ProductionChatAgent(chat('planner chat', { count: 0 }), {
    ownerDispatchPlanner: {
      plan: async () => {
        plannerChatCalls.count += 1
        return {
          result: 'PASS' as const,
          decision: { action: 'CHAT' as const, message: null },
          attempts: 1,
        }
      },
    },
  })
  assert.equal(await plannerChatAgent.complete(ownerRequest('跟大家说部署已经完成了', { messageId: 'owner-planner-chat' })), `planner chat${YEYE_REPLY_SIGNATURE}`)
  assert.equal(plannerChatCalls.count, 1)
  assert.equal(plannerChatAgent.pollProactiveOutbound(), null)

  let invalidProtocolCalls = 0
  const invalidProtocolAgent = new ProductionChatAgent(chat('invalid protocol fallback', { count: 0 }), {
    ownerDispatchPlanner: new OwnerDispatchPlanner(async () => {
      invalidProtocolCalls += 1
      return 'bad'
    }),
  })
  assert.equal(await invalidProtocolAgent.complete(ownerRequest('帮我问一下大家今晚谁有空', { messageId: 'owner-invalid-protocol' })), `invalid protocol fallback${YEYE_REPLY_SIGNATURE}`)
  assert.equal(invalidProtocolCalls, 1)
  assert.equal(invalidProtocolAgent.pollProactiveOutbound(), null)

  let providerExceptionCalls = 0
  const providerExceptionAgent = new ProductionChatAgent(chat('provider exception fallback', { count: 0 }), {
    ownerDispatchPlanner: new OwnerDispatchPlanner(async () => {
      providerExceptionCalls += 1
      throw new Error('provider unavailable')
    }),
  })
  assert.equal(await providerExceptionAgent.complete(ownerRequest('替我通知大家部署完成了', { messageId: 'owner-provider-exception' })), `provider exception fallback${YEYE_REPLY_SIGNATURE}`)
  assert.equal(providerExceptionCalls, 1)
  assert.equal(providerExceptionAgent.pollProactiveOutbound(), null)

  const invalidAgent = new ProductionChatAgent(chat('invalid normal', { count: 0 }), {
    ownerDispatchPlanner: dispatchPlanner(),
  })
  await invalidAgent.complete(request({ botMentionSpans: { trust: 'INVALID', spans: [{ start: 0, length: 5 }] } }))
  assert.equal(invalidAgent.pollProactiveOutbound(), null)

  let explicitPlannerCalls = 0
  const explicitAgent = new ProductionChatAgent(chat('must not run', { count: 0 }), {
    ownerDispatchPlanner: { plan: async () => { explicitPlannerCalls += 1; return (await dispatchPlanner()).plan('x') } },
    memory: { tryHandleExplicit: async () => ({ handled: true, reply: '已处理记忆' }) } as never,
  })
  assert.equal(await explicitAgent.complete(request()), `已处理记忆${YEYE_REPLY_SIGNATURE}`)
  assert.equal(explicitPlannerCalls, 0)
  assert.equal(explicitAgent.pollProactiveOutbound(), null)

  let now = 1_000
  const queue = new ProactiveGroupQueue({ maxEntries: 2, ttlMs: 10, now: () => now, idFactory: (() => { let n = 0; return () => `task-${++n}` })() })
  assert.equal(queue.enqueue({ conversationType: 'GROUP', conversationId: ROOM, text: 'one' }).accepted, true)
  assert.equal(queue.enqueue({ conversationType: 'GROUP', conversationId: ROOM, text: 'two' }).accepted, true)
  assert.equal(queue.enqueue({ conversationType: 'GROUP', conversationId: ROOM, text: 'three' }).accepted, false)
  const first = queue.claimReady()
  assert(first)
  assert.equal(queue.claimReady()?.text, 'two')
  assert.equal(queue.claimReady(), null)
  assert.equal(queue.finalize(first.taskId), true)
  const expiredQueue = new ProactiveGroupQueue({ ttlMs: 10, now: () => now })
  expiredQueue.enqueue({ conversationType: 'GROUP', conversationId: ROOM, text: 'expire' })
  now += 11
  assert.equal(expiredQueue.claimReady(), null)

  const transportAmbient = new GroupAmbientContext({ now: () => Date.now() })
  const transportAgent = new ProductionChatAgent(chat('unused', { count: 0 }), {
    ownerDispatchPlanner: dispatchPlanner('transport proactive'),
    ambientContext: transportAmbient,
  })
  await transportAgent.complete(request({ messageId: 'transport-request' }))
  const transport = new ProductionAgentTransportServer({
    pipeName: `owner-dispatch-${process.pid}-${Date.now()}`,
    agent: transportAgent,
  })
  await transport.start()
  const socket = createConnection(transport.endpoint)
  const state = { buffer: '' }
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    socket.write('{"kind":"PROACTIVE_OUTBOUND_POLL","pollId":"poll-1"}\n')
    const response = await readLine(socket, state)
    assert.equal(response.kind, 'PROACTIVE_OUTBOUND_COMMAND')
    socket.write('{"kind":"PROACTIVE_OUTBOUND_POLL","pollId":"poll-2"}\n')
    assert.equal((await readLine(socket, state)).kind, 'NO_PROACTIVE_OUTBOUND')
  } finally {
    socket.destroy()
    await transport.stop()
  }

  console.log('OWNER_DISPATCH_TESTS=PASS cases=29')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
