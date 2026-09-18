import {
  applyMentionPolicy,
  conversationKey,
  mapAgentResponse,
  runRawAgentPipeline,
  toAgentRequest,
  toOutboundCommand,
  type AgentExecutor,
  type AgentRequest,
} from './agent-adapter.js'
import {
  normalizeRawHookMessage,
  type InboundMessage,
  type RawHookMessage,
} from './message-contract.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function raw(overrides: Partial<RawHookMessage> = {}): RawHookMessage {
  return {
    msgId: 'message-1',
    type: 1,
    timestamp: 1_757_000_000_000,
    from: 'friend-1',
    wxid: 'friend-1',
    content: ' hello ',
    signature: 'sender-1',
    senderName: 'Sender One',
    isMentioned: null,
    ...overrides,
  }
}

/**
 * Group envelope with the runtime identity decision on the wire. The raw wxid is
 * deliberately the account identity, i.e. the same value for every requester.
 */
function groupRaw(overrides: Partial<RawHookMessage> = {}): RawHookMessage {
  const from = overrides.from ?? 'room-a@chatroom'
  const senderId = overrides.senderId ?? overrides.signature ?? 'sender-a'
  return {
    msgId: 'group-message-1',
    type: 1,
    timestamp: 1_757_000_000_000,
    from,
    wxid: 'self-wxid',
    content: ' hello ',
    signature: 'sender-a',
    senderName: 'Sender One',
    isMentioned: null,
    ...overrides,
    conversationType: overrides.conversationType ?? 'GROUP',
    conversationId: overrides.conversationId ?? from,
    senderId,
    requesterId: overrides.requesterId ?? senderId,
    requesterSource: overrides.requesterSource ?? 'Signature',
    requesterRole: overrides.requesterRole ?? 'MEMBER',
    ownerConfigured: overrides.ownerConfigured ?? false,
  }
}

class FakeAgent implements AgentExecutor {
  public readonly requests: AgentRequest[] = []

  public constructor(
    private readonly response: string | null | undefined,
    private readonly shouldThrow = false,
  ) {}

  public async complete(request: AgentRequest): Promise<string | null | undefined> {
    this.requests.push(request)
    if (this.shouldThrow) {
      throw new Error('synthetic agent failure')
    }
    return this.response
  }
}

function validMessage(input: RawHookMessage): InboundMessage {
  const result = normalizeRawHookMessage(input)
  assert(result.status === 'VALID', `expected valid message, got ${result.status}`)
  return result.message
}

async function testDirectNormalization(): Promise<void> {
  const message = validMessage(raw({ from: 'private-a', wxid: 'wxid-a', signature: '', content: ' hi ' }))
  assert(message.conversationType === 'DIRECT', 'direct conversation type was not normalized')
  assert(message.conversationId === 'private-a', 'direct conversation id was not preserved')
  assert(message.senderId === 'wxid-a', 'sender fallback did not use wxid')
  assert(message.requesterId === 'wxid-a', 'direct requester id was not carried')
  assert(message.requesterSource === 'DIRECT_IDENTITY_UNVERIFIED', 'direct identity was not marked unverified')
  assert(message.senderName === 'Sender One', 'sender name was not mapped')
  assert(message.text === 'hi', 'text was not normalized')
  assert(message.isMentioned === null, 'mention uncertainty was not preserved')
}

/**
 * DIRECT fails closed: no mention can admit it, because the DIRECT identity,
 * recipient and self contracts are still unverified.
 */
async function testDirectIsRefused(): Promise<void> {
  const mentioned = validMessage(raw({ from: 'private-a', wxid: 'wxid-a', isMentioned: true }))
  const policy = applyMentionPolicy(mentioned)
  assert(policy.status === 'IGNORED', 'a DIRECT message was admitted without a verified contract')
  assert(policy.reason === 'DIRECT_IDENTITY_UNVERIFIED', 'unexpected DIRECT ignore reason')

  const agent = new FakeAgent('私聊回复')
  const result = await runRawAgentPipeline(raw({ from: 'private-a', wxid: 'wxid-a' }), agent)
  assert(result.status === 'IGNORED', 'a DIRECT message did not stop at the policy gate')
  assert(result.policy.reason === 'DIRECT_IDENTITY_UNVERIFIED', 'unexpected DIRECT pipeline reason')
  assert(agent.requests.length === 0, 'the agent was invoked for a DIRECT message')
}

async function testGroupMentionPolicy(): Promise<void> {
  const message = validMessage(groupRaw({ isMentioned: true }))
  const policy = applyMentionPolicy(message)
  assert(policy.status === 'PROCESS', 'mentioned group message was not accepted')
  assert(message.conversationType === 'GROUP', 'group conversation type was not normalized')
  assert(toAgentRequest(message).mentionState === 'MENTIONED', 'runtime mention state was not carried')
}

async function testGroupWithoutMentionIsIgnored(): Promise<void> {
  const message = validMessage(groupRaw({ isMentioned: false }))
  const policy = applyMentionPolicy(message)
  assert(policy.status === 'IGNORED', 'unmentioned group message was not ignored')
  assert(policy.reason === 'GROUP_MENTION_REQUIRED', 'unexpected ignore reason')
  assert(toAgentRequest(message).mentionState === 'NOT_MENTIONED', 'not-mentioned state was not carried')
}

async function testCreatorFieldIsAdditiveAndOptional(): Promise<void> {
  const withCreator = validMessage(groupRaw({
    isMentioned: true,
    ownerConfigured: true,
    ownerDisplayName: '张三',
    assistantCreatorDisplayName: '辞老师',
  }))
  const request = toAgentRequest(withCreator)
  assert(withCreator.assistantCreatorDisplayName === '辞老师', 'Creator display name was not normalized')
  assert(request.assistantCreatorDisplayName === '辞老师', 'Creator display name was not carried to AgentRequest')

  const legacy = validMessage(groupRaw({ isMentioned: true }))
  assert(legacy.assistantCreatorDisplayName === null, 'legacy runtime without Creator did not fail safe to unknown')
  assert(toAgentRequest(legacy).assistantCreatorDisplayName === null,
    'legacy runtime Creator absence was not preserved as unknown')
}

async function testConversationIsolation(): Promise<void> {
  const roomA = validMessage(groupRaw({ from: 'room-a@chatroom', msgId: 'room-a-message' }))
  const roomB = validMessage(groupRaw({ from: 'room-b@chatroom', msgId: 'room-b-message' }))
  const privateA = validMessage(raw({ from: 'private-a', msgId: 'private-a-message' }))
  const privateB = validMessage(raw({ from: 'private-b', msgId: 'private-b-message' }))
  assert(conversationKey(roomA) !== conversationKey(roomB), 'group rooms share a key')
  assert(conversationKey(privateA) !== conversationKey(privateB), 'private users share a key')
  assert(conversationKey(roomA) !== conversationKey(privateA), 'group and direct keys collide')
}

async function testInvalidAndUnsupported(): Promise<void> {
  const empty = normalizeRawHookMessage(raw({ content: '   ' }))
  const unsupported = normalizeRawHookMessage(raw({ type: 47 }))
  assert(empty.status === 'INVALID', 'empty text was not invalid')
  assert(unsupported.status === 'UNSUPPORTED', 'unsupported raw type was not rejected')
}

async function testAdapterDoesNotLeakRawFields(): Promise<void> {
  const message = validMessage(groupRaw({ isMentioned: true }))
  const request = toAgentRequest(message)
  assert(!Object.hasOwn(request, 'from'), 'raw from field leaked into agent request')
  assert(!Object.hasOwn(request, 'wxid'), 'raw wxid field leaked into agent request')
  assert(!Object.hasOwn(request, 'signature'), 'raw signature field leaked into agent request')
  assert(!Object.hasOwn(request, 'content'), 'raw content field leaked into agent request')
  assert(request.conversationKey === 'group:room-a@chatroom', 'agent conversation key is not canonical')
}

async function testAgentResponseMapping(): Promise<void> {
  const message = validMessage(groupRaw({ isMentioned: true }))
  const success = mapAgentResponse('  reply  ')
  const noReply = mapAgentResponse('  ')
  const command = toOutboundCommand(message, success)
  assert(success.kind === 'SUCCESS_TEXT', 'normal agent response was not successful text')
  assert(command?.conversationId === 'room-a@chatroom', 'outbound room target changed')
  assert(command?.text === 'reply', 'outbound text was not normalized')
  assert(noReply.kind === 'NO_REPLY', 'empty agent response was not no-reply')
  assert(toOutboundCommand(message, noReply) === null, 'no-reply produced an outbound command')
}

async function testAgentNoReplyPipeline(): Promise<void> {
  const agent = new FakeAgent(null)
  const result = await runRawAgentPipeline(groupRaw({ isMentioned: true }), agent)
  assert(result.status === 'AGENT_RESULT', 'no-reply did not reach agent result')
  assert(result.agentResult.kind === 'NO_REPLY', 'empty agent response was not mapped to no-reply')
  assert(result.outboundCommand === null, 'a no-reply produced an outbound command')
}

async function testAgentErrorMapping(): Promise<void> {
  const message = validMessage(groupRaw({ isMentioned: true }))
  const agent = new FakeAgent(undefined, true)
  const result = await runRawAgentPipeline(groupRaw({ isMentioned: true }), agent)
  assert(result.status === 'AGENT_RESULT', 'agent exception did not complete the pipeline')
  assert(result.agentResult.kind === 'ERROR', 'agent exception was not mapped to error')
  assert(result.outboundCommand === null, 'agent exception produced an outbound command')
  assert(toOutboundCommand(message, { kind: 'ERROR' }) === null, 'error mapping can send a reply')
}

async function testSyntheticEndToEnd(): Promise<void> {
  const agent = new FakeAgent('synthetic response')
  const result = await runRawAgentPipeline(
    groupRaw({ from: 'room-e2e@chatroom', isMentioned: true, msgId: 'e2e-message' }),
    agent,
  )
  assert(result.status === 'AGENT_RESULT', 'synthetic e2e did not reach agent result')
  assert(result.request.conversationType === 'GROUP', 'synthetic e2e changed conversation type')
  assert(result.request.conversationId === 'room-e2e@chatroom', 'synthetic e2e changed room identity')
  assert(result.request.requesterId === 'sender-a', 'synthetic e2e changed the requester identity')
  assert(result.request.requesterSource === 'Signature', 'synthetic e2e changed the requester source')
  assert(result.agentResult.kind === 'SUCCESS_TEXT', 'synthetic e2e agent result was not text')
  assert(result.outboundCommand?.conversationId === 'room-e2e@chatroom', 'synthetic e2e target changed')
  assert(result.outboundCommand?.text === 'synthetic response', 'synthetic e2e text changed')
  assert(agent.requests.length === 1, 'synthetic e2e did not call the fake agent exactly once')
}

const cases: Array<[string, () => Promise<void>]> = [
  ['direct-normalization', testDirectNormalization],
  ['direct-is-refused', testDirectIsRefused],
  ['group-mention-policy', testGroupMentionPolicy],
  ['group-without-mention-ignored', testGroupWithoutMentionIsIgnored],
  ['creator-field-is-additive-and-optional', testCreatorFieldIsAdditiveAndOptional],
  ['conversation-isolation', testConversationIsolation],
  ['invalid-and-unsupported', testInvalidAndUnsupported],
  ['adapter-field-isolation', testAdapterDoesNotLeakRawFields],
  ['agent-response-mapping', testAgentResponseMapping],
  ['agent-no-reply-pipeline', testAgentNoReplyPipeline],
  ['agent-error-mapping', testAgentErrorMapping],
  ['synthetic-end-to-end', testSyntheticEndToEnd],
]

let failures = 0
for (const [name, testCase] of cases) {
  try {
    await testCase()
    console.log(`[CONTRACT_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.error(`[CONTRACT_CASE] name=${name} result=FAIL message=${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(`[CONTRACT_TEST_SUMMARY] cases=${cases.length} failures=${failures}`)
console.log(`[SYNTHETIC_E2E] result=${failures === 0 ? 'PASS' : 'FAIL'}`)
if (failures > 0) {
  process.exitCode = 1
}
