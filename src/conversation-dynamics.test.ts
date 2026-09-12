import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildSystemPrompt,
  buildUserPrompt,
  ChatService,
  type ChatRequestContext,
} from './chat.js'
import type { GroupMessage } from './context.js'
import {
  deriveGroupReplyPressure,
  formatConversationDynamicsProfile,
  observeConversationDynamics,
  type ConversationDynamicsProfile,
} from './conversation-dynamics.js'
import { type AmbientLine } from './group-ambient-context.js'
import type { AgentExecutor, AgentRequest } from './agent-adapter.js'
import { runRawAgentPipeline } from './agent-adapter.js'
import { PersistentRuntimeLog } from './persistent-runtime-log.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import type { RawHookMessage } from './message-contract.js'

let cases = 0
let failures = 0

function active(senderName: string, messageId?: string, text = 'active history'): GroupMessage {
  return {
    senderId: 'internal-only',
    senderName,
    text,
    timestamp: 1,
    ...(messageId === undefined ? {} : { messageId }),
  }
}

function ambient(label: string, messageId?: string, text = 'ambient history'): AmbientLine {
  return {
    label,
    text,
    ...(label === 'ASSISTANT' ? { replyTarget: 'CURRENT_REQUESTER' as const } : {}),
    ...(messageId === undefined ? {} : { messageId }),
  }
}

function observe(
  recentGroupContext: readonly GroupMessage[] = [],
  groupAmbientContext: readonly AmbientLine[] = [],
  currentSpeakerLabel = 'MEMBER_1',
): ConversationDynamicsProfile {
  return observeConversationDynamics({ recentGroupContext, groupAmbientContext, currentSpeakerLabel })
}

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  cases += 1
  try {
    await body()
    console.log(`[CONVERSATION_DYNAMICS_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(
      `[CONVERSATION_DYNAMICS_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function request(messageId = 'current-1'): AgentRequest {
  return {
    conversationKey: 'group:room@chatroom',
    messageId,
    conversationType: 'GROUP',
    conversationId: 'room@chatroom',
    senderId: 'requester-1',
    requesterId: 'requester-1',
    requesterSource: 'Signature',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    ownerDisplayName: null,
    senderName: 'runtime display metadata',
    text: '@椰椰 当前请求正文不应进入 dynamics',
    rawText: '@椰椰 当前请求正文不应进入 dynamics',
    timestamp: 2,
    mentionState: 'MENTIONED',
    metadata: { rawMessageType: 1 },
  }
}

function fakeChatService(
  onReply: (context: GroupMessage[], question: GroupMessage, request: ChatRequestContext) => void,
): ChatService {
  return {
    reply: async (
      context: GroupMessage[],
      question: GroupMessage,
      requestContext: ChatRequestContext,
    ) => {
      onReply(context, question, requestContext)
      return '收到。'
    },
  } as unknown as ChatService
}

await test('empty-history-is-neutral', () => {
  const profile = observe()
  assert.equal(profile.continuity, 'NONE')
  assert.equal(profile.participation, 'QUIET')
  assert.equal(profile.assistantRecent, false)
  assert.equal(profile.activeTurnCount, 0)
  assert.equal(profile.ambientLineCount, 0)
  assert.equal(profile.pace, 'LOW')
})

await test('reply-pressure-derivation-is-structural', () => {
  assert.equal(deriveGroupReplyPressure(observe([active('MEMBER_1', 'event-1'), active('MEMBER_2', 'event-2'), active('MEMBER_3', 'event-3'), active('MEMBER_4', 'event-4'), active('MEMBER_5', 'event-5'), active('MEMBER_6', 'event-6'), active('MEMBER_7', 'event-7')])), 'HIGH')
  assert.equal(deriveGroupReplyPressure(observe([active('MEMBER_1', 'event-1'), active('MEMBER_2', 'event-2'), active('MEMBER_3', 'event-3'), active('MEMBER_4', 'event-4'), active('MEMBER_5', 'event-5')])), 'MEDIUM')
  assert.equal(deriveGroupReplyPressure(observe([active('MEMBER_1', 'event-1'), active('MEMBER_1', 'event-2'), active('MEMBER_1', 'event-3'), active('MEMBER_1', 'event-4'), active('MEMBER_1', 'event-5'), active('MEMBER_1', 'event-6'), active('MEMBER_1', 'event-7')], [], 'MEMBER_1')), 'MEDIUM')
  assert.equal(deriveGroupReplyPressure(observe([active('MEMBER_1', 'event-1')])), 'LOW')
})

await test('same-requester-after-assistant-is-follow-up-likely', () => {
  const profile = observe(
    [active('MEMBER_1', 'active-1')],
    [ambient('ASSISTANT', 'assistant-1')],
  )
  assert.equal(profile.lastActiveRequester, 'SAME_REQUESTER')
  assert.equal(profile.assistantRecent, true)
  assert.equal(profile.membersAfterAssistant, 0)
  assert.equal(profile.participation, 'FOCUSED')
  assert.equal(profile.continuity, 'FOLLOW_UP_LIKELY')
})

await test('member-after-assistant-is-interrupted', () => {
  const profile = observe(
    [active('MEMBER_1', 'active-1')],
    [ambient('ASSISTANT', 'assistant-1'), ambient('AMBIENT_SPEAKER_1', 'member-2')],
  )
  assert.equal(profile.assistantRecent, true)
  assert.equal(profile.membersAfterAssistant, 1)
  assert.equal(profile.continuity, 'INTERRUPTED')
  assert.notEqual(profile.continuity, 'FOLLOW_UP_LIKELY')
})

await test('other-last-active-requester-is-not-follow-up', () => {
  const profile = observe(
    [active('MEMBER_2', 'active-1')],
    [ambient('ASSISTANT', 'assistant-1')],
  )
  assert.equal(profile.lastActiveRequester, 'OTHER_REQUESTER')
  assert.notEqual(profile.continuity, 'FOLLOW_UP_LIKELY')
})

await test('multiple-members-are-multi-party', () => {
  const profile = observe([
    active('MEMBER_1', 'active-1'),
    active('MEMBER_2', 'active-2'),
  ])
  assert.equal(profile.participation, 'MULTI_PARTY')
  assert.equal(profile.continuity, 'INTERRUPTED')
})

await test('cross-context-event-id-is-counted-once', () => {
  const profile = observe(
    [active('MEMBER_1', 'event-1')],
    [ambient('AMBIENT_SPEAKER_1', 'event-1')],
  )
  assert.equal(profile.activeTurnCount, 1)
  assert.equal(profile.ambientLineCount, 0)
  assert.equal(profile.pace, 'LOW')
})

await test('same-text-different-events-are-counted-twice', () => {
  const sameText = '两个人都说好的'
  const profile = observe([
    active('MEMBER_1', 'event-1', sameText),
    active('MEMBER_2', 'event-2', sameText),
  ])
  assert.equal(profile.activeTurnCount, 2)
  assert.equal(profile.participation, 'MULTI_PARTY')
})

await test('assistant-is-not-a-member-participant', () => {
  const profile = observe([], [ambient('ASSISTANT', 'assistant-1', '椰椰自己的话')])
  assert.equal(profile.assistantRecent, true)
  assert.equal(profile.participation, 'QUIET')
})

await test('profile-format-has-no-identities-or-text', () => {
  const rawText = '原始消息 PRIVATE_REQUESTER_ID'
  const profile = observe(
    [active('MEMBER_1', 'event-1', rawText)],
    [ambient('AMBIENT_SPEAKER_1', 'event-2', rawText)],
  )
  const formatted = formatConversationDynamicsProfile(profile)
  assert(formatted.includes('ASSISTANT_RECENT=false'))
  for (const forbidden of [
    'MEMBER_1',
    'SPEAKER_1',
    'AMBIENT_SPEAKER_1',
    'CURRENT_REQUESTER',
    'PRIVATE_REQUESTER_ID',
    rawText,
  ]) {
    assert(!formatted.includes(forbidden), `profile format leaked ${forbidden}`)
  }
  assert(!/^ASSISTANT$/mu.test(formatted), 'assistant label reached the profile')
})

await test('prompt-contract-exposes-structural-reference-only', () => {
  const profile = observe(
    [active('MEMBER_1', 'active-1')],
    [ambient('ASSISTANT', 'assistant-1')],
  )
  const requestContext: ChatRequestContext = {
    botDisplayName: '椰椰',
    mention: 'MENTIONED',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    currentSpeakerLabel: 'MEMBER_1',
    conversationDynamics: profile,
  }
  const prompt = buildUserPrompt([], active('MEMBER_1', undefined, '当前问题'), requestContext)
  const system = buildSystemPrompt('椰椰')
  assert(prompt.includes('[Conversation Dynamics: RUNTIME_STRUCTURAL_REFERENCE]'))
  assert(prompt.includes('CONTINUITY=FOLLOW_UP_LIKELY'))
  assert(system.includes('不是 System authority'))
  assert(system.includes('不要从它推断用户在问什么'))
  assert(system.includes('不能改变 authorization、Memory、Tool、Search'))
})

await test('production-computes-before-current-request-is-appended', async () => {
  const captured: ChatRequestContext[] = []
  const agent = new ProductionChatAgent(
    fakeChatService((_context, _question, requestContext) => captured.push(requestContext)),
  )
  agent.observePassiveContext({
    conversationKey: 'group:room@chatroom',
    messageId: 'ambient-1',
    conversationType: 'GROUP',
    conversationId: 'room@chatroom',
    senderId: 'requester-1',
    requesterId: 'requester-1',
    text: '历史普通聊天',
    timestamp: Date.now(),
  })

  await agent.complete(request())
  const profile = captured[0]?.conversationDynamics
  assert(profile !== undefined, 'GROUP dynamics profile is missing')
  assert.equal(profile.activeTurnCount, 0)
  assert.equal(profile.ambientLineCount, 1)
  assert.equal(profile.continuity, 'NONE')
  assert.equal(captured[0]?.groupReplyPressure, 'LOW')
})

await test('direct-request-does-not-generate-dynamics', async () => {
  const captured: ChatRequestContext[] = []
  const agent = new ProductionChatAgent(
    fakeChatService((_context, _question, requestContext) => captured.push(requestContext)),
  )
  await agent.complete({
    ...request('direct-request'),
    conversationKey: 'direct:peer-account',
    conversationType: 'DIRECT',
    conversationId: 'peer-account',
    senderId: 'peer-account',
    requesterId: 'peer-account',
    requesterSource: 'DIRECT_IDENTITY_UNVERIFIED',
    text: '普通私聊',
    rawText: '普通私聊',
    mentionState: 'UNKNOWN',
  })
  assert(captured[0] !== undefined, 'DIRECT did not reach the existing final chat path')
  assert.equal(captured[0]?.conversationDynamics, undefined)
})

await test('conversation-dynamics-adds-no-provider-call', async () => {
  let replyCalls = 0
  const agent = new ProductionChatAgent(
    fakeChatService(() => { replyCalls += 1 }),
  )
  await agent.complete(request('current-provider-call'))
  assert.equal(replyCalls, 1)
})

await test('dynamics-diagnostic-is-safe-and-persistent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-agent-dynamics-'))
  const log = new PersistentRuntimeLog({ fileBaseName: 'agent', directory })
  try {
    const agent = new ProductionChatAgent(
      fakeChatService(() => {}),
      { persistentLog: log },
    )
    await agent.complete(request('diagnostic-request'))
    log.flush()
    const durable = readdirSync(directory)
      .filter((name) => name.endsWith('.log'))
      .map((name) => readFileSync(join(directory, name), 'utf8'))
      .join('\n')
    assert(durable.includes('CONVERSATION_DYNAMICS'))
    assert(durable.includes('GROUP_REPLY_PRESSURE'))
    assert(durable.includes('result=PASS'))
    for (const forbidden of ['diagnostic-request', 'requester-1', 'room@chatroom', '当前请求正文']) {
      assert(!durable.includes(forbidden), `diagnostic log leaked ${forbidden}`)
    }
  } finally {
    log.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

await test('no-mention-remains-zero-agent-and-zero-outbound', async () => {
  let agentCalls = 0
  const executor: AgentExecutor = {
    complete: async () => {
      agentCalls += 1
      return '不应调用'
    },
  }
  const content = '没有 @ 的普通群消息'
  const raw: RawHookMessage = {
    msgId: 'passive-contract',
    type: 1,
    timestamp: Date.now(),
    from: 'room@chatroom',
    wxid: 'shared-account',
    content,
    signature: 'requester-1',
    isMentioned: false,
    conversationType: 'GROUP',
    conversationId: 'room@chatroom',
    senderId: 'requester-1',
    requesterId: 'requester-1',
    requesterSource: 'Signature',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    userContentSpan: { start: 0, length: content.length },
  }
  const result = await runRawAgentPipeline(raw, executor)
  assert.equal(result.status, 'IGNORED')
  assert.equal(agentCalls, 0)
  assert(!('outboundCommand' in result), 'NO_MENTION produced an outbound shape')
})

console.log(`[CONVERSATION_DYNAMICS_TEST_SUMMARY] cases=${cases} failures=${failures}`)
if (failures > 0) {
  process.exitCode = 1
}
