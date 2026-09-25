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
import { OWNER_COMMANDED_DISPATCH } from './proactive-group-queue.js'
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

  const rewriteFixtures = [
    {
      input: '帮我跟大家说一下今晚十点开会，别迟到',
      message: '大家今晚十点开会，别迟到。',
    },
    {
      input: '你帮我问一下大家今晚谁有空，晚点一起看看那个问题',
      message: '大家今晚谁有空？晚点一起看看那个问题。',
    },
    {
      input: '跟大家说部署好了，辛苦大家',
      message: '部署已经好了，大家辛苦了。',
    },
    {
      input: '帮我跟大家说一下，今晚部署应该差不多了，让他们有问题直接群里说',
      message: '今晚部署应该差不多了，大家有问题直接在群里说就行。',
    },
  ] as const
  const commandShells = ['帮我跟大家说', '你跟群里说一下', '替我通知一下', '帮我问问大家', '跟大家说']
  let rewritePlannerCalls = 0
  let rewritePlannerSystem = ''
  for (const fixture of rewriteFixtures) {
    const planner = new OwnerPrivateDispatchPlanner(async (system, user) => {
      rewritePlannerCalls += 1
      rewritePlannerSystem = system
      assert.equal(user, `[Canonical Private Owner Request]\n${fixture.input}`)
      return `ACTION=DISPATCH\nMESSAGE=${fixture.message}`
    })
    const planned = await planner.plan(fixture.input)
    assert.equal(planned.result, 'PASS')
    assert.deepEqual(planned.decision, { action: 'DISPATCH', message: fixture.message })
    assert.equal(planned.attempts, 1)
    for (const shell of commandShells) {
      assert.equal(fixture.message.includes(shell), false, `final group message kept command shell: ${shell}`)
    }
  }
  assert.equal(rewritePlannerCalls, rewriteFixtures.length)
  for (const rule of [
    'DISPATCH 的 MESSAGE 不是对 OWNER 原话的机械转述，而是一条可以直接发到群里的自然成品消息',
    '去掉私聊指令壳',
    '群体询问要自然化为直接问群成员的问题',
    '不得新增原文没有的时间、地点、人名、数字、原因、事实、结论、承诺或情绪评价',
    '不确定性和请求语气必须保留',
    '原文“今晚开会”不得变成“今晚十点开会”',
    '原文“部署好了”不得变成“生产环境已经全部部署完成”',
    '原文“让大家注意一下”不得自行猜测注意服务器、代码、上线、数据库',
    '当前 private path 不提供安全的群聊历史或 deterministic style profile',
  ]) {
    assert.equal(rewritePlannerSystem.includes(rule), true, `planner prompt lost rewrite rule: ${rule}`)
  }

  const noNewFactFixtures = [
    { input: '今晚开会', message: '大家今晚开会。', added: '十点' },
    { input: '办公室开会', message: '大家在办公室开会。', added: '会议室' },
    { input: '两个人参加', message: '两个人参加。', added: '三个人' },
    { input: '小王负责', message: '小王负责。', added: '小李' },
    { input: '因为下雨取消', message: '因为下雨取消。', added: '临时安排' },
  ] as const
  for (const fixture of noNewFactFixtures) {
    assert.equal(fixture.message.includes(fixture.added), false)
    assert.equal(parseOwnerPrivateDispatchProtocol(`ACTION=DISPATCH\nMESSAGE=${fixture.message}`).valid, true)
  }

  for (const input of ['你觉得虚拟线程怎么样', '帮我分析这个问题', '帮我写一段通知', '帮我查新闻']) {
    const planner = new OwnerPrivateDispatchPlanner(async () => 'ACTION=NOOP\nMESSAGE=')
    const planned = await planner.plan(input)
    assert.equal(planned.result, 'PASS')
    assert.deepEqual(planned.decision, { action: 'NOOP', message: null })
  }

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
  assert.equal(command.outboundIntent, OWNER_COMMANDED_DISPATCH)
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
