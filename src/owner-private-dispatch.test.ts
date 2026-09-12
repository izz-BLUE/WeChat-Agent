import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import {
  applyMentionPolicy,
  runRawAgentPipeline,
  toOutboundCommand,
  type AgentRequest,
} from './agent-adapter.js'
import { ChatService } from './chat.js'
import { GroupAmbientContext } from './group-ambient-context.js'
import {
  DIRECT_OWNER_FIELD_VERIFIED,
  type RawHookMessage,
} from './message-contract.js'
import {
  OwnerPrivateDispatchPlanner,
  parseOwnerPrivateDispatchProtocol,
  type OwnerPrivateDispatchPlannerLike,
} from './owner-private-dispatch-planner.js'
import type { OwnerDispatchPlannerLike } from './owner-dispatch-planner.js'
import { ProductionAgentTransportServer } from './production-agent-transport.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import { sha256Utf8 } from './outbound-delivery.js'

const OWNER = 'owner-private'
const PEER = 'private-peer'
const ROOM_A = 'private-room-a@chatroom'
const ROOM_B = 'private-room-b@chatroom'

function directRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    conversationKey: `direct:${PEER}`,
    messageId: 'private-request-1',
    conversationType: 'DIRECT',
    conversationId: PEER,
    senderId: OWNER,
    requesterId: OWNER,
    requesterSource: DIRECT_OWNER_FIELD_VERIFIED,
    requesterRole: 'OWNER',
    ownerConfigured: true,
    ownerDisplayName: '主人',
    senderName: 'Synthetic Owner',
    text: '帮我跟群里说一下今晚十点开会，别迟到',
    rawText: '帮我跟群里说一下今晚十点开会，别迟到',
    timestamp: 1_757_000_000_000,
    mentionState: 'UNKNOWN',
    metadata: { rawMessageType: 1 },
    ...overrides,
  }
}

function groupRequest(room: string, messageId: string): AgentRequest {
  const rawText = '@椰椰\u2005帮我通知大家开会'
  return {
    conversationKey: `group:${room}`,
    messageId,
    conversationType: 'GROUP',
    conversationId: room,
    senderId: OWNER,
    requesterId: OWNER,
    requesterSource: 'Signature',
    requesterRole: 'OWNER',
    ownerConfigured: true,
    ownerDisplayName: '主人',
    senderName: 'Synthetic Owner',
    text: '帮我通知大家开会',
    rawText,
    timestamp: 1_757_000_000_000,
    mentionState: 'MENTIONED',
    botMentionSpans: { trust: 'VALID', spans: [{ start: 0, length: 4 }] },
    userContentSpan: { trust: 'VALID', span: { start: 0, length: rawText.length } },
    metadata: { rawMessageType: 1 },
  }
}

function rawDirect(overrides: Partial<RawHookMessage> = {}): RawHookMessage {
  return {
    msgId: 'raw-private-1',
    type: 1,
    timestamp: 1_757_000_000_000,
    from: OWNER,
    wxid: PEER,
    content: '帮我跟群里说一下今晚十点开会，别迟到',
    signature: OWNER,
    conversationType: 'DIRECT',
    conversationId: PEER,
    senderId: OWNER,
    requesterId: OWNER,
    requesterSource: DIRECT_OWNER_FIELD_VERIFIED,
    requesterRole: 'OWNER',
    ownerConfigured: true,
    ownerDisplayName: '主人',
    isMentioned: null,
    ...overrides,
  }
}

function chat(calls: { count: number }): ChatService {
  return {
    reply: async () => {
      calls.count += 1
      return 'normal chat must not run'
    },
  } as unknown as ChatService
}

function privatePlanner(action: 'NOOP' | 'DISPATCH', message: string | null = null, calls?: { count: number }): OwnerPrivateDispatchPlannerLike {
  return {
    plan: async () => {
      if (calls) calls.count += 1
      return { result: 'PASS', decision: { action, message }, attempts: 1 }
    },
  }
}

function groupPlanner(message = '大家今晚十点开会，别迟到'): OwnerDispatchPlannerLike {
  return {
    plan: async () => ({
      result: 'PASS',
      decision: { action: 'DISPATCH_NOW', message },
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
  const normalized = await runRawAgentPipeline(rawDirect(), { complete: async () => '' })
  assert.equal(normalized.status, 'AGENT_RESULT')
  assert.equal(normalized.policy.status, 'PROCESS_PRIVATE_OWNER')
  assert.equal(normalized.request.requesterSource, DIRECT_OWNER_FIELD_VERIFIED)
  assert.equal(normalized.request.requesterRole, 'OWNER')
  assert.equal(toOutboundCommand(normalized.normalization.message, { kind: 'SUCCESS_TEXT', text: 'must not send direct' }), null)

  const generic = await runRawAgentPipeline(rawDirect({ requesterId: OWNER, requesterSource: 'DIRECT_IDENTITY_UNVERIFIED', requesterRole: 'OWNER' }), { complete: async () => { throw new Error('must not invoke') } })
  assert.deepEqual(generic.status === 'IGNORED' ? generic.policy : null, {
    status: 'IGNORED',
    reason: 'DIRECT_IDENTITY_UNVERIFIED',
  })

  assert.deepEqual(parseOwnerPrivateDispatchProtocol('ACTION=NOOP\nMESSAGE='), {
    valid: true,
    decision: { action: 'NOOP', message: null },
  })
  assert.equal(parseOwnerPrivateDispatchProtocol('ACTION=DISPATCH\nMESSAGE=提醒群里开会').valid, true)
  assert.equal(parseOwnerPrivateDispatchProtocol('ACTION=DISPATCH\nMESSAGE=<think>x</think>开会').valid, false)
  assert.equal(parseOwnerPrivateDispatchProtocol(`ACTION=DISPATCH\nMESSAGE=${OWNER}`, [OWNER, PEER]).valid, false)
  assert.equal(parseOwnerPrivateDispatchProtocol(`ACTION=DISPATCH\nMESSAGE=${'x'.repeat(501)}`).valid, false)

  let plannerCalls = 0
  const repairPlanner = new OwnerPrivateDispatchPlanner(async () => {
    plannerCalls += 1
    return plannerCalls === 1 ? 'bad' : 'ACTION=DISPATCH\nMESSAGE=提醒群里开会'
  })
  const repaired = await repairPlanner.plan('提醒群里开会', [OWNER, PEER])
  assert.equal(repaired.result, 'PASS')
  assert.equal(repaired.attempts, 2)

  const unboundCalls = { count: 0 }
  let unboundPlannerCalls = 0
  const unboundAgent = new ProductionChatAgent(chat(unboundCalls), {
    ownerPrivateDispatchPlanner: { plan: async () => { unboundPlannerCalls += 1; return privatePlanner('DISPATCH', '不可达').plan('x') } },
  })
  assert.equal(await unboundAgent.complete(directRequest()), '')
  assert.equal(unboundCalls.count, 0)
  assert.equal(unboundPlannerCalls, 0)
  assert.equal(unboundAgent.pollProactiveOutbound(), null)

  const noopCalls = { count: 0 }
  const noopPlannerCalls = { count: 0 }
  const noopAgent = new ProductionChatAgent(chat(noopCalls), {
    ownerPrivateDispatchPlanner: privatePlanner('NOOP', null, noopPlannerCalls),
  })
  assert.equal(await noopAgent.complete(directRequest({ privateDispatchTargetConversationId: ROOM_A })), '')
  assert.equal(noopCalls.count, 0)
  assert.equal(noopPlannerCalls.count, 1)
  assert.equal(noopAgent.pollProactiveOutbound(), null)

  const dispatchCalls = { count: 0 }
  const dispatchPlannerCalls = { count: 0 }
  const dispatchAmbient = new GroupAmbientContext({ now: () => Date.now() })
  const dispatchAgent = new ProductionChatAgent(chat(dispatchCalls), {
    ownerPrivateDispatchPlanner: privatePlanner('DISPATCH', '大家今晚十点开会，别迟到', dispatchPlannerCalls),
    ambientContext: dispatchAmbient,
  })
  assert.equal(await dispatchAgent.complete(directRequest({
    messageId: 'dispatch-1',
    privateDispatchTargetConversationId: ROOM_A,
  })), '')
  assert.equal(dispatchCalls.count, 0)
  assert.equal(dispatchPlannerCalls.count, 1)
  const command = dispatchAgent.pollProactiveOutbound()
  assert(command)
  assert.equal(command.conversationType, 'GROUP')
  assert.equal(command.conversationId, ROOM_A)
  assert.equal(command.contentSha256, sha256Utf8(command.text))
  assert.equal(dispatchAgent.pollProactiveOutbound(), null)
  assert.equal(dispatchAgent.observeOutboundDelivery({
    outboundId: command.outboundId,
    requestMessageId: command.requestMessageId,
    status: 'SENT',
    contentSha256: command.contentSha256,
    errorCode: '',
  }).reason, 'SENT_COMMITTED')
  assert.equal(dispatchAmbient.entries(ROOM_A).filter((line) => line.speakerType === 'ASSISTANT').length, 1)

  const failedAmbient = new GroupAmbientContext({ now: () => Date.now() })
  const failedAgent = new ProductionChatAgent(chat({ count: 0 }), {
    ownerPrivateDispatchPlanner: privatePlanner('DISPATCH', '失败不应进群'),
    ambientContext: failedAmbient,
  })
  await failedAgent.complete(directRequest({
    messageId: 'dispatch-failed',
    privateDispatchTargetConversationId: ROOM_A,
  }))
  const failedCommand = failedAgent.pollProactiveOutbound()
  assert(failedCommand)
  assert.equal(failedAgent.observeOutboundDelivery({
    outboundId: failedCommand.outboundId,
    requestMessageId: failedCommand.requestMessageId,
    status: 'FAILED',
    contentSha256: failedCommand.contentSha256,
    errorCode: 'NATIVE_ERROR',
  }).reason, 'FAILED_DISCARDED')
  assert.equal(failedAmbient.entries(ROOM_A).some((line) => line.speakerType === 'ASSISTANT'), false)

  const groupAgent = new ProductionChatAgent(chat({ count: 0 }), {
    ownerDispatchPlanner: groupPlanner(),
  })
  await groupAgent.complete(groupRequest(ROOM_A, 'group-bind'))
  await groupAgent.complete(groupRequest(ROOM_B, 'group-rebind'))
  const groupCommandA = groupAgent.pollProactiveOutbound()
  const groupCommandB = groupAgent.pollProactiveOutbound()
  assert(groupCommandA)
  assert(groupCommandB)
  assert.equal(groupCommandA.conversationId, ROOM_A)
  assert.equal(groupCommandB.conversationId, ROOM_B)
  assert.equal(groupAgent.pollProactiveOutbound(), null)

  const captured: { question: string; forbidden: readonly string[] } = { question: '', forbidden: [] }
  const captureAgent = new ProductionChatAgent(chat({ count: 0 }), {
    ownerPrivateDispatchPlanner: {
      plan: async (question, forbiddenValues = []) => {
        captured.question = question
        captured.forbidden = forbiddenValues
        return { result: 'PASS', decision: { action: 'NOOP', message: null }, attempts: 1 }
      },
    },
  })
  await captureAgent.complete(directRequest({
    text: '问一下最近怎么样',
    rawText: '问一下最近怎么样',
    privateDispatchTargetConversationId: ROOM_A,
  }))
  assert.equal(captured.question, '问一下最近怎么样')
  assert.equal(captured.forbidden.includes(ROOM_A), true)
  assert.equal(captured.forbidden.includes(OWNER), true)
  assert.equal(captured.forbidden.includes(PEER), true)

  let plannerSystem = ''
  let plannerUser = ''
  const promptAgent = new ProductionChatAgent(chat({ count: 0 }), {
    ownerPrivateDispatchPlanner: new OwnerPrivateDispatchPlanner(async (system, user) => {
      plannerSystem = system
      plannerUser = user
      return 'ACTION=NOOP\nMESSAGE='
    }),
  })
  await promptAgent.complete(directRequest({
    messageId: 'prompt-privacy',
    privateDispatchTargetConversationId: ROOM_A,
  }))
  assert.equal(plannerSystem.includes(ROOM_A), false)
  assert.equal(plannerUser.includes(ROOM_A), false)

  let invalidTargetPlannerCalls = 0
  const invalidTargetAgent = new ProductionChatAgent(chat({ count: 0 }), {
    ownerPrivateDispatchPlanner: privatePlanner('DISPATCH', 'invalid target', {
      get count() { return invalidTargetPlannerCalls },
      set count(value: number) { invalidTargetPlannerCalls = value },
    }),
  })
  await invalidTargetAgent.complete(directRequest({
    messageId: 'invalid-target',
    privateDispatchTargetConversationId: 'not-a-group',
  }))
  assert.equal(invalidTargetPlannerCalls, 0)

  let groupPrivatePlannerCalls = 0
  const forgedGroupRequest = {
    ...groupRequest(ROOM_A, 'group-forged-target'),
    privateDispatchTargetConversationId: ROOM_B,
  }
  const forgedGroupAgent = new ProductionChatAgent(chat({ count: 0 }), {
    ownerPrivateDispatchPlanner: {
      plan: async () => {
        groupPrivatePlannerCalls += 1
        return { result: 'PASS' as const, decision: { action: 'NOOP' as const, message: null }, attempts: 1 }
      },
    },
  })
  await forgedGroupAgent.complete(forgedGroupRequest)
  assert.equal(groupPrivatePlannerCalls, 0)
  assert.equal(forgedGroupAgent.pollProactiveOutbound(), null)

  const transportAgent = new ProductionChatAgent(chat({ count: 0 }), {
    ownerPrivateDispatchPlanner: privatePlanner('DISPATCH', 'transport private dispatch'),
  })
  const transport = new ProductionAgentTransportServer({
    pipeName: `owner-private-${process.pid}-${Date.now()}`,
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
    socket.write(`${JSON.stringify({
      kind: 'INBOUND_MESSAGE',
      message: rawDirect({
        msgId: 'transport-private',
        privateDispatchTargetConversationId: ROOM_A,
      }),
    })}\n`)
    assert.equal((await readLine(socket, state)).kind, 'NO_REPLY')
    socket.write('{"kind":"PROACTIVE_OUTBOUND_POLL","pollId":"poll-1"}\n')
    const proactive = await readLine(socket, state)
    assert.equal(proactive.kind, 'PROACTIVE_OUTBOUND_COMMAND')
    assert.equal(proactive.conversationType, 'GROUP')
    assert.equal(proactive.conversationId, ROOM_A)
    socket.write('{"kind":"PROACTIVE_OUTBOUND_POLL","pollId":"poll-2"}\n')
    assert.equal((await readLine(socket, state)).kind, 'NO_PROACTIVE_OUTBOUND')
  } finally {
    socket.destroy()
    await transport.stop()
  }

  console.log('OWNER_PRIVATE_DISPATCH_TESTS=PASS cases=18')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
