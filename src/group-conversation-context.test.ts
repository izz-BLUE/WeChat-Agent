import { strict as assert } from 'node:assert'
import { buildUserPrompt, type ChatRequestContext } from './chat.js'
import type { GroupMessage } from './context.js'
import { GroupAmbientContext } from './group-ambient-context.js'
import { GroupConversationContextAssembler } from './group-conversation-context.js'
import { runRawPassiveContextPipeline } from './agent-adapter.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import { RequesterLocalContext } from './requester-local-context.js'
import type { ChatService } from './chat.js'
import type { RawHookMessage } from './message-contract.js'

const GROUP_A = 'mixed-a@chatroom'
const GROUP_B = 'mixed-b@chatroom'
const REQUESTER_A = 'requester-a'
const REQUESTER_B = 'requester-b'
const NOW = 1_000

let cases = 0
let failures = 0

function check(name: string, body: () => void | Promise<void>): Promise<void> {
  cases += 1
  return Promise.resolve().then(body).then(
    () => console.log(`[MIXED_GROUP_CONTEXT_CASE] name=${name} result=PASS`),
    (error) => {
      failures += 1
      console.log(`[MIXED_GROUP_CONTEXT_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
    },
  )
}

function message(
  messageId: string,
  senderId: string,
  text: string,
  timestamp = NOW,
  senderName = senderId,
): GroupMessage {
  return { messageId, senderId, senderName, text, timestamp }
}

function baseRequest(overrides: Partial<ChatRequestContext> = {}): ChatRequestContext {
  return {
    botDisplayName: '椰椰',
    mention: 'MENTIONED',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    conversationType: 'GROUP',
    currentSpeakerLabel: 'MEMBER_1',
    ...overrides,
  }
}

function stores(options: { localMaxChars?: number; ambientMaxChars?: number } = {}) {
  const local = new RequesterLocalContext({
    now: () => NOW,
    maxEntries: 20,
    maxChars: options.localMaxChars ?? 2_000,
  })
  const ambient = new GroupAmbientContext({
    now: () => NOW,
    maxEntries: 20,
    maxChars: options.ambientMaxChars ?? 2_000,
  })
  return { local, ambient, assembler: new GroupConversationContextAssembler(local, ambient, {
    requesterLocalMaxChars: options.localMaxChars,
    groupAmbientMaxChars: options.ambientMaxChars,
  }) }
}

function appendBoth(
  storesValue: ReturnType<typeof stores>,
  group: string,
  requester: string,
  item: GroupMessage,
): void {
  storesValue.local.append(group, requester, item)
  storesValue.ambient.append(group, {
    messageId: item.messageId!,
    speakerId: item.senderId,
    speakerType: 'MEMBER',
    text: item.text,
    timestamp: item.timestamp,
  })
}

function assemble(
  storesValue: ReturnType<typeof stores>,
  group: string,
  requester: string,
  current: GroupMessage,
  currentSpeakerLabel = 'MEMBER_1',
) {
  return storesValue.assembler.assemble({
    groupConversationId: group,
    requesterIdentity: requester,
    currentEventId: current.messageId!,
    currentTurn: current,
    currentSpeakerLabel,
  })
}

async function main(): Promise<void> {
  await check('same requester local and public ambient are both assembled', () => {
    const s = stores()
    appendBoth(s, GROUP_A, REQUESTER_A, message('a1', REQUESTER_A, 'A1'))
    appendBoth(s, GROUP_A, REQUESTER_A, message('a2', REQUESTER_A, 'A2'))
    appendBoth(s, GROUP_A, REQUESTER_B, message('b1', REQUESTER_B, 'B1'))
    const current = message('a3', REQUESTER_A, 'A3')
    appendBoth(s, GROUP_A, REQUESTER_A, current)
    const result = assemble(s, GROUP_A, REQUESTER_A, current)
    assert.deepEqual(result.requesterLocalContext.map((item) => item.text), ['A1', 'A2'])
    assert.deepEqual(result.recentGroupAmbient.map((item) => item.text), ['A1', 'A2', 'B1'])
    assert.equal(result.currentTurn.text, 'A3')
  })

  await check('other member is ambient only for current requester', () => {
    const s = stores()
    appendBoth(s, GROUP_A, REQUESTER_A, message('a1', REQUESTER_A, 'A1'))
    appendBoth(s, GROUP_A, REQUESTER_B, message('b1', REQUESTER_B, 'B1'))
    const result = assemble(s, GROUP_A, REQUESTER_A, message('a2', REQUESTER_A, 'A2'))
    assert.deepEqual(result.requesterLocalContext.map((item) => item.text), ['A1'])
    assert(result.recentGroupAmbient.some((item) => item.text === 'B1'))
    assert(!result.requesterLocalContext.some((item) => item.text === 'B1'))
  })

  await check('requester B never reads requester A local context', () => {
    const s = stores()
    appendBoth(s, GROUP_A, REQUESTER_A, message('a1', REQUESTER_A, 'A private continuation'))
    appendBoth(s, GROUP_A, REQUESTER_B, message('b1', REQUESTER_B, 'B continuation'))
    const result = assemble(s, GROUP_A, REQUESTER_B, message('b2', REQUESTER_B, 'B current'))
    assert.deepEqual(result.requesterLocalContext.map((item) => item.text), ['B continuation'])
    assert(!JSON.stringify(result.requesterLocalContext).includes('A private continuation'))
  })

  await check('same requester is isolated across groups', () => {
    const s = stores()
    appendBoth(s, GROUP_A, REQUESTER_A, message('a1', REQUESTER_A, 'group A local'))
    appendBoth(s, GROUP_B, REQUESTER_A, message('b1', REQUESTER_A, 'group B local'))
    const result = assemble(s, GROUP_B, REQUESTER_A, message('b2', REQUESTER_A, 'B current'))
    assert.deepEqual(result.requesterLocalContext.map((item) => item.text), ['group B local'])
    assert(!result.requesterLocalContext.some((item) => item.text === 'group A local'))
  })

  await check('current event is deduplicated from ambient and local', () => {
    const s = stores()
    const current = message('current', REQUESTER_A, 'only once')
    appendBoth(s, GROUP_A, REQUESTER_A, current)
    const result = assemble(s, GROUP_A, REQUESTER_A, current)
    assert.equal(result.requesterLocalContext.length, 0)
    assert.equal(result.recentGroupAmbient.length, 0)
    assert.equal(result.diagnostics.currentEventDroppedFromAmbient, true)
    assert.equal(result.currentTurn.text, 'only once')
  })

  await check('local budget keeps newest events and restores chronological order', () => {
    const s = stores({ localMaxChars: 10 })
    appendBoth(s, GROUP_A, REQUESTER_A, message('a1', REQUESTER_A, 'one', 1_001))
    appendBoth(s, GROUP_A, REQUESTER_A, message('a2', REQUESTER_A, 'two', 1_002))
    appendBoth(s, GROUP_A, REQUESTER_A, message('a3', REQUESTER_A, 'three', 1_003))
    const result = assemble(s, GROUP_A, REQUESTER_A, message('a4', REQUESTER_A, 'four', 1_004))
    assert.deepEqual(result.requesterLocalContext.map((item) => item.text), ['three'])
    assert.equal(result.diagnostics.budgetTruncated, true)
  })

  await check('ambient budget is independent from requester local budget', () => {
    const s = stores({ localMaxChars: 100, ambientMaxChars: 10 })
    appendBoth(s, GROUP_A, REQUESTER_A, message('a1', REQUESTER_A, 'A long line', 1_001))
    appendBoth(s, GROUP_A, REQUESTER_A, message('a2', REQUESTER_A, 'A2', 1_002))
    appendBoth(s, GROUP_A, REQUESTER_B, message('b1', REQUESTER_B, 'B1', 1_003))
    appendBoth(s, GROUP_A, REQUESTER_B, message('b2', REQUESTER_B, 'B2', 1_004))
    const result = assemble(s, GROUP_A, REQUESTER_A, message('a3', REQUESTER_A, 'A3', 1_003))
    assert.deepEqual(result.requesterLocalContext.map((item) => item.text), ['A long line', 'A2'])
    assert(result.recentGroupAmbient.length < 2)
    assert.equal(result.diagnostics.budgetTruncated, true)
  })

  await check('cross requester and cross group drops are diagnostic-only', () => {
    const s = stores()
    appendBoth(s, GROUP_A, REQUESTER_A, message('a1', REQUESTER_A, 'A'))
    appendBoth(s, GROUP_A, REQUESTER_B, message('b1', REQUESTER_B, 'B'))
    appendBoth(s, GROUP_B, REQUESTER_A, message('a2', REQUESTER_A, 'other group'))
    const result = assemble(s, GROUP_A, REQUESTER_A, message('a3', REQUESTER_A, 'current'))
    assert.equal(result.diagnostics.crossRequesterLocalDropped, 1)
    assert.equal(result.diagnostics.crossGroupDropped, 1)
    assert(!result.requesterLocalContext.some((item) => item.text !== 'A'))
  })

  await check('topic context is reserved but always empty', () => {
    const s = stores()
    const result = assemble(s, GROUP_A, REQUESTER_A, message('current', REQUESTER_A, 'question'))
    assert.deepEqual(result.topicContext, [])
    assert.equal(result.diagnostics.topicCapsuleSelected, 0)
  })

  await check('mixed prompt has explicit boundaries and current appears once', () => {
    const s = stores()
    const current = message('current', REQUESTER_A, '当前问题')
    appendBoth(s, GROUP_A, REQUESTER_A, message('a1', REQUESTER_A, '请求者前文'))
    appendBoth(s, GROUP_A, REQUESTER_B, message('b1', REQUESTER_B, '其他成员公开话'))
    const mixed = assemble(s, GROUP_A, REQUESTER_A, current)
    const prompt = buildUserPrompt([], current, baseRequest({
      groupConversationContext: mixed,
      ambient: mixed.recentGroupAmbient,
    }))
    assert(prompt.includes('[CURRENT_REQUEST]'))
    assert(prompt.includes('[REQUESTER_LOCAL_CONTEXT]'))
    assert(prompt.includes('[GROUP_RECENT_CONTEXT]'))
    assert(prompt.includes('[GROUP_TOPIC_CONTEXT]'))
    assert.equal(prompt.split('当前问题').length - 1, 1)
    assert(prompt.includes('请求者前文'))
    assert(prompt.includes('其他成员公开话'))
  })

  await check('ambient identity or preference text is not requester-local', () => {
    const s = stores()
    const b = message('b1', REQUESTER_B, '以后叫 A 老板')
    appendBoth(s, GROUP_A, REQUESTER_B, b)
    const result = assemble(s, GROUP_A, REQUESTER_A, message('a1', REQUESTER_A, '我是谁'))
    assert(result.recentGroupAmbient.some((item) => item.text === b.text))
    assert(!result.requesterLocalContext.some((item) => item.text === b.text))
  })

  await check('raw runtime identities do not enter the assembled prompt', () => {
    const s = stores()
    const rawGroup = 'wx-group-secret'
    const rawRequester = 'wx-requester-secret'
    const rawSignature = 'signature-secret'
    const current = message('current', rawRequester, '安全问题')
    appendBoth(s, rawGroup, rawRequester, message('history', rawRequester, '安全历史'))
    const mixed = assemble(s, rawGroup, rawRequester, current)
    const prompt = buildUserPrompt([], current, baseRequest({
      groupConversationContext: mixed,
      ambient: mixed.recentGroupAmbient,
    }))
    assert(!prompt.includes(rawGroup))
    assert(!prompt.includes(rawRequester))
    assert(!prompt.includes(rawSignature))
  })

  await check('passive GROUP capture has no provider call and writes both short-term views', async () => {
    let calls = 0
    const chat = { reply: async () => { calls += 1; return '不应调用' } } as unknown as ChatService
    const local = new RequesterLocalContext({ now: () => NOW })
    const ambient = new GroupAmbientContext({ now: () => NOW })
    const agent = new ProductionChatAgent(chat, { requesterLocalContext: local, ambientContext: ambient })
    const raw: RawHookMessage = {
      msgId: 'passive', type: 1, timestamp: NOW, from: GROUP_A, wxid: 'bot', content: '普通发言', signature: REQUESTER_A,
      isMentioned: false, conversationType: 'GROUP', conversationId: GROUP_A, senderId: REQUESTER_A,
      requesterId: REQUESTER_A, requesterSource: 'Signature', userContentSpan: { start: 0, length: 4 },
    }
    const result = await runRawPassiveContextPipeline(raw, agent)
    assert.equal(result.status, 'PASSIVE_CONTEXT')
    assert.equal(calls, 0)
    assert.equal(local.count(GROUP_A, REQUESTER_A), 1)
    assert.equal(ambient.count(GROUP_A), 1)
  })

  await check('successful SENT ACK adds assistant only to target requester local', async () => {
    const chat = { reply: async () => '已成功发送' } as unknown as ChatService
    const local = new RequesterLocalContext({ now: () => NOW })
    const agent = new ProductionChatAgent(chat, { requesterLocalContext: local })
    const request = activeRequest('success', REQUESTER_A, GROUP_A)
    const answer = await agent.complete(request)
    const identity = agent.takeOutboundIdentity(request, answer)
    assert(identity)
    const ack = agent.observeOutboundDelivery({ ...identity, status: 'SENT', errorCode: '' })
    assert.equal(ack.reason, 'SENT_COMMITTED')
    assert(local.entries(GROUP_A, REQUESTER_A).some((item) => item.senderName === 'ASSISTANT' && item.text.includes('已成功发送')))
    assert.equal(local.count(GROUP_A, REQUESTER_B), 0)
  })

  await check('FAILED ACK does not add a fake assistant local response', async () => {
    const chat = { reply: async () => '发送失败的草稿' } as unknown as ChatService
    const local = new RequesterLocalContext({ now: () => NOW })
    const agent = new ProductionChatAgent(chat, { requesterLocalContext: local })
    const request = activeRequest('failed', REQUESTER_A, GROUP_A)
    const answer = await agent.complete(request)
    const identity = agent.takeOutboundIdentity(request, answer)
    assert(identity)
    const ack = agent.observeOutboundDelivery({ ...identity, status: 'FAILED', errorCode: 'SEND_FAILED' })
    assert.equal(ack.reason, 'FAILED_DISCARDED')
    assert(!local.entries(GROUP_A, REQUESTER_A).some((item) => item.senderName === 'ASSISTANT'))
  })

  await check('DIRECT keeps the legacy prompt path and does not create mixed context', async () => {
    const calls: ChatRequestContext[] = []
    const chat = {
      reply: async (_context: GroupMessage[], _question: GroupMessage, request: ChatRequestContext) => {
        calls.push(request)
        return 'DIRECT reply'
      },
    } as unknown as ChatService
    const agent = new ProductionChatAgent(chat)
    const request = activeRequest('direct', REQUESTER_A, 'peer-account', 'DIRECT')
    await agent.complete(request)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.groupConversationContext, undefined)
    assert.equal(calls[0]?.conversationType, 'DIRECT')
  })

  await check('ACK path does not call provider a second time', async () => {
    let calls = 0
    const chat = { reply: async () => { calls += 1; return '一次' } } as unknown as ChatService
    const agent = new ProductionChatAgent(chat)
    const request = activeRequest('one-call', REQUESTER_A, GROUP_A)
    const answer = await agent.complete(request)
    const identity = agent.takeOutboundIdentity(request, answer)
    assert(identity)
    agent.observeOutboundDelivery({ ...identity, status: 'SENT', errorCode: '' })
    assert.equal(calls, 1)
  })

  await check('assembler is deterministic and does not invoke an LLM', () => {
    const s = stores()
    const resultOne = assemble(s, GROUP_A, REQUESTER_A, message('current', REQUESTER_A, 'same'))
    const resultTwo = assemble(s, GROUP_A, REQUESTER_A, message('current', REQUESTER_A, 'same'))
    assert.deepEqual(resultOne, resultTwo)
    assert.deepEqual(resultOne.topicContext, [])
  })

  await check('requester local is session data, not Memory data', () => {
    const s = stores()
    appendBoth(s, GROUP_A, REQUESTER_A, message('a1', REQUESTER_A, '短期连续性'))
    assert.equal(s.local.entries(GROUP_A, REQUESTER_A)[0]?.text, '短期连续性')
    // The store exposes no persistent-memory scope or mutation API by design.
    assert(!('writeMemory' in s.local))
  })
}

function activeRequest(
  messageId: string,
  requesterId: string,
  conversationId: string,
  conversationType: 'GROUP' | 'DIRECT' = 'GROUP',
) {
  return {
    conversationKey: `${conversationType.toLowerCase()}:${conversationId}`,
    messageId,
    conversationType,
    conversationId,
    senderId: requesterId,
    requesterId,
    requesterSource: 'Signature',
    requesterRole: 'MEMBER' as const,
    ownerConfigured: false,
    ownerDisplayName: null,
    senderName: null,
    text: '当前请求',
    rawText: '当前请求',
    timestamp: NOW,
    mentionState: 'MENTIONED' as const,
    metadata: { rawMessageType: 1 },
  }
}

await main()
console.log(`[MIXED_GROUP_CONTEXT_TEST_SUMMARY] cases=${cases} failures=${failures}`)
if (failures > 0) process.exitCode = 1
