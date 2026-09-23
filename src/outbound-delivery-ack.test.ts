import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { sha256Utf8, PendingOutboundReplyStore, type OutboundDeliveryAck } from './outbound-delivery.js'
import { applyMentionPolicy, runRawPassiveContextPipeline, toAgentRequest, toOutboundCommand, type AgentRequest } from './agent-adapter.js'
import { ChatService } from './chat.js'
import { GroupAmbientContext } from './group-ambient-context.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import { YEYE_REPLY_SIGNATURE } from './chat-renderer.js'
import { ProductionAgentTransportServer } from './production-agent-transport.js'
import type { InboundMessage, RawHookMessage } from './message-contract.js'
import type { MemoryService } from './memory-service.js'

const ROOM = 'delivery-ack@chatroom'
const REQUEST_ID = 'request-delivery-1'
const BASE_REQUEST: AgentRequest = {
  conversationKey: `group:${ROOM}`,
  messageId: REQUEST_ID,
  conversationType: 'GROUP',
  conversationId: ROOM,
  senderId: 'member-delivery',
  requesterId: 'member-delivery',
  requesterSource: 'synthetic',
  requesterRole: 'OWNER',
  ownerConfigured: true,
  ownerDisplayName: null,
  senderName: 'Synthetic Member',
  text: '你好',
  rawText: '你好',
  timestamp: 1_757_000_000_000,
  mentionState: 'MENTIONED',
  botMentionSpans: { trust: 'VALID', spans: [] },
  userContentSpan: { trust: 'VALID', span: { start: 0, length: 2 } },
  metadata: { rawMessageType: 1 },
}

function rawMessage(messageId = REQUEST_ID, content = '@椰椰\u2005你好'): RawHookMessage {
  return {
    msgId: messageId,
    type: 1,
    timestamp: BASE_REQUEST.timestamp,
    from: ROOM,
    wxid: 'account-delivery',
    content,
    signature: 'member-delivery',
    senderName: 'Synthetic Member',
    isMentioned: true,
    conversationType: 'GROUP',
    conversationId: ROOM,
    senderId: 'member-delivery',
    requesterId: 'member-delivery',
    requesterSource: 'synthetic',
    requesterRole: 'OWNER',
    ownerConfigured: true,
    ownerDisplayName: null,
    publicDisplayName: null,
    publicDisplayNameSource: 'NONE',
    botMentionSpans: [{ start: 0, length: 4 }],
    userContentSpan: { start: 4, length: 2 },
  }
}

function chatReturning(text: string): ChatService {
  const chat = new ChatService('https://provider.invalid/v1', 'synthetic-key', 'synthetic-model')
  chat.reply = async () => text
  return chat
}

function createAgent(reply = '收到。'): { agent: ProductionChatAgent; ambient: GroupAmbientContext } {
  const ambient = new GroupAmbientContext({ now: () => BASE_REQUEST.timestamp })
  return { agent: new ProductionChatAgent(chatReturning(reply), { ambientContext: ambient }), ambient }
}

function assertNoAssistant(ambient: GroupAmbientContext): void {
  assert.equal(ambient.entries(ROOM).some((line) => line.speakerType === 'ASSISTANT'), false)
}

function inboundMessage(messageId: string, text: string): InboundMessage {
  return {
    messageId,
    conversationType: 'GROUP',
    conversationId: ROOM,
    senderId: 'member-delivery',
    requesterId: 'member-delivery',
    requesterSource: 'synthetic',
    requesterRole: 'OWNER',
    ownerConfigured: true,
    ownerDisplayName: null,
    publicDisplayName: null,
    publicDisplayNameSource: 'NONE',
    senderName: 'Synthetic Member',
    text,
    rawText: text,
    isMentioned: true,
    timestamp: BASE_REQUEST.timestamp,
    rawMessageType: 1,
    botMentionSpans: { trust: 'VALID', spans: [] },
    userContentSpan: { trust: 'VALID', span: { start: 0, length: text.length } },
  }
}

async function testPendingAndHashContract(): Promise<void> {
  const lengths = [799, 800, 801, 965]
  for (const length of lengths) {
    const text = 'x'.repeat(length)
    const command = toOutboundCommand(inboundMessage(`length-${length}`, text), {
      kind: 'SUCCESS_TEXT',
      text,
    })
    assert(command)
    assert.equal(command.text, text)
    assert.equal(command.contentSha256, sha256Utf8(text))
    assert.match(command.outboundId, /^[0-9a-f-]{36}$/u)
    assert.equal(command.requestMessageId, `length-${length}`)
  }

  const mixed = '中文🙂é'
  assert.equal(sha256Utf8(mixed).length, 64)
  assert.equal(Buffer.byteLength(mixed, 'utf8'), 12)
  assert.equal('🙂'.length, 2)
}

async function testStoreCapacityAndAckOutcomes(): Promise<void> {
  let now = 1_000
  let sequence = 0
  const store = new PendingOutboundReplyStore({
    maxEntries: 2,
    ttlMs: 100,
    now: () => now,
    idFactory: () => `outbound-${++sequence}`,
  })
  const first = store.stage({ requestMessageId: 'r1', conversationId: ROOM, conversationType: 'GROUP', text: 'one', timestamp: now })
  const second = store.stage({ requestMessageId: 'r2', conversationId: ROOM, conversationType: 'GROUP', text: 'two', timestamp: now })
  store.stage({ requestMessageId: 'r3', conversationId: ROOM, conversationType: 'GROUP', text: 'three', timestamp: now })
  assert.equal(store.settle({
    outboundId: first.outboundId,
    requestMessageId: 'r1',
    status: 'SENT',
    contentSha256: sha256Utf8('one'),
    errorCode: '',
  }).reason, 'UNKNOWN_OUTBOUND')
  assert.equal(store.getIdentityFor('r2', 'two')?.outboundId, second.outboundId)
  now += 101
  assert.equal(store.settle({
    outboundId: second.outboundId,
    requestMessageId: 'r2',
    status: 'SENT',
    contentSha256: sha256Utf8('two'),
    errorCode: '',
  }).reason, 'PENDING_EXPIRED')
}

async function testGeneratedTextCommitsOnlyAfterSent(): Promise<void> {
  const { agent, ambient } = createAgent('delivery body')
  const answer = await agent.complete(BASE_REQUEST)
  assert.equal(answer, `delivery body${YEYE_REPLY_SIGNATURE}`)
  assertNoAssistant(ambient)
  const identity = agent.takeOutboundIdentity(BASE_REQUEST, answer)
  assert(identity)

  const ack: OutboundDeliveryAck = {
    outboundId: identity.outboundId,
    requestMessageId: REQUEST_ID,
    status: 'SENT',
    contentSha256: sha256Utf8(answer),
    errorCode: '',
  }
  assert.equal((await agent.observeOutboundDelivery(ack)).accepted, true)
  const lines = ambient.entries(ROOM)
  assert.equal(lines.filter((line) => line.speakerType === 'ASSISTANT').length, 1)
  assert.equal((await agent.observeOutboundDelivery(ack)).reason, 'DUPLICATE_ACK')
  assert.equal(lines.filter((line) => line.speakerType === 'ASSISTANT').length, 1)
}

async function testFailedAckDiscardsWithoutProviderOrAmbient(): Promise<void> {
  let providerCalls = 0
  const chat = chatReturning('will fail')
  chat.reply = async () => {
    providerCalls += 1
    return 'will fail'
  }
  const ambient = new GroupAmbientContext({ now: () => BASE_REQUEST.timestamp })
  const agent = new ProductionChatAgent(chat, { ambientContext: ambient })
  const answer = await agent.complete(BASE_REQUEST)
  const identity = agent.takeOutboundIdentity(BASE_REQUEST, answer)
  assert(identity)
  const result = await agent.observeOutboundDelivery({
    outboundId: identity.outboundId,
    requestMessageId: REQUEST_ID,
    status: 'FAILED',
    contentSha256: sha256Utf8(answer),
    errorCode: 'NATIVE_TIMEOUT',
  })
  assert.equal(result.accepted, true)
  assert.equal(ambient.entries(ROOM).some((line) => line.speakerType === 'ASSISTANT'), false)
  assert.equal(providerCalls, 1)
}

async function testFailedAckDiscardsOnHashMismatch(): Promise<void> {
  const { agent, ambient } = createAgent('masked before send')
  const answer = await agent.complete(BASE_REQUEST)
  const identity = agent.takeOutboundIdentity(BASE_REQUEST, answer)
  assert(identity)
  const result = await agent.observeOutboundDelivery({
    outboundId: identity.outboundId,
    requestMessageId: REQUEST_ID,
    status: 'FAILED',
    contentSha256: sha256Utf8('the adapter changed this before failing'),
    errorCode: 'CONTENT_TOO_LARGE',
  })
  assert.equal(result.reason, 'FAILED_DISCARDED')
  assertNoAssistant(ambient)
  assert.equal(agent.takeOutboundIdentity(BASE_REQUEST, answer), null)
}

async function testAckTransportIsIndependentAndDoesNotInvokeProvider(): Promise<void> {
  const { agent, ambient } = createAgent('transport body')
  const transport = new ProductionAgentTransportServer({
    pipeName: `wechat-agent-ack-${process.pid}-${Date.now()}`,
    agent,
  })
  await transport.start()
  const socket = createConnection(transport.endpoint)
  let buffer = ''
  const readLine = async (): Promise<Record<string, unknown>> => {
    while (!buffer.includes('\n')) {
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
      buffer += chunk
    }
    const line = buffer.slice(0, buffer.indexOf('\n'))
    buffer = buffer.slice(line.length + 1)
    return JSON.parse(line) as Record<string, unknown>
  }
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const request = JSON.stringify({ kind: 'INBOUND_MESSAGE', message: rawMessage() })
    socket.write(`${request}\n`)
    const outbound = await readLine()
    assert.equal(outbound.kind, 'OUTBOUND_COMMAND')
    const command = outbound as typeof outbound & { outboundId: string; requestMessageId: string; contentSha256: string; text: string }
    assert.equal(command.requestMessageId, REQUEST_ID)
    assert.equal(command.contentSha256, sha256Utf8(command.text))
    assertNoAssistant(ambient)

    socket.write(`${JSON.stringify({
      kind: 'OUTBOUND_DELIVERY_ACK',
      payload: {
        outboundId: command.outboundId,
        requestMessageId: command.requestMessageId,
        status: 'SENT',
        contentSha256: command.contentSha256,
        errorCode: '',
      },
    })}\n`)
    const ack = await readLine()
    assert.equal(ack.kind, 'DELIVERY_ACK_ACCEPTED')
    assert.equal(ambient.entries(ROOM).some((line) => line.speakerType === 'ASSISTANT'), true)
  } finally {
    socket.destroy()
    await transport.stop()
  }
}

async function testRequestAndHashMismatchFailClosed(): Promise<void> {
  const store = new PendingOutboundReplyStore({ now: () => 1000, ttlMs: 5000 })
  const identity = store.stage({
    requestMessageId: 'request-1',
    conversationId: ROOM,
    conversationType: 'GROUP',
    text: 'body',
    timestamp: 1000,
  })
  assert.equal(
    store.settle({ ...identity, requestMessageId: 'request-forged', status: 'SENT', errorCode: '' }).reason,
    'REQUEST_ID_MISMATCH',
  )
  assert.equal(
    store.settle({
      ...identity,
      status: 'SENT',
      contentSha256: sha256Utf8('forged'),
      errorCode: '',
    }).reason,
    'CONTENT_HASH_MISMATCH',
  )
  assert.equal(store.settle({ ...identity, status: 'FAILED', errorCode: 'NATIVE_TIMEOUT' }).accepted, true)
}

async function testMalformedAckIsRejected(): Promise<void> {
  const store = new PendingOutboundReplyStore({ now: () => 1000 })
  const identity = store.stage({
    requestMessageId: 'request-malformed',
    conversationId: ROOM,
    conversationType: 'GROUP',
    text: 'body',
    timestamp: 1000,
  })
  assert.equal(
    store.settle({ ...identity, status: 'SENT', contentSha256: 'not-a-hash', errorCode: '' }).reason,
    'INVALID_ACK',
  )
}

async function testRestartClearsPendingState(): Promise<void> {
  const first = new PendingOutboundReplyStore({ now: () => 1000 })
  const identity = first.stage({
    requestMessageId: 'request-restart',
    conversationId: ROOM,
    conversationType: 'GROUP',
    text: 'body',
    timestamp: 1000,
  })
  const restarted = new PendingOutboundReplyStore({ now: () => 1000 })
  assert.equal(restarted.settle({ ...identity, status: 'SENT', errorCode: '' }).reason, 'UNKNOWN_OUTBOUND')
}

async function testExplicitMemoryReplyIsNotDeliveryEligible(): Promise<void> {
  const memory = {
    tryHandleExplicit: async () => ({ handled: true, reply: '已记住' }),
  } as unknown as MemoryService
  const agent = new ProductionChatAgent(chatReturning('provider must not run'), {
    memory,
    ambientContext: new GroupAmbientContext({ now: () => BASE_REQUEST.timestamp }),
  })
  const answer = await agent.complete(BASE_REQUEST)
  assert.equal(answer, `已记住${YEYE_REPLY_SIGNATURE}`)
  assert.equal(agent.takeOutboundIdentity(BASE_REQUEST, answer), null)
}

async function testPassivePathHasNoOutboundOrProvider(): Promise<void> {
  let passiveCalls = 0
  const result = await runRawPassiveContextPipeline(
    {
      ...rawMessage('passive-1', '普通群聊'),
      isMentioned: false,
      botMentionSpans: [],
      userContentSpan: { start: 0, length: '普通群聊'.length },
    },
    {
      complete: async () => { throw new Error('passive path invoked active executor') },
      observePassiveContext: () => { passiveCalls += 1 },
    },
  )
  assert.equal(result.status, 'PASSIVE_CONTEXT')
  assert.equal(passiveCalls, 1)
}

async function testLengthPreserved(length: number): Promise<void> {
  const text = 'a'.repeat(length)
  const command = toOutboundCommand(inboundMessage(`preserve-${length}`, text), { kind: 'SUCCESS_TEXT', text })
  assert(command)
  assert.equal(command.text.length, length)
  assert.equal(command.contentSha256, sha256Utf8(text))
}

async function testDirectPolicyStillFailsClosed(): Promise<void> {
  const direct = { ...inboundMessage('direct-policy', 'x'), conversationType: 'DIRECT' as const, isMentioned: true }
  assert.deepEqual(applyMentionPolicy(direct), {
    status: 'IGNORED',
    reason: 'DIRECT_IDENTITY_UNVERIFIED',
  })
}

function run(): void {
  void testPendingAndHashContract()
    .then(testStoreCapacityAndAckOutcomes)
    .then(testGeneratedTextCommitsOnlyAfterSent)
    .then(testFailedAckDiscardsWithoutProviderOrAmbient)
    .then(testFailedAckDiscardsOnHashMismatch)
    .then(testAckTransportIsIndependentAndDoesNotInvokeProvider)
    .then(testRequestAndHashMismatchFailClosed)
    .then(testMalformedAckIsRejected)
    .then(testRestartClearsPendingState)
    .then(testExplicitMemoryReplyIsNotDeliveryEligible)
    .then(testPassivePathHasNoOutboundOrProvider)
    .then(() => testLengthPreserved(799))
    .then(() => testLengthPreserved(800))
    .then(() => testLengthPreserved(801))
    .then(() => testLengthPreserved(965))
    .then(async () => {
      const text = '中英文 mixed 🙂'
      assert.equal(sha256Utf8(text), sha256Utf8(text))
      assert.equal(Buffer.byteLength(text, 'utf8'), 20)
    })
    .then(async () => {
      let now = 1000
      const store = new PendingOutboundReplyStore({ now: () => now, ttlMs: 10 })
      const identity = store.stage({
        requestMessageId: 'expired',
        conversationId: ROOM,
        conversationType: 'GROUP',
        text: 'body',
        timestamp: now,
      })
      now += 11
      assert.equal(
        store.settle({ ...identity, status: 'SENT', errorCode: '' }).reason,
        'PENDING_EXPIRED',
      )
    })
    .then(testDirectPolicyStillFailsClosed)
    .then(() => console.log('OUTBOUND_DELIVERY_ACK_TESTS=PASS cases=21'))
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
}

run()
