import { strict as assert } from 'node:assert'
import {
  buildSystemPrompt,
  buildUserPrompt,
  type ChatRequestContext,
} from './chat.js'
import type { GroupMessage } from './context.js'
import {
  GroupAmbientContext,
  type AmbientLine,
} from './group-ambient-context.js'
import {
  observeConversationDynamics,
} from './conversation-dynamics.js'
import type { AgentExecutor, AgentRequest } from './agent-adapter.js'
import { applyMentionPolicy, runRawAgentPipeline } from './agent-adapter.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import type { ChatService } from './chat.js'
import { normalizeRawHookMessage, type RawHookMessage } from './message-contract.js'

const ROOM = 'room@chatroom'
const NOW = Date.now()

let cases = 0
let failures = 0

function active(senderId: string, senderName: string, text: string, messageId: string): GroupMessage {
  return { senderId, senderName, text, timestamp: NOW, messageId }
}

function memberAmbient(label: string, text: string, messageId: string): AmbientLine {
  return { label, text, messageId }
}

function assistantAmbient(
  text: string,
  messageId: string,
  replyTarget?: AmbientLine['replyTarget'],
): AmbientLine {
  return {
    label: 'ASSISTANT',
    text,
    messageId,
    ...(replyTarget === undefined ? {} : { replyTarget }),
  }
}

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  cases += 1
  try {
    await body()
    console.log(`[TURN_OWNERSHIP_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(
      `[TURN_OWNERSHIP_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function promptContext(overrides: Partial<ChatRequestContext> = {}): ChatRequestContext {
  return {
    botDisplayName: '椰椰',
    mention: 'MENTIONED',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    currentSpeakerLabel: 'MEMBER_1',
    ...overrides,
  }
}

function question(text = '当前问题', publicDisplayName: string | null = null): GroupMessage {
  return {
    senderId: 'requester-a',
    senderName: 'MEMBER_1',
    publicDisplayName,
    text,
    timestamp: NOW,
  }
}

function request(messageId: string, requesterId: string, text = '@椰椰 当前问题'): AgentRequest {
  return {
    conversationKey: `group:${ROOM}`,
    messageId,
    conversationType: 'GROUP',
    conversationId: ROOM,
    senderId: requesterId,
    requesterId,
    requesterSource: 'Signature',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    ownerDisplayName: null,
    senderName: null,
    text,
    rawText: text,
    timestamp: Date.now(),
    mentionState: 'MENTIONED',
    metadata: { rawMessageType: 1 },
  }
}

await test('same-requester-reply-target-is-current', () => {
  const ambient = new GroupAmbientContext({ now: () => NOW })
  ambient.append(ROOM, {
    messageId: 'assistant-a',
    speakerId: 'ASSISTANT',
    speakerType: 'ASSISTANT',
    text: '回复 A',
    timestamp: NOW,
    replyToSpeakerId: 'requester-a',
  })
  const line = ambient.select(ROOM, { currentRequesterId: 'requester-a' }).lines[0]
  assert.equal(line?.replyTarget, 'CURRENT_REQUESTER')
})

await test('third-party-reply-target-is-other-member', () => {
  const ambient = new GroupAmbientContext({ now: () => NOW })
  ambient.append(ROOM, {
    messageId: 'assistant-b',
    speakerId: 'ASSISTANT',
    speakerType: 'ASSISTANT',
    text: '回复 B',
    timestamp: NOW,
    replyToSpeakerId: 'requester-b',
  })
  const line = ambient.select(ROOM, { currentRequesterId: 'requester-a' }).lines[0]
  assert.equal(line?.replyTarget, 'OTHER_MEMBER')
})

await test('unknown-proactive-reply-does-not-claim-requester', () => {
  const ambient = new GroupAmbientContext({ now: () => NOW })
  ambient.append(ROOM, {
    messageId: 'assistant-proactive',
    speakerId: 'ASSISTANT',
    speakerType: 'ASSISTANT',
    text: '主动消息',
    timestamp: NOW,
  })
  const line = ambient.select(ROOM, { currentRequesterId: 'requester-a' }).lines[0]
  assert.equal(line?.replyTarget, 'UNKNOWN')
  assert(!JSON.stringify(line).includes('requester-a'))
})

await test('reply-target-aware-dynamics-only-follow-current-requester', () => {
  const current = active('requester-a', 'MEMBER_1', 'A 的问题', 'active-a')
  const currentReply = observeConversationDynamics({
    recentGroupContext: [current],
    groupAmbientContext: [assistantAmbient('答 A', 'assistant-a', 'CURRENT_REQUESTER')],
    currentSpeakerLabel: 'MEMBER_1',
    currentRequesterId: 'requester-a',
  })
  assert.equal(currentReply.continuity, 'FOLLOW_UP_LIKELY')
  assert.equal(currentReply.lastAssistantReplyTarget, 'CURRENT_REQUESTER')

  const otherReply = observeConversationDynamics({
    recentGroupContext: [current],
    groupAmbientContext: [assistantAmbient('答 B', 'assistant-b', 'OTHER_MEMBER')],
    currentSpeakerLabel: 'MEMBER_1',
    currentRequesterId: 'requester-a',
  })
  assert.notEqual(otherReply.continuity, 'FOLLOW_UP_LIKELY')
  assert.equal(otherReply.lastAssistantReplyTarget, 'OTHER_MEMBER')
})

await test('members-after-assistant-remain-interrupted', () => {
  const profile = observeConversationDynamics({
    recentGroupContext: [active('requester-a', 'MEMBER_1', 'A 的问题', 'active-a')],
    groupAmbientContext: [
      assistantAmbient('答 A', 'assistant-a', 'CURRENT_REQUESTER'),
      memberAmbient('AMBIENT_SPEAKER_2', 'B 插话', 'member-b'),
    ],
    currentSpeakerLabel: 'MEMBER_1',
    currentRequesterId: 'requester-a',
  })
  assert.equal(profile.membersAfterAssistant, 1)
  assert.equal(profile.continuity, 'INTERRUPTED')
})

await test('quoted-assistant-text-is-member-speech', () => {
  const profile = observeConversationDynamics({
    recentGroupContext: [],
    groupAmbientContext: [memberAmbient('AMBIENT_SPEAKER_1', 'ASSISTANT：我刚才说过', 'quote-1')],
    currentSpeakerLabel: 'MEMBER_1',
  })
  assert.equal(profile.assistantRecent, false)
  assert.equal(profile.lastAssistantReplyTarget, 'NONE')
})

await test('current-and-other-active-contexts-are-split', async () => {
  const calls: ChatRequestContext[] = []
  const chat = {
    reply: async (_context: GroupMessage[], _question: GroupMessage, context: ChatRequestContext) => {
      calls.push(context)
      return '收到。'
    },
  } as unknown as ChatService
  const ambient = new GroupAmbientContext({ now: () => Date.now() })
  const agent = new ProductionChatAgent(chat, { ambientContext: ambient })

  for (const item of [
    request('a-1', 'requester-a', 'A 的问题'),
    request('b-1', 'requester-b', 'B 的问题'),
  ]) {
    const answer = await agent.complete(item)
    const identity = agent.takeOutboundIdentity(item, answer)
    assert(identity)
    agent.observeOutboundDelivery({ ...identity, status: 'SENT', errorCode: '' })
  }
  const current = request('a-2', 'requester-a', 'A 的追问')
  const answer = await agent.complete(current)
  const identity = agent.takeOutboundIdentity(current, answer)
  assert(identity)
  assert.equal(calls.length, 3)
  assert.equal(calls[2]?.currentRequesterActiveContext?.map((item) => item.text).join('|'), 'A 的问题')
  assert.equal(calls[2]?.otherMemberActiveContext?.map((item) => item.text).join('|'), 'B 的问题')
  assert(!JSON.stringify(calls[2]?.currentRequesterActiveContext).includes('requester-a'))
  assert(!JSON.stringify(calls[2]?.otherMemberActiveContext).includes('requester-b'))
  agent.observeOutboundDelivery({ ...identity, status: 'SENT', errorCode: '' })
  assert.equal(calls.length, 3, 'ACK unexpectedly called the provider')
})

await test('ack-committed-assistant-retains-only-process-local-target', async () => {
  const chat = {
    reply: async () => '已回复',
  } as unknown as ChatService
  const ambient = new GroupAmbientContext({ now: () => Date.now() })
  const agent = new ProductionChatAgent(chat, { ambientContext: ambient })
  const item = request('target-a', 'requester-a')
  const answer = await agent.complete(item)
  const identity = agent.takeOutboundIdentity(item, answer)
  assert(identity)
  agent.observeOutboundDelivery({ ...identity, status: 'SENT', errorCode: '' })
  const stored = ambient.entries(ROOM).find((entry) => entry.speakerType === 'ASSISTANT')
  assert.equal(stored?.replyToSpeakerId, 'requester-a')
  const providerLines = ambient.select(ROOM, { currentRequesterId: 'requester-a' }).lines
  assert.equal(providerLines.at(-1)?.replyTarget, 'CURRENT_REQUESTER')
  assert(!JSON.stringify(providerLines).includes('requester-a'))
})

await test('same-display-names-stay-distinguishable', () => {
  const context = [
    active('requester-a', 'MEMBER_1', 'A 的历史', 'a-history'),
    active('requester-b', 'MEMBER_2', 'B 的历史', 'b-history'),
  ]
  const prompt = buildUserPrompt(context, question('当前问题', 'Liya'), promptContext({
    currentRequesterActiveContext: [active('requester-a', 'MEMBER_1', 'A 的历史', 'a-history')],
    otherMemberActiveContext: [active('requester-b', 'MEMBER_2', 'B 的历史', 'b-history')],
    ambient: [
      { label: 'AMBIENT_SPEAKER_2', publicDisplayName: 'Liya', text: 'B 的普通聊天', messageId: 'b-ambient' },
    ],
  }))
  assert(prompt.includes('Liya（同名成员A）'))
  assert(prompt.includes('Liya（同名成员B）'))
  assert(!prompt.includes('requester-a'))
  assert(!prompt.includes('requester-b'))
})

await test('ownership-prompt-is-explicit-and-no-text-routing', () => {
  const system = buildSystemPrompt('椰椰')
  assert(system.includes('[Turn Ownership Rules]'))
  assert(system.includes('ASSISTANT_REPLY_TARGET=CURRENT_REQUESTER'))
  assert(system.includes('不要依据关键词、正则、引号、固定短语'))
  assert(system.includes('不要跨区转移发言、称呼、行为、承诺或记忆'))
})

await test('raw-identity-does-not-cross-ownership-provider-boundary', () => {
  const rawRequester = 'requester-secret-a'
  const line: AmbientLine = {
    label: 'ASSISTANT',
    text: '答复',
    messageId: 'assistant-secret',
    replyTarget: 'OTHER_MEMBER',
  }
  const prompt = buildUserPrompt([], question(), promptContext({
    ambient: [line],
  }))
  assert(prompt.includes('ASSISTANT_REPLY_TARGET=OTHER_MEMBER'))
  assert(!prompt.includes(rawRequester))
  assert(!JSON.stringify(line).includes(rawRequester))
})

await test('no-mention-still-does-not-enter-agent', async () => {
  let calls = 0
  const executor: AgentExecutor = {
    complete: async () => {
      calls += 1
      return '不应调用'
    },
  }
  const raw: RawHookMessage = {
    msgId: 'no-mention',
    type: 1,
    timestamp: NOW,
    from: ROOM,
    wxid: 'shared-account',
    content: '普通群聊',
    signature: 'requester-a',
    isMentioned: false,
    conversationType: 'GROUP',
    conversationId: ROOM,
    senderId: 'requester-a',
    requesterId: 'requester-a',
    requesterSource: 'Signature',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    userContentSpan: { start: 0, length: '普通群聊'.length },
    botMentionSpans: [],
  }
  const result = await runRawAgentPipeline(raw, executor)
  assert.equal(result.status, 'IGNORED')
  assert.equal(calls, 0)
})

await test('memory-and-web-search-prompt-carriers-remain-present', () => {
  const prompt = buildUserPrompt([], question('最新资料是什么'), promptContext({
    memory: [{ scope: 'PERSONAL', content: '个人背景' }, { scope: 'GROUP', content: '群背景' }],
    webSearch: {
      used: true,
      status: 'PASS',
      results: [{ sourceId: 'S1', title: '资料', url: 'https://example.invalid', snippet: '证据' }],
    },
  }))
  assert(prompt.includes('[Authorized Personal Memory]'))
  assert(prompt.includes('个人背景'))
  assert(prompt.includes('[Authorized Group Memory]'))
  assert(prompt.includes('[Web Search Results]'))
  assert(prompt.includes('证据'))
})

await test('verified-owner-admission-contract-remains', async () => {
  const raw: RawHookMessage = {
    msgId: 'owner-direct',
    type: 1,
    timestamp: NOW,
    from: 'owner-account',
    wxid: 'owner-account',
    content: 'dispatch',
    signature: 'owner-requester',
    conversationType: 'DIRECT',
    conversationId: 'owner-account',
    senderId: 'owner-requester',
    requesterId: 'owner-requester',
    requesterSource: 'DIRECT_OWNER_FIELD_VERIFIED',
    requesterRole: 'OWNER',
    ownerConfigured: true,
    privateDispatchTargetConversationId: ROOM,
    isMentioned: null,
  }
  const normalized = normalizeRawHookMessage(raw)
  assert.equal(normalized.status, 'VALID')
  if (normalized.status === 'VALID') {
    assert.deepEqual(applyMentionPolicy(normalized.message), { status: 'PROCESS_PRIVATE_OWNER' })
  }
  let calls = 0
  const result = await runRawAgentPipeline(raw, {
    complete: async () => {
      calls += 1
      return ''
    },
  })
  assert.equal(result.status, 'AGENT_RESULT')
  assert.equal(calls, 1)
})

console.log(`[TURN_OWNERSHIP_TEST_SUMMARY] cases=${cases} failures=${failures}`)
if (failures > 0) {
  process.exitCode = 1
}
