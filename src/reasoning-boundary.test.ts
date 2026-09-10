import {
  mapAgentResponse,
  runRawAgentPipeline,
  toAgentRequest,
  toOutboundCommand,
  type AgentExecutor,
  type AgentPipelineResult,
  type AgentRequest,
} from './agent-adapter.js'
import { buildSystemPrompt, buildUserPrompt, requesterDisplayLabel } from './chat.js'
import { extractFinalAnswer, sanitizeFinalAnswer } from './final-answer.js'
import { normalizeRawHookMessage, type InboundMessage, type RawHookMessage } from './message-contract.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function raw(overrides: Partial<RawHookMessage> = {}): RawHookMessage {
  const from = overrides.from ?? 'room-a@chatroom'
  const isGroup = from.endsWith('@chatroom')
  const signature = overrides.signature ?? 'sender-1'
  const senderId = overrides.senderId ?? signature
  return {
    msgId: 'message-1',
    type: 1,
    timestamp: 1_757_000_000_000,
    from,
    wxid: 'room-a@chatroom',
    content: '@椰椰 你好',
    signature,
    senderName: 'Sender One',
    isMentioned: true,
    ...overrides,
    conversationType: overrides.conversationType ?? (isGroup ? 'GROUP' : 'DIRECT'),
    conversationId: overrides.conversationId ?? from,
    senderId: isGroup ? senderId : overrides.senderId,
    requesterId: isGroup ? overrides.requesterId ?? senderId : overrides.requesterId,
    requesterSource: overrides.requesterSource ?? (isGroup ? 'Signature' : undefined),
    requesterRole: overrides.requesterRole ?? (isGroup ? 'MEMBER' : undefined),
    ownerConfigured: overrides.ownerConfigured ?? (isGroup ? false : undefined),
  }
}

function validMessage(input: RawHookMessage): InboundMessage {
  const result = normalizeRawHookMessage(input)
  assert(result.status === 'VALID', `expected valid message, got ${result.status}`)
  return result.message
}

type AgentResultPipeline = Extract<AgentPipelineResult, { status: 'AGENT_RESULT' }>
type IgnoredPipeline = Extract<AgentPipelineResult, { status: 'IGNORED' }>

function assertAgentResult(result: AgentPipelineResult): asserts result is AgentResultPipeline {
  if (result.status !== 'AGENT_RESULT') {
    throw new Error(`expected AGENT_RESULT, got ${result.status}`)
  }
}

function assertIgnored(result: AgentPipelineResult): asserts result is IgnoredPipeline {
  if (result.status !== 'IGNORED') {
    throw new Error(`expected IGNORED, got ${result.status}`)
  }
}

function questionOf(request: AgentRequest): {
  senderId: string
  senderName: string
  text: string
  timestamp: number
} {
  return {
    senderId: request.senderId,
    senderName: requesterDisplayLabel(request),
    text: request.text,
    timestamp: request.timestamp,
  }
}

class ScriptedAgent implements AgentExecutor {
  public readonly requests: AgentRequest[] = []

  public constructor(
    private readonly script: (request: AgentRequest) => string | null | undefined,
  ) {}

  public async complete(request: AgentRequest): Promise<string | null | undefined> {
    this.requests.push(request)
    return this.script(request)
  }

  public get callCount(): number {
    return this.requests.length
  }
}

/** Case 1: reasoning_content and content both present -> only content is sent. */
async function testReasoningFieldIsNeverUsed(): Promise<void> {
  const extraction = extractFinalAnswer({
    role: 'assistant',
    content: '这是最终回答。',
    reasoning_content: '用户问的是……我要不要回答？',
  })
  assert(extraction.text === '这是最终回答。', 'content was not used as the final answer')
  assert(extraction.reasoningFields.includes('reasoning_content'), 'reasoning_content was not reported')
  assert(!extraction.text.includes('用户问'), 'reasoning leaked into the final answer')

  const agent = new ScriptedAgent(() => extraction.text)
  const result = await runRawAgentPipeline(raw(), agent)
  assertAgentResult(result)
  assert(result.outboundCommand?.text === '这是最终回答。', 'outbound text is not the final answer only')

  const siblings = extractFinalAnswer({ content: 'ok', reasoning: 'r', thinking: 't', analysis: 'a' })
  assert(siblings.text === 'ok', 'sibling reasoning fields changed the final answer')
  assert(siblings.reasoningFields.length === 3, 'reasoning carriers were not all reported')
}

/** Case 2: reasoning present, content empty -> nothing is sent (no fallback). */
async function testReasoningOnlyIsNeverSent(): Promise<void> {
  const emptyContent = extractFinalAnswer({ content: '', reasoning_content: '内部推理' })
  assert(emptyContent.text === '', 'empty content was replaced by reasoning')
  assert(emptyContent.contentPresent === true, 'empty content was not detected as present')
  assert(emptyContent.reasoningFields.includes('reasoning_content'), 'reasoning field was not reported')

  const missingContent = extractFinalAnswer({ reasoning_content: '内部推理' })
  assert(missingContent.text === '', 'missing content produced text')
  assert(missingContent.contentPresent === false, 'missing content was reported as present')

  const reasoningOnlyReply = '<think>内部推理，用户在 @ 我吗？</think>'
  const agent = new ScriptedAgent(() => reasoningOnlyReply)
  const result = await runRawAgentPipeline(raw(), agent)
  assertAgentResult(result)
  assert(result.agentResult.kind === 'NO_REPLY', 'reasoning-only reply was not refused')
  assert(result.outboundCommand === null, 'reasoning-only reply produced an outbound command')
  assert(mapAgentResponse(reasoningOnlyReply).kind === 'NO_REPLY', 'reasoning-only text was accepted')
  assert(
    toOutboundCommand(validMessage(raw()), { kind: 'SUCCESS_TEXT', text: reasoningOnlyReply }) === null,
    'outbound guard accepted reasoning-only text',
  )
}

/** Case 3: ordinary content is sent unchanged. */
async function testOrdinaryAnswerIsSent(): Promise<void> {
  const extraction = extractFinalAnswer({ content: '  你好，我是椰椰。  ' })
  assert(extraction.text === '你好，我是椰椰。', 'ordinary content was not trimmed and returned')
  assert(extraction.removedBlocks === 0, 'ordinary content was modified')

  const agent = new ScriptedAgent(() => '你好，我是椰椰。')
  const result = await runRawAgentPipeline(raw(), agent)
  assertAgentResult(result)
  assert(result.outboundCommand?.text === '你好，我是椰椰。', 'ordinary answer was not sent')
  assert(result.outboundCommand?.conversationType === 'GROUP', 'ordinary answer changed conversation type')

  const punctuation = sanitizeFinalAnswer('可以这样写：a < b 且 c > d，也可以说 2>1。')
  assert(punctuation.text === '可以这样写：a < b 且 c > d，也可以说 2>1。', 'ordinary punctuation was rewritten')
  assert(punctuation.unterminatedTag === false, 'ordinary punctuation looked like a thinking tag')
}

/** Case 4: a provider response carrying <think> never leaks to the group. */
async function testInlineThinkingBlockNeverLeaks(): Promise<void> {
  const providerContent = '<think>用户在 @ 椰椰，是不是 @ 我？</think>\n\n你好，我是椰椰。'
  const extraction = extractFinalAnswer({ role: 'assistant', content: providerContent })
  assert(extraction.text === '你好，我是椰椰。', 'inline thinking block was not removed')
  assert(extraction.removedBlocks === 1, 'inline thinking block was not counted')
  assert(!extraction.text.includes('think'), 'thinking markup survived extraction')

  const agent = new ScriptedAgent(() => providerContent)
  const result = await runRawAgentPipeline(raw(), agent)
  assertAgentResult(result)
  const outbound = result.outboundCommand?.text ?? ''
  assert(outbound === '你好，我是椰椰。', 'pipeline leaked the thinking block')
  assert(!outbound.includes('think') && !outbound.includes('@ 我'), 'pipeline leaked reasoning text')

  const variants = [
    '<THINK>推理</THINK>答案',
    '<thinking>推理</thinking>答案',
    '<mm:think>推理</mm:think>答案',
    '</think>答案',
    '<think>推理一</think>答案<think>推理二</think>',
  ]
  for (const variant of variants) {
    const sanitized = sanitizeFinalAnswer(variant)
    assert(!/推理|think/i.test(sanitized.text), `variant leaked reasoning: ${variant}`)
  }

  const unterminated = extractFinalAnswer({ content: '答案<think>推理没有闭合' })
  assert(unterminated.text === '', 'unterminated thinking tag was sent')
  assert(unterminated.unterminatedTag === true, 'unterminated thinking tag was not reported')

  const once = sanitizeFinalAnswer(providerContent).text
  assert(sanitizeFinalAnswer(once).text === once, 'sanitizer is not idempotent')
}

/** Case 5: runtime mention state reaches the Agent context as an explicit fact. */
async function testRuntimeMentionFactReachesContext(): Promise<void> {
  const request = toAgentRequest(validMessage(raw({ isMentioned: true })))
  assert(request.mentionState === 'MENTIONED', 'runtime mention state was not carried into the request')

  const question = questionOf(request)
  const prompt = buildUserPrompt([question], question, {
    botDisplayName: '椰椰',
    mention: request.mentionState,
    requesterRole: request.requesterRole,
    ownerConfigured: request.ownerConfigured,
  })
  assert(prompt.includes('CurrentBotMentioned=true'), 'user prompt does not state the mention fact')
  assert(!prompt.includes('CurrentRequesterRole=MEMBER'), 'user prompt exposed the trusted role fact')
  assert(!prompt.includes('OwnerConfigured=false'), 'user prompt exposed the owner-configured fact')
  assert(prompt.includes('@椰椰 你好'), 'user prompt lost the question text')

  const systemPrompt = buildSystemPrompt('椰椰')
  assert(systemPrompt.includes('椰椰'), 'system prompt does not state the bot display name')
  assert(systemPrompt.includes('CurrentBotMentioned'), 'system prompt does not reference the mention fact')
  assert(systemPrompt.includes('授权角色'), 'system prompt does not define authorization-role semantics')
}

/** Case 6: the Agent must not re-decide whether the message mentioned it. */
async function testAgentDoesNotRejudgeMention(): Promise<void> {
  const systemPrompt = buildSystemPrompt('椰椰')
  assert(systemPrompt.includes('已由运行时判定'), 'system prompt does not say the runtime decided mention state')
  assert(systemPrompt.includes('不需要再从正文推断'), 'system prompt still invites re-deriving mention state')

  const notMentionedPrompt = buildUserPrompt(
    [],
    { senderId: 's', senderName: 'S', text: '今天天气如何', timestamp: 1 },
    { botDisplayName: '椰椰', mention: 'NOT_MENTIONED', requesterRole: 'MEMBER', ownerConfigured: false },
  )
  assert(notMentionedPrompt.includes('CurrentBotMentioned=false'), 'not-mentioned fact is missing')

  const directPrompt = buildUserPrompt(
    [],
    { senderId: 's', senderName: 'S', text: '你好', timestamp: 1 },
    { botDisplayName: '椰椰', mention: 'NOT_APPLICABLE', requesterRole: 'MEMBER', ownerConfigured: false },
  )
  assert(directPrompt.includes('CurrentBotMentioned=not_applicable'), 'direct mention fact is missing')

  const unknownState = validMessage(raw({ isMentioned: null }))
  assert(toAgentRequest(unknownState).mentionState === 'UNKNOWN', 'unknown mention state was not preserved')
}

/** Case 7: the GROUP recipient contract is untouched by the reply boundary. */
async function testGroupRecipientUnchanged(): Promise<void> {
  const agent = new ScriptedAgent(() => '<think>推理</think>群回复')
  const result = await runRawAgentPipeline(raw({ from: 'room-z@chatroom', msgId: 'm-z' }), agent)
  assertAgentResult(result)
  assert(result.outboundCommand?.conversationType === 'GROUP', 'group recipient type changed')
  assert(result.outboundCommand?.conversationId === 'room-z@chatroom', 'group recipient id changed')
  assert(result.outboundCommand?.text === '群回复', 'group reply text is not the final answer')

  // The mapping helper itself stays type preserving; DIRECT never reaches it from
  // the pipeline, because the admission policy refuses DIRECT first.
  const direct = validMessage(raw({ from: 'private-z', wxid: 'private-z', signature: '', isMentioned: null }))
  assert(
    toOutboundCommand(direct, { kind: 'SUCCESS_TEXT', text: '私聊回复' })?.conversationType === 'DIRECT',
    'direct recipient type changed',
  )
}

/** Case 8: the group no-mention gate is untouched by the reply boundary. */
async function testNoMentionGateUnchanged(): Promise<void> {
  const agent = new ScriptedAgent(() => '<think>推理</think>不应该被发送')
  const notMentioned = await runRawAgentPipeline(raw({ isMentioned: false }), agent)
  assertIgnored(notMentioned)
  assert(notMentioned.policy.reason === 'GROUP_MENTION_REQUIRED', 'unexpected ignore reason')
  assert(agent.callCount === 0, 'the agent was invoked for an unmentioned group message')

  const unknownMention = await runRawAgentPipeline(raw({ isMentioned: null }), agent)
  assertIgnored(unknownMention)
  assert(agent.callCount === 0, 'the agent was invoked for an uncertain mention state')

  const directAgent = new ScriptedAgent(() => '私聊回复')
  const direct = await runRawAgentPipeline(
    raw({ from: 'private-y', wxid: 'private-y', signature: '', isMentioned: null }),
    directAgent,
  )
  assertIgnored(direct)
  assert(direct.policy.reason === 'DIRECT_IDENTITY_UNVERIFIED', 'unexpected DIRECT ignore reason')
  assert(directAgent.callCount === 0, 'the agent was invoked for a DIRECT message')
}

const cases: Array<[string, () => Promise<void>]> = [
  ['reasoning-field-never-used', testReasoningFieldIsNeverUsed],
  ['reasoning-only-never-sent', testReasoningOnlyIsNeverSent],
  ['ordinary-answer-sent', testOrdinaryAnswerIsSent],
  ['inline-thinking-block-never-leaks', testInlineThinkingBlockNeverLeaks],
  ['runtime-mention-fact-reaches-context', testRuntimeMentionFactReachesContext],
  ['agent-does-not-rejudge-mention', testAgentDoesNotRejudgeMention],
  ['group-recipient-unchanged', testGroupRecipientUnchanged],
  ['no-mention-gate-unchanged', testNoMentionGateUnchanged],
]

let failures = 0
for (const [name, testCase] of cases) {
  try {
    await testCase()
    console.log(`[REASONING_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.error(
      `[REASONING_CASE] name=${name} result=FAIL message=${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

console.log(`[REASONING_TEST_SUMMARY] cases=${cases.length} failures=${failures}`)
console.log(`[REASONING_BOUNDARY] result=${failures === 0 ? 'PASS' : 'FAIL'}`)
if (failures > 0) {
  process.exitCode = 1
}
