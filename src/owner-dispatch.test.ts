import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { ChatService } from './chat.js'
import type { AgentRequest } from './agent-adapter.js'
import { sha256Utf8 } from './outbound-delivery.js'
import { GroupAmbientContext } from './group-ambient-context.js'
import { OwnerDispatchPlanner, parseOwnerDispatchProtocol, type OwnerDispatchPlannerLike } from './owner-dispatch-planner.js'
import { ProductionAgentTransportServer } from './production-agent-transport.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import { ProactiveGroupQueue } from './proactive-group-queue.js'

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
    botMentionSpans: { trust: 'VALID', spans: [{ start: 0, length: 5 }] },
    userContentSpan: { trust: 'VALID', span: { start: 0, length: rawText.length } },
    metadata: { rawMessageType: 1 },
    ...overrides,
  }
}

function chat(answer: string, calls: { count: number }): ChatService {
  return {
    reply: async () => {
      calls.count += 1
      return answer
    },
  } as unknown as ChatService
}

function dispatchPlanner(message = '大家今晚十点开会，别迟到哈'): OwnerDispatchPlannerLike {
  return {
    plan: async () => ({
      result: 'PASS' as const,
      decision: { action: 'DISPATCH_NOW' as const, message },
      attempts: 1,
    }),
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
    return plannerCalls === 1 ? 'bad' : 'ACTION=DISPATCH_NOW\nMESSAGE=提醒大家开会'
  })
  const planned = await planner.plan('提醒大家开会', [OWNER, ROOM])
  assert.equal(planned.result, 'PASS')
  assert.equal(planned.attempts, 2)
  assert.equal(planned.decision.message, '提醒大家开会')

  const calls = { count: 0 }
  const ambient = new GroupAmbientContext({ now: () => Date.now() })
  const agent = new ProductionChatAgent(chat('normal answer', calls), {
    ownerDispatchPlanner: dispatchPlanner(),
    ambientContext: ambient,
  })
  assert.equal(await agent.complete(request()), '')
  assert.equal(calls.count, 0)
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
  assert.equal(await memberAgent.complete(request({ requesterRole: 'MEMBER', ownerConfigured: false })), 'member normal')
  assert.equal(memberCalls.count, 1)
  assert.equal(memberPlannerCalls, 0)
  assert.equal(memberAgent.pollProactiveOutbound(), null)

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
  assert.equal(await explicitAgent.complete(request()), '已处理记忆')
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

  console.log('OWNER_DISPATCH_TESTS=PASS cases=20')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
