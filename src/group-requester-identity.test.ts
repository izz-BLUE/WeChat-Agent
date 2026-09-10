/**
 * GROUP requester identity contract tests.
 *
 * Real 4.1.11.52 runtime evidence settled the field semantics: Signature is the
 * stable per-sender identity (stable for one sender, distinct across senders,
 * stable across groups) while Wxid is identical for every sender in a group.
 * The C# runtime is therefore the single producer and the Agent only consumes
 * the wire decision. These tests pin that consumption, the fail-closed rules and
 * the fact that no new capability (owner/memory/prompt) was added.
 */
import {
  runRawAgentPipeline,
  toAgentRequest,
  type AgentExecutor,
  type AgentRequest,
} from './agent-adapter.js'
import {
  normalizeRawHookMessage,
  type InboundMessage,
  type RawHookMessage,
} from './message-contract.js'
import {
  IDENTITY_OBSERVE_ENV,
  formatRequesterIdentity,
  logRequesterIdentity,
  observeRawInbound,
  observeRequesterIdentity,
  type RequesterIdentityFields,
} from './identity-observer.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

/**
 * Group envelope as the C# runtime emits it: the raw wxid is the account
 * identity (identical for every sender), the signature is the sender identity,
 * and the wire carries the already-decided identity.
 */
function groupRaw(overrides: Partial<RawHookMessage> = {}): RawHookMessage {
  const from = overrides.from ?? 'room-a@chatroom'
  const signature = overrides.signature ?? 'sig-a'
  const senderId = overrides.senderId ?? signature
  return {
    msgId: 'group-message-1',
    type: 1,
    timestamp: 1_757_000_000_000,
    from,
    wxid: 'self-wxid',
    content: ' hello ',
    signature,
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

class RecordingAgent implements AgentExecutor {
  public readonly requests: AgentRequest[] = []

  public constructor(private readonly response: string | null = 'reply') {}

  public async complete(request: AgentRequest): Promise<string | null> {
    this.requests.push(request)
    return this.response
  }
}

function validMessage(input: RawHookMessage): InboundMessage {
  const result = normalizeRawHookMessage(input)
  assert(result.status === 'VALID', `expected VALID, got ${result.status}:${'reason' in result ? result.reason : ''}`)
  return result.message
}

function invalidReason(input: RawHookMessage): string {
  const result = normalizeRawHookMessage(input)
  assert(result.status === 'INVALID', `expected INVALID, got ${result.status}`)
  return result.reason
}

function omit(input: RawHookMessage, ...keys: Array<keyof RawHookMessage>): RawHookMessage {
  const clone: RawHookMessage = { ...input }
  for (const key of keys) {
    delete clone[key]
  }
  return clone
}

async function testGroupSenderAIsRequester(): Promise<void> {
  const message = validMessage(groupRaw({ signature: 'sig-a', isMentioned: true }))
  const requesterId: string = message.requesterId
  assert(message.conversationType === 'GROUP', 'conversation type was not GROUP')
  assert(message.senderId === 'sig-a', 'group sender id is not the signature')
  assert(message.requesterId === 'sig-a', 'group requester id is not the signature')
  assert(message.requesterSource === 'Signature', 'group requester source is not Signature')
  assert(message.conversationId === 'room-a@chatroom', 'conversation id changed')
  assert(requesterId !== 'self-wxid', 'raw wxid leaked into the requester identity')
}

async function testGroupSenderBIsRequester(): Promise<void> {
  const message = validMessage(groupRaw({ signature: 'sig-b', isMentioned: true }))
  assert(message.senderId === 'sig-b', 'second group sender id is not the signature')
  assert(message.requesterId === 'sig-b', 'second group requester id is not the signature')
}

async function testSameWxidDifferentSignatureStaysDistinct(): Promise<void> {
  const first = validMessage(groupRaw({ signature: 'sig-a' }))
  const second = validMessage(groupRaw({ signature: 'sig-b', msgId: 'group-message-2' }))
  assert(first.requesterId !== second.requesterId, 'one wxid collapsed two requesters')
  assert(first.requesterId === 'sig-a' && second.requesterId === 'sig-b', 'requesters are not the signatures')
}

async function testSameSignatureAcrossConversationsKeepsRequester(): Promise<void> {
  const roomA = validMessage(groupRaw({ signature: 'sig-a', from: 'room-a@chatroom' }))
  const roomB = validMessage(groupRaw({ signature: 'sig-a', from: 'room-b@chatroom', msgId: 'group-message-3' }))
  assert(roomA.requesterId === roomB.requesterId, 'cross-room requester identity is not stable')
  assert(roomA.conversationId !== roomB.conversationId, 'rooms share a conversation id')
}

async function testMissingGroupIdentityFailsClosed(): Promise<void> {
  const withoutSender = omit(groupRaw(), 'senderId', 'requesterId')
  assert(invalidReason(withoutSender) === 'GROUP_SENDER_IDENTITY_MISSING', 'missing group sender was not fail-closed')

  const withoutRequester = omit(groupRaw(), 'requesterId')
  assert(
    invalidReason(withoutRequester) === 'GROUP_REQUESTER_IDENTITY_MISSING',
    'missing group requester was not fail-closed',
  )
}

async function testWhitespaceGroupIdentityFailsClosed(): Promise<void> {
  assert(
    invalidReason(groupRaw({ senderId: '   ', requesterId: '   ' })) === 'GROUP_SENDER_IDENTITY_MISSING',
    'whitespace group sender was not fail-closed',
  )
  assert(
    invalidReason(groupRaw({ requesterId: '   ' })) === 'GROUP_REQUESTER_IDENTITY_MISSING',
    'whitespace group requester was not fail-closed',
  )
}

async function testOpaqueRequesterIdAccepted(): Promise<void> {
  // Real field evidence: a sender signature is not required to look like a wxid.
  const opaque = 'opaque.9f2b-c:1'
  const message = validMessage(groupRaw({ signature: opaque, isMentioned: true }))
  assert(message.requesterId === opaque, 'opaque requester identity was rejected or rewritten')
  assert(!opaque.startsWith('wxid_'), 'opaque fixture accidentally looks like a wxid')
}

async function testWireRequesterIdConsumedAsIs(): Promise<void> {
  const message = validMessage(groupRaw({
    signature: 'raw-signature',
    senderId: 'wire-sender',
    requesterId: 'wire-sender',
  }))
  assert(message.requesterId === 'wire-sender', 'wire requester id was not consumed verbatim')
  assert(message.senderId === 'wire-sender', 'wire sender id was not consumed verbatim')
}

async function testRawWxidNeverOverridesWireRequester(): Promise<void> {
  const message = validMessage(groupRaw({
    signature: 'raw-signature',
    senderId: 'wire-sender',
    requesterId: 'wire-sender',
  }))
  assert(message.requesterId !== 'self-wxid', 'raw wxid overwrote the wire requester id')
  assert(message.requesterId !== 'raw-signature', 'raw signature overwrote the wire requester id')
}

async function testNoRawFallbackForMissingWireRequester(): Promise<void> {
  const withoutRequester = omit(groupRaw({ signature: 'raw-signature' }), 'requesterId')
  const reason: string = invalidReason(withoutRequester)
  assert(reason !== 'SENDER_ID_MISSING', 'group identity fell back to the legacy sender derivation')
  assert(reason === 'GROUP_REQUESTER_IDENTITY_MISSING', `unexpected reason ${reason}`)
}

async function testSenderRequesterMismatchFailsClosed(): Promise<void> {
  assert(
    invalidReason(groupRaw({ senderId: 'sig-a', requesterId: 'sig-b' })) === 'GROUP_SENDER_REQUESTER_MISMATCH',
    'group sender/requester mismatch was not fail-closed',
  )
}

async function testRequesterMustDifferFromConversation(): Promise<void> {
  assert(
    invalidReason(groupRaw({ senderId: 'room-a@chatroom', requesterId: 'room-a@chatroom' })) ===
      'GROUP_REQUESTER_EQUALS_CONVERSATION',
    'requester equal to the conversation id was not fail-closed',
  )
}

async function testOutboundRecipientStaysConversation(): Promise<void> {
  const agent = new RecordingAgent('synthetic reply')
  const result = await runRawAgentPipeline(groupRaw({ signature: 'sig-a', isMentioned: true }), agent)
  assert(result.status === 'AGENT_RESULT', 'group mention did not reach the agent')
  assert(result.outboundCommand?.conversationId === 'room-a@chatroom', 'outbound recipient is not the conversation')
  assert(result.outboundCommand?.conversationId !== result.request.requesterId, 'outbound recipient became the requester')
  assert(result.outboundCommand?.conversationType === 'GROUP', 'outbound conversation type changed')
}

async function testNotMentionedDoesNotInvokeAgent(): Promise<void> {
  const agent = new RecordingAgent()
  const result = await runRawAgentPipeline(groupRaw({ isMentioned: false }), agent)
  assert(result.status === 'IGNORED', 'unmentioned group message was not ignored')
  assert(result.policy.reason === 'GROUP_MENTION_REQUIRED', 'unexpected ignore reason')
  assert(agent.requests.length === 0, 'unmentioned group message invoked the agent')
}

async function testMentionedInvokesAgentOnce(): Promise<void> {
  const agent = new RecordingAgent()
  const result = await runRawAgentPipeline(groupRaw({ isMentioned: true }), agent)
  assert(result.status === 'AGENT_RESULT', 'mentioned group message did not reach the agent')
  assert(agent.requests.length === 1, 'mentioned group message did not invoke the agent exactly once')
  assert(agent.requests[0].mentionState === 'MENTIONED', 'mention state was not carried')
}

async function testSelfEchoCreatesNoRequesterTurn(): Promise<void> {
  // The self-echo drop happens in the C# ingress before the transport, so the
  // Agent never sees a self message. This asserts the Agent contract has no
  // self-turn concept and no identity field for it.
  const request = toAgentRequest(validMessage(groupRaw({ isMentioned: true })))
  assert(!Object.hasOwn(request, 'isSelf'), 'agent request gained a self flag')
  assert(!Object.hasOwn(request, 'ownerId'), 'agent request gained an owner field')

  const agent = new RecordingAgent()
  const ignored = await runRawAgentPipeline(groupRaw({ isMentioned: false }), agent)
  assert(ignored.status === 'IGNORED' && agent.requests.length === 0, 'a non-admitted message created an agent turn')
}

async function testReasoningBoundaryUnchanged(): Promise<void> {
  const agent = new RecordingAgent('<think>internal reasoning</think>final answer')
  const result = await runRawAgentPipeline(groupRaw({ isMentioned: true }), agent)
  assert(result.status === 'AGENT_RESULT', 'group mention did not reach the agent')
  assert(result.agentResult.kind === 'SUCCESS_TEXT', 'reasoning-only response was not mapped')
  assert(result.outboundCommand?.text === 'final answer', 'reasoning leaked into the outbound text')
}

async function testRequesterLogIsTokenized(): Promise<void> {
  const lines: string[] = []
  const observation = logRequesterIdentity(
    {
      conversationType: 'GROUP',
      source: 'Signature',
      senderId: 'sig-a',
      requesterId: 'sig-a',
      conversationId: 'room-a@chatroom',
    },
    (line) => lines.push(line),
  )

  assert(lines.length === 1, 'requester log was not emitted exactly once')
  const line = lines[0]
  assert(line.startsWith('[REQUESTER_IDENTITY]'), 'requester log tag changed')
  assert(line.includes('conversationType=GROUP'), 'requester log lost the conversation type')
  assert(line.includes('source=Signature'), 'requester log lost the identity source')
  assert(line.includes('senderRequesterMatch=true'), 'requester log lost the sender/requester fact')
  assert(line.includes('conversationRequesterSeparated=true'), 'requester log lost the separation fact')
  assert(line.includes('result=PASS'), 'requester log did not report PASS')
  assert(!line.includes('sig-a'), 'requester log leaked the raw requester identity')
  assert(!line.includes('room-a@chatroom'), 'requester log leaked the raw conversation identity')
  assert(!line.includes('self-wxid'), 'requester log leaked the raw account identity')
  assert(/senderToken=[0-9A-F]{12}/.test(line), 'sender token is not a 12 hex token')
  assert(observation.senderToken === observation.requesterToken, 'equal identities produced different tokens')
  assert(formatRequesterIdentity(observation) === line, 'formatted log is not stable')
}

async function testRequesterLogResultSemantics(): Promise<void> {
  const base: RequesterIdentityFields = {
    conversationType: 'GROUP',
    source: 'Signature',
    senderId: 'sig-a',
    requesterId: 'sig-a',
    conversationId: 'room-a@chatroom',
  }
  assert(observeRequesterIdentity(base).result === 'PASS', 'consistent group identity was not PASS')
  assert(
    observeRequesterIdentity({ ...base, requesterId: 'sig-b' }).result === 'FAIL',
    'sender/requester mismatch was not FAIL',
  )
  assert(
    observeRequesterIdentity({ ...base, requesterId: 'room-a@chatroom' }).result === 'FAIL',
    'requester equal to the conversation was not FAIL',
  )
  assert(
    observeRequesterIdentity({ ...base, requesterId: '', senderId: '' }).result === 'FAIL',
    'missing identity was not FAIL',
  )
  assert(
    observeRequesterIdentity({ ...base, conversationType: 'DIRECT', source: 'DIRECT_IDENTITY_UNVERIFIED' }).result ===
      'UNVERIFIED',
    'direct identity was not marked UNVERIFIED',
  )
}

async function testObserverCannotChangeIdentity(): Promise<void> {
  const lines: string[] = []
  const previous = process.env[IDENTITY_OBSERVE_ENV]
  process.env[IDENTITY_OBSERVE_ENV] = '1'
  try {
    const raw = groupRaw({ signature: 'sig-a', isMentioned: true })
    const observation = observeRawInbound(raw, (line) => lines.push(line))
    assert(observation !== null, 'observer did not run when enabled')
    assert(lines.length === 1 && lines[0].startsWith('[IDENTITY_OBSERVE]'), 'observer log tag changed')

    const agent = new RecordingAgent('reply')
    const result = await runRawAgentPipeline(raw, agent)
    assert(result.status === 'AGENT_RESULT', 'enabling the observer changed the pipeline result')
    assert(result.request.requesterId === 'sig-a', 'enabling the observer changed the requester identity')
    assert(result.outboundCommand?.conversationId === 'room-a@chatroom', 'enabling the observer changed the recipient')

    const ignored = await runRawAgentPipeline(groupRaw({ isMentioned: false }), new RecordingAgent())
    assert(ignored.status === 'IGNORED', 'enabling the observer changed the mention gate')
  } finally {
    if (previous === undefined) {
      delete process.env[IDENTITY_OBSERVE_ENV]
    } else {
      process.env[IDENTITY_OBSERVE_ENV] = previous
    }
  }
}

const cases: Array<[string, () => Promise<void>]> = [
  ['group-signature-a-is-requester', testGroupSenderAIsRequester],
  ['group-signature-b-is-requester', testGroupSenderBIsRequester],
  ['same-wxid-different-signature-stays-distinct', testSameWxidDifferentSignatureStaysDistinct],
  ['same-signature-across-conversations-keeps-requester', testSameSignatureAcrossConversationsKeepsRequester],
  ['missing-group-identity-fails-closed', testMissingGroupIdentityFailsClosed],
  ['whitespace-group-identity-fails-closed', testWhitespaceGroupIdentityFailsClosed],
  ['opaque-requester-id-accepted', testOpaqueRequesterIdAccepted],
  ['wire-requester-id-consumed-as-is', testWireRequesterIdConsumedAsIs],
  ['raw-wxid-never-overrides-wire-requester', testRawWxidNeverOverridesWireRequester],
  ['no-raw-fallback-for-missing-wire-requester', testNoRawFallbackForMissingWireRequester],
  ['sender-requester-mismatch-fails-closed', testSenderRequesterMismatchFailsClosed],
  ['requester-must-differ-from-conversation', testRequesterMustDifferFromConversation],
  ['outbound-recipient-stays-conversation', testOutboundRecipientStaysConversation],
  ['not-mentioned-does-not-invoke-agent', testNotMentionedDoesNotInvokeAgent],
  ['mentioned-invokes-agent-once', testMentionedInvokesAgentOnce],
  ['self-echo-creates-no-requester-turn', testSelfEchoCreatesNoRequesterTurn],
  ['reasoning-boundary-unchanged', testReasoningBoundaryUnchanged],
  ['requester-log-is-tokenized', testRequesterLogIsTokenized],
  ['requester-log-result-semantics', testRequesterLogResultSemantics],
  ['observer-cannot-change-identity', testObserverCannotChangeIdentity],
]

let failures = 0
for (const [name, testCase] of cases) {
  try {
    await testCase()
    console.log(`[REQUESTER_IDENTITY_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.error(
      `[REQUESTER_IDENTITY_CASE] name=${name} result=FAIL message=${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

console.log(`[REQUESTER_IDENTITY_TEST_SUMMARY] cases=${cases.length} failures=${failures}`)
if (failures > 0) {
  process.exitCode = 1
}
