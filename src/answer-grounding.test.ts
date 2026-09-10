/**
 * Runtime-fact grounding and internal-label redaction tests.
 *
 * Two field-visible defects are covered here:
 *  A. the reply model answered "你是 MEMBER_1": a conversation-stable speaker
 *     pseudonym is provider-facing bookkeeping and must never reach a WeChat user;
 *  B. the reply model explained its own memory ("我的上下文记忆就是当前窗口",
 *     "关掉对话就会忘记", "之前说的我都记得") although nothing in the runtime ever
 *     told it how long memory lives or what was retrieved.
 *
 * The suite runs the real production path (ProductionChatAgent -> ChatService ->
 * provider) with a stubbed provider, so the prompt a provider receives and the
 * final answer a group would receive are both inspected as they really are.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRawAgentPipeline, toAgentRequest } from './agent-adapter.js'
import {
  guardFinalAnswer,
  MIN_INTERNAL_VALUE_LENGTH,
  type AnswerGuardFacts,
} from './answer-guard.js'
import { buildSystemPrompt, buildUserPrompt, ChatService, runtimeFacts } from './chat.js'
import { MemoryExtractor } from './memory-extractor.js'
import type { MemoryScopeType } from './memory-models.js'
import { MemoryService } from './memory-service.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'
import { normalizeRawHookMessage, type InboundMessage, type RawHookMessage } from './message-contract.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import { isInternalSpeakerLabel } from './speaker-labels.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

// --------------------------------------------------------------- test harness

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-answer-grounding-'))
  temporaryDirectories.push(directory)
  return directory
}

function cleanup(): void {
  for (const directory of temporaryDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Temp cleanup must never fail the suite.
    }
  }
}

function sequentialIds(): () => string {
  let counter = 0
  return () => {
    counter += 1
    return `mem-${counter.toString().padStart(4, '0')}`
  }
}

function groupRaw(overrides: Partial<RawHookMessage> = {}): RawHookMessage {
  const from = overrides.from ?? 'room-a@chatroom'
  const signature = overrides.signature ?? 'sig-a'
  const senderId = overrides.senderId ?? signature
  return {
    msgId: 'grounding-message-1',
    type: 1,
    timestamp: 1_757_000_000_000,
    from,
    wxid: 'shared-account-wxid',
    content: '@椰椰 你好',
    signature,
    senderName: 'Sender One',
    isMentioned: true,
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

interface ProviderAnswer {
  content: string
  reasoning?: string
}

interface ProviderCall {
  system: string
  user: string
}

interface ProviderStub {
  calls: ProviderCall[]
  restore(): void
}

/** A deterministic OpenAI-compatible endpoint; nothing ever leaves the process. */
function stubProvider(answers: readonly ProviderAnswer[]): ProviderStub {
  const calls: ProviderCall[] = []
  const original = globalThis.fetch
  const stub = async (_url: unknown, init?: { body?: unknown }): Promise<unknown> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role: string; content: string }>
    }
    const messages = body.messages ?? []
    calls.push({ system: messages[0]?.content ?? '', user: messages[1]?.content ?? '' })

    const answer = answers[Math.min(calls.length - 1, answers.length - 1)] ?? { content: '' }
    const message: Record<string, unknown> = { role: 'assistant', content: answer.content }
    if (answer.reasoning !== undefined) {
      message.reasoning_content = answer.reasoning
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }] }) }
  }
  globalThis.fetch = stub as unknown as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

interface TurnOptions {
  conversationId?: string
  signature?: string
  role?: 'OWNER' | 'MEMBER'
  text?: string
  msgId?: string
  isMentioned?: boolean
  ownerDisplayName?: string
}

interface Fixture {
  agent: ProductionChatAgent
  provider: ProviderStub
  store: MemoryStore | null
  service: MemoryService | null
  asks: number
  ask(options?: TurnOptions): Promise<string>
  restore(): void
}

/**
 * One production Agent for a whole conversation, talking to a stubbed provider.
 * The speaker-label registry and the recent-context store live for the session,
 * exactly as in production.
 */
function createFixture(options: { answers: readonly ProviderAnswer[]; withMemory?: boolean }): Fixture {
  const provider = stubProvider(options.answers)
  const chatService = new ChatService('https://provider.invalid/v1', 'test-key', 'test-model')

  let store: MemoryStore | null = null
  let service: MemoryService | null = null
  if (options.withMemory === true) {
    store = new MemoryStore({ filePath: memoryFileIn(tempDir()), log: () => {}, pathSource: 'TEST' })
    service = new MemoryService({
      store,
      extractor: new MemoryExtractor(async () => '[]'),
      mutate: async () => '{"operation":"NONE"}',
      idFactory: sequentialIds(),
      log: () => {},
    })
  }

  const agent = new ProductionChatAgent(chatService, { memory: service })
  const fixture: Fixture = {
    agent,
    provider,
    store,
    service,
    asks: 0,
    async ask(turn: TurnOptions = {}) {
      fixture.asks += 1
      const raw = groupRaw({
        from: turn.conversationId ?? 'room-a@chatroom',
        conversationId: turn.conversationId ?? 'room-a@chatroom',
        signature: turn.signature ?? 'sig-a',
        msgId: turn.msgId ?? `grounding-message-${fixture.asks}`,
        content: turn.text ?? '@椰椰 你好',
        isMentioned: turn.isMentioned ?? true,
        requesterRole: turn.role ?? 'MEMBER',
        ownerConfigured: (turn.role ?? 'MEMBER') === 'OWNER',
        ownerDisplayName: turn.ownerDisplayName,
      })
      return agent.complete(toAgentRequest(validMessage(raw)))
    },
    restore: () => {
      provider.restore()
      service?.close()
    },
  }
  return fixture
}

function validMessage(input: RawHookMessage): InboundMessage {
  const result = normalizeRawHookMessage(input)
  assert(result.status === 'VALID', `expected VALID, got ${result.status}`)
  return result.message
}

function seed(
  store: MemoryStore,
  options: { scopeType: MemoryScopeType; scopeId: string; content: string },
): void {
  const status = store.add({
    memoryId: `seed-${options.scopeType}-${options.scopeId}-${options.content.length}`,
    scopeType: options.scopeType,
    scopeId: options.scopeId,
    content: options.content,
    contentHash: '',
    visibility: 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: 'room-a@chatroom',
    sourceSenderId: options.scopeId,
    createdAt: 1,
    updatedAt: 1,
    isDeleted: false,
  })
  assert(status === 'WRITTEN', `seed write failed: ${status}`)
}

/** The label the prompt declared as the current speaker. */
function declaredSpeakerLabel(prompt: string): string {
  return /CurrentSpeakerLabel=([^\s（]+)/u.exec(prompt)?.[1] ?? ''
}

/** The grounded runtime facts block, split into lines. */
function runtimeFactLines(prompt: string): string[] {
  const block = prompt.split('[Runtime Facts]\n')[1]?.split('\n\n')[0] ?? ''
  return block.split('\n').filter((line) => line.length > 0)
}

async function withCapturedLogs<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = []
  const original = console.log
  console.log = (...args: unknown[]): void => {
    logs.push(args.map((value) => String(value)).join(' '))
  }
  try {
    return { result: await run(), logs }
  } finally {
    console.log = original
  }
}

async function expectRefusal(run: () => Promise<unknown>, message: string): Promise<void> {
  let failed = false
  try {
    await run()
  } catch {
    failed = true
  }
  assert(failed, message)
}

// ------------------------------------------------------------------ the cases

/**
 * A. The requester is described, never labelled. `MEMBER_1` still does its job in
 * the transcript (it links the two turns to one speaker), but the group only ever
 * reads a natural reference.
 */
async function testCurrentSpeakerIsDescribedNotLabelled(): Promise<void> {
  const fixture = createFixture({
    answers: [{ content: '好，我记住了。' }, { content: '你是 MEMBER_1。' }],
  })
  try {
    await fixture.ask({ msgId: 'label-1', text: '@椰椰 我给你取名叫笨笨' })
    const reply = await fixture.ask({ msgId: 'label-2', text: '@椰椰 我是谁？' })

    const first = fixture.provider.calls[0]
    const second = fixture.provider.calls[1]
    assert(first !== undefined && second !== undefined, 'the provider was not called twice')
    const firstLabel = declaredSpeakerLabel(first.user)
    const currentLabel = declaredSpeakerLabel(second.user)
    assert(isInternalSpeakerLabel(currentLabel), `the label is not an internal pseudonym: ${currentLabel}`)
    assert(firstLabel === currentLabel, 'the same requester changed label between turns')
    assert(
      second.user.includes(`${currentLabel}：@椰椰 我给你取名叫笨笨`),
      'the prompt lost the turn where the requester named the bot',
    )

    const systemPrompt = buildSystemPrompt('椰椰')
    assert(
      systemPrompt.includes('最终回复里绝对不能出现这些标签'),
      'the system prompt does not forbid rendering internal labels',
    )
    assert(
      systemPrompt.includes('群里的另一位成员'),
      'the system prompt offers no natural way to speak about another member',
    )

    assert(!reply.includes(currentLabel), `the final answer leaked the internal label: ${reply}`)
    assert(reply.includes('正在和我说话的人'), `the reply is not a natural self-reference: ${reply}`)
    // Two turns, two provider calls: the label leak was rewritten locally and
    // never needed a re-generation.
    assert(fixture.provider.calls.length === 2, `a rewritable label leak needed an extra provider call: ${fixture.provider.calls.length}`)
  } finally {
    fixture.restore()
  }
}

/**
 * A2. Two members, one room. The current speaker is the second member, so the
 * first member's naming turn is never handed to them, and a draft that claims the
 * current speaker *is* the first member is refused instead of rewritten.
 */
async function testAnotherMemberIsNeverTheCurrentSpeaker(): Promise<void> {
  const fixture = createFixture({
    answers: [
      { content: '好。' },
      { content: '你就是 MEMBER_1，刚才给我取了名字。' },
      { content: '你是正在和我说话的那位，名字是你刚才给我取的。' },
    ],
  })
  try {
    await fixture.ask({ signature: 'sig-a', msgId: 'attr-1', text: '@椰椰 我给你取名叫笨笨' })
    const reply = await fixture.ask({ signature: 'sig-b', msgId: 'attr-2', text: '@椰椰 我是谁？' })

    const second = fixture.provider.calls[1]
    assert(second !== undefined, 'the second member turn never reached the provider')
    const otherLabel = declaredSpeakerLabel(fixture.provider.calls[0]?.user ?? '')
    const currentLabel = declaredSpeakerLabel(second.user)
    assert(otherLabel.length > 0 && currentLabel.length > 0, 'the prompt declared no speaker labels')
    assert(otherLabel !== currentLabel, 'two members share one speaker label')
    assert(
      second.user.includes(`${otherLabel}：@椰椰 我给你取名叫笨笨`),
      'the second member lost the earlier turn of the conversation',
    )
    assert(
      buildSystemPrompt('椰椰').includes('绝不能把别人的话、行为、称呼或记忆说成当前提问者的'),
      'the system prompt does not forbid attributing another member to the current requester',
    )

    // The conflating draft is a misattribution: nothing is sent, and it may be
    // re-generated once.
    const facts: AnswerGuardFacts = {
      currentSpeakerLabel: currentLabel,
      speakerLabels: [otherLabel, currentLabel],
    }
    const conflated = guardFinalAnswer(`你就是 ${otherLabel}，刚才给我取了名字。`, facts)
    assert(conflated.outcome === 'BLOCKED', `a conflating draft was accepted: ${conflated.outcome}`)
    assert(conflated.text === '', 'a conflating draft produced sendable text')
    assert(conflated.regenerable, 'a label conflation must stay regenerable')

    assert(fixture.provider.calls.length === 3, `the draft was not re-generated exactly once: ${fixture.provider.calls.length}`)
    assert(reply === '你是正在和我说话的那位，名字是你刚才给我取的。', `the safe rewrite was not sent: ${reply}`)
    assert(!reply.includes(otherLabel), 'the reply carries another member label')
  } finally {
    fixture.restore()
  }
}

/** B1. Nothing was retrieved: the prompt says so, and long-term claims are barred. */
async function testMemoryZeroForbidsLongTermClaims(): Promise<void> {
  const fixture = createFixture({ answers: [{ content: '当前提供给我的信息里没有找到。' }], withMemory: true })
  try {
    await fixture.ask({ msgId: 'zero-1', text: '@椰椰 你长期记得我的代号吗？' })
    const call = fixture.provider.calls[0]
    assert(call !== undefined, 'the provider was not called')
    assert(call.user.includes('RETRIEVED_MEMORY_COUNT=0'), 'the prompt does not state that nothing was retrieved')
    assert(call.user.includes('RETRIEVED_MEMORY_PRESENT=false'), 'retrieved memory presence is not stated')
    assert(call.user.includes('PERSISTENT_MEMORY_AVAILABLE=true'), 'the available persistent store is not stated')
    assert(call.user.includes('[Authorized Personal Memory]\n（无）'), 'an empty personal memory section is not explicit')
    assert(call.user.includes('[Authorized Group Memory]\n（无）'), 'an empty group memory section is not explicit')

    const systemPrompt = buildSystemPrompt('椰椰')
    assert(
      systemPrompt.includes('RETRIEVED_MEMORY_COUNT=0 时，不得声称任何具体内容来自长期记忆'),
      'the system prompt allows a long-term claim without retrieved memory',
    )
    assert(
      systemPrompt.includes('当前提供给我的信息里没有找到'),
      'the system prompt states no conservative answer for missing information',
    )
    assert(fixture.service?.recordCount === 0, 'the turn wrote memory')
  } finally {
    fixture.restore()
  }
}

/** B2. A retrieved codename may be answered, because the runtime really provided it. */
async function testRetrievedCodenameIsAnswerable(): Promise<void> {
  const fixture = createFixture({ answers: [{ content: '你的代号是 AlphaTest。' }], withMemory: true })
  try {
    assert(fixture.store !== null, 'the memory store is missing')
    seed(fixture.store, { scopeType: 'MEMBER', scopeId: 'sig-a', content: '用户代号是 AlphaTest' })

    const reply = await fixture.ask({ signature: 'sig-a', msgId: 'code-1', text: '@椰椰 我叫什么名字' })
    const call = fixture.provider.calls[0]
    assert(call !== undefined, 'the provider was not called')
    assert(call.user.includes('RETRIEVED_MEMORY_COUNT=1'), 'the retrieved memory count is wrong')
    assert(call.user.includes('RETRIEVED_MEMORY_PRESENT=true'), 'retrieved memory presence is not stated')
    assert(
      call.user.includes('[Authorized Personal Memory]\n- 用户代号是 AlphaTest'),
      'the retrieved codename did not reach the personal memory section',
    )
    assert(reply === '你的代号是 AlphaTest。', `a grounded codename answer was altered: ${reply}`)
  } finally {
    fixture.restore()
  }
}

/** B3. A codename that only exists in the current context is not long-term memory. */
async function testGroupContextCodenameIsNotMemory(): Promise<void> {
  const fixture = createFixture({ answers: [{ content: '你刚才说你的代号是 AlphaTest。' }], withMemory: true })
  try {
    await fixture.ask({ signature: 'sig-a', msgId: 'ctx-1', text: '@椰椰 我的代号是 AlphaTest' })
    await fixture.ask({ signature: 'sig-a', msgId: 'ctx-2', text: '@椰椰 我的代号是什么' })

    const call = fixture.provider.calls[1]
    assert(call !== undefined, 'the second turn never reached the provider')
    assert(call.user.includes('我的代号是 AlphaTest'), 'the current context lost the codename')
    assert(call.user.includes('CURRENT_CONTEXT_PRESENT=true'), 'the provided context is not stated')
    assert(call.user.includes('RETRIEVED_MEMORY_COUNT=0'), 'the fixture retrieved memory')
    assert(call.user.includes('RETRIEVED_MEMORY_PRESENT=false'), 'retrieved memory was claimed although nothing was retrieved')

    const systemPrompt = buildSystemPrompt('椰椰')
    assert(
      systemPrompt.includes('只有当前 GroupContext 或 Retrieved Memory 里真实出现过的信息'),
      'the system prompt does not scope answers to what is actually provided',
    )
    assert(
      systemPrompt.includes('不得声称任何具体内容来自长期记忆'),
      'the system prompt allows attributing context content to long-term memory',
    )
  } finally {
    fixture.restore()
  }
}

/** B4. Retention is never invented: the runtime hands over facts, not a policy. */
async function testRetentionPolicyIsNeverInvented(): Promise<void> {
  const fixture = createFixture({ answers: [{ content: '我不能仅凭自己判断具体保存多久。' }], withMemory: true })
  try {
    await fixture.ask({ msgId: 'time-1', text: '@椰椰 今天天气不错' })
    await fixture.ask({ msgId: 'time-2', text: '@椰椰 你能记住多久？' })

    const call = fixture.provider.calls[1]
    assert(call !== undefined, 'the retention question never reached the provider')
    const facts = runtimeFactLines(call.user)
    assert(
      facts.map((line) => line.split('=')[0]).join(',') ===
        'SELF_IDENTITY_QUERY,CURRENT_CONTEXT_PRESENT,RETRIEVED_MEMORY_PRESENT,RETRIEVED_MEMORY_COUNT,PERSISTENT_MEMORY_AVAILABLE,RETENTION_POLICY_PROVIDED',
      `the runtime fact block changed shape: ${facts.join(' | ')}`,
    )
    assert(facts[0] === 'SELF_IDENTITY_QUERY=false', 'the identity-query fact is wrong')
    assert(facts[1] === 'CURRENT_CONTEXT_PRESENT=true', 'the provided context is not stated')
    assert(facts[2] === 'RETRIEVED_MEMORY_PRESENT=false', 'retrieved memory was claimed although nothing was retrieved')
    assert(facts[3] === 'RETRIEVED_MEMORY_COUNT=0', 'the retrieved memory count is wrong')
    assert(facts[4] === 'PERSISTENT_MEMORY_AVAILABLE=true', 'the available persistent store is not stated')
    assert(facts[5] === 'RETENTION_POLICY_PROVIDED=false', 'a retention policy was invented')
    for (const line of facts) {
      assert(
        !/\d+\s*(分钟|小时|天|条|token)/iu.test(line),
        `a retention number reached the prompt: ${line}`,
      )
    }

    const systemPrompt = buildSystemPrompt('椰椰')
    assert(systemPrompt.includes('RETENTION_POLICY_PROVIDED=false'), 'the system prompt ignores the retention fact')
    assert(systemPrompt.includes('不能自行判断'), 'the system prompt states no conservative retention answer')
    assert(systemPrompt.includes('不要声称「关闭聊天窗口就会忘记」'), 'the window claim is not forbidden')
    assert(systemPrompt.includes('「我会永远记得」'), 'the permanent-memory claim is not forbidden')
    assert(systemPrompt.includes('「所有聊天我都记得」'), 'the everything-remembered claim is not forbidden')
    assert(!/\d+\s*(分钟|小时|天|条)/u.test(systemPrompt), 'the system prompt states a retention number')
    assert(runtimeFacts([], {
      botDisplayName: '椰椰',
      mention: 'MENTIONED',
      requesterRole: 'MEMBER',
      ownerConfigured: false,
      persistentMemoryAvailable: false,
    }).includes('PERSISTENT_MEMORY_AVAILABLE=false'), 'the disabled store is not reported as unavailable')
  } finally {
    fixture.restore()
  }
}

/** A3/B5. The guard itself: internal vocabulary never leaves the Agent. */
async function testInternalLabelIsNeverSentVerbatim(): Promise<void> {
  const facts: AnswerGuardFacts = { currentSpeakerLabel: 'MEMBER_2', speakerLabels: ['MEMBER_1', 'MEMBER_2'] }

  const current = guardFinalAnswer('你是 MEMBER_2。', facts)
  assert(current.outcome === 'REWRITTEN', `the current label draft was not rewritten: ${current.outcome}`)
  assert(!current.text.includes('MEMBER_2'), 'the rewrite still carries the current speaker label')
  assert(current.text.includes('正在和我说话的人'), `the rewrite is not a natural self-reference: ${current.text}`)

  const other = guardFinalAnswer('MEMBER_1 刚才说他要叫笨笨。', facts)
  assert(other.outcome === 'REWRITTEN', `an other-member draft was not rewritten: ${other.outcome}`)
  assert(!other.text.includes('MEMBER_1'), 'the rewrite still carries another member label')

  const unregistered = guardFinalAnswer('编号 MEMBER_7 是别人。', facts)
  assert(unregistered.outcome === 'REWRITTEN', 'an unregistered label pattern was not rewritten')
  assert(!unregistered.text.includes('MEMBER_7'), 'the rewrite still carries an unregistered label')

  const field = guardFinalAnswer('CurrentSpeakerLabel=MEMBER_2，所以你就是当前提问者。', facts)
  assert(field.outcome === 'REWRITTEN', `a field-name draft was not rewritten: ${field.outcome}`)
  assert(!field.text.includes('CurrentSpeakerLabel'), 'the rewrite still carries a runtime field name')
  assert(!field.text.includes('MEMBER_2'), 'the rewrite still carries the label')

  const bareField = guardFinalAnswer('我按 CurrentSpeakerLabel 判断的。', facts)
  assert(bareField.outcome === 'BLOCKED' && bareField.text === '', 'a bare runtime field name was sent')
  assert(bareField.regenerable, 'a bare field name should stay regenerable')

  const rawValue = 'requester-sig-9'
  const raw = guardFinalAnswer(`你的内部编号是 ${rawValue}。`, { internalValues: [rawValue] })
  assert(raw.outcome === 'BLOCKED' && raw.text === '', 'a raw runtime value was sent')
  assert(!raw.regenerable, 'a raw runtime value draft must never be handed back to a provider')

  const shortValue = guardFinalAnswer('s 只是普通文字。', { internalValues: ['s'] })
  assert(shortValue.outcome === 'CLEAN', 'a value too short to be an identifier rewrote ordinary text')

  const english = guardFinalAnswer('成员 member 这个词只是英文单词。', facts)
  assert(english.outcome === 'CLEAN', 'a lowercase english word was treated as a speaker label')

  const ordinary = guardFinalAnswer('你好，我是椰椰。')
  assert(ordinary.outcome === 'CLEAN' && ordinary.text === '你好，我是椰椰。', 'ordinary text was altered')
  const empty = guardFinalAnswer('')
  assert(empty.outcome === 'BLOCKED' && empty.text === '', 'an empty draft was reported as sendable')
}

/** The FINAL_ANSWER boundary keeps working underneath the new guard. */
async function testFinalAnswerBoundaryUnchanged(): Promise<void> {
  const inline = createFixture({ answers: [{ content: '<think>内部推理：他在问我是谁。</think>你好，我是椰椰。' }] })
  try {
    const reply = await inline.ask({ msgId: 'boundary-1', text: '@椰椰 你好' })
    assert(reply === '你好，我是椰椰。', `the FINAL_ANSWER boundary regressed: ${reply}`)
    assert(!reply.includes('推理'), 'reasoning leaked into the reply')
  } finally {
    inline.restore()
  }

  const reasoningOnly = createFixture({ answers: [{ content: '', reasoning: '内部推理' }] })
  try {
    await expectRefusal(
      () => reasoningOnly.ask({ msgId: 'boundary-2', text: '@椰椰 你好' }),
      'a reasoning-only answer was accepted as a reply',
    )
  } finally {
    reasoningOnly.restore()
  }

  const unterminated = createFixture({ answers: [{ content: '你好<think>没有闭合的推理' }] })
  try {
    await expectRefusal(
      () => unterminated.ask({ msgId: 'boundary-3', text: '@椰椰 你好' }),
      'an unterminated thinking tag was sent',
    )
  } finally {
    unterminated.restore()
  }

  // The group recipient contract is untouched by the answer guard.
  const recipient = createFixture({ answers: [{ content: '群回复' }] })
  try {
    const raw = groupRaw({ from: 'room-z@chatroom', conversationId: 'room-z@chatroom', msgId: 'boundary-4' })
    const result = await runRawAgentPipeline(raw, recipient.agent)
    assert(result.status === 'AGENT_RESULT', 'the mentioned group message did not reach the agent')
    assert(result.outboundCommand?.conversationType === 'GROUP', 'the group recipient type changed')
    assert(result.outboundCommand?.conversationId === 'room-z@chatroom', 'the group recipient id changed')
    assert(result.outboundCommand?.text === '群回复', 'the reply text changed')
  } finally {
    recipient.restore()
  }
}

/** A raw requester id echoed by a provider never reaches a group or a provider. */
async function testRawIdentityEchoIsNeverSent(): Promise<void> {
  const rawValue = 'requester-sig-9'
  assert(rawValue.length >= MIN_INTERNAL_VALUE_LENGTH, 'the fixture value is too short to be an internal value')

  const fixture = createFixture({ answers: [{ content: `你的内部编号是 ${rawValue}，我记住了。` }] })
  try {
    const { logs } = await withCapturedLogs(async () => {
      await expectRefusal(
        () => fixture.ask({ signature: rawValue, msgId: 'raw-1', text: '@椰椰 我是谁？' }),
        'a raw requester id echo was sent to the group',
      )
    })
    assert(fixture.provider.calls.length === 1, 'a draft carrying a raw value was handed back to a provider')
    for (const call of fixture.provider.calls) {
      assert(!call.system.includes(rawValue), 'a raw identity value reached the provider system prompt')
      assert(!call.user.includes(rawValue), 'a raw identity value reached the provider user prompt')
    }
    const text = logs.join('\n')
    assert(!text.includes(rawValue), 'a raw identity value reached a log line')
    assert(text.includes('outcome=BLOCKED'), 'the guard refusal was not reported')
  } finally {
    fixture.restore()
  }
}

/**
 * D. End-to-end counterpart of the label boundary: a two-member group where the
 * provider answers in runtime vocabulary. Neither the label of the member who is
 * speaking nor the label of the other member may survive into the outbound reply,
 * and the group still reads a well-formed sentence.
 *
 * The registry hands out labels in speaking order, so `sig-b` (the first speaker)
 * is `MEMBER_1` and the member asking in the second turn is `MEMBER_2`. The draft
 * below deliberately uses both labels the wrong way round — the current speaker's
 * label in a third-person clause and the other member's label in the question —
 * which is exactly how a provider would answer in runtime vocabulary.
 */
async function testNoInternalLabelReachesTheOutboundReply(): Promise<void> {
  const fixture = createFixture({
    answers: [
      { content: '好，我记住了。' },
      { content: '你好 MEMBER_1，刚才 MEMBER_2 问我叫什么。' },
    ],
  })
  try {
    await fixture.ask({ signature: 'sig-b', msgId: 'labels-1', text: '@椰椰 我的代号是 AlphaTest' })
    const raw = groupRaw({ signature: 'sig-a', msgId: 'labels-2', content: '@椰椰 我的代号是什么' })
    const result = await runRawAgentPipeline(raw, fixture.agent)
    assert(result.status === 'AGENT_RESULT', `the second turn did not reach the agent: ${result.status}`)

    const reply = result.outboundCommand?.text ?? ''
    assert(reply.length > 0, 'the labelled draft produced no outbound reply at all')

    // The transcript still used pseudonyms to tell the two members apart, so the
    // fixture proves something: the labels existed and were still not rendered.
    const second = fixture.provider.calls[1]
    assert(second !== undefined, 'the second turn never reached the provider')
    const declared = declaredSpeakerLabel(second.user)
    assert(isInternalSpeakerLabel(declared), `the prompt stopped using a pseudonym: ${declared}`)
    assert(declared === 'MEMBER_2', `the current speaker label changed: ${declared}`)
    assert(second.user.includes('MEMBER_1'), 'the other member was not labelled in the transcript')

    for (const label of ['MEMBER_1', 'MEMBER_2', declared]) {
      assert(!reply.includes(label), `the outbound reply leaked an internal label: ${reply}`)
    }
    for (const field of ['CurrentSpeakerLabel', 'RequesterId', 'SenderId', 'OwnerId']) {
      assert(!reply.includes(field), `the outbound reply leaked a runtime field name: ${reply}`)
    }
    assert(!reply.includes('sig-'), 'the outbound reply leaked a raw requester identity')
    assert(reply.includes('群里的另一位成员'), `the reply lost its natural third-person reference: ${reply}`)
    assert(reply.includes('你'), `the reply lost its natural self reference: ${reply}`)
    assert(!reply.includes('我和我'), `the rewrite produced a broken self reference: ${reply}`)

    // Rewriting is local: an internal label never costs a provider round trip.
    assert(
      fixture.provider.calls.length === 2,
      `a rewritable label leak needed an extra provider call: ${fixture.provider.calls.length}`,
    )
    assert(result.outboundCommand?.conversationType === 'GROUP', 'the reply changed conversation type')
  } finally {
    fixture.restore()
  }
}

/** No over-redaction: an ordinary answer and its CLEAN verdict are preserved. */
async function testOrdinaryAnswerIsUntouched(): Promise<void> {
  const fixture = createFixture({ answers: [{ content: '今天天气不错，你那边呢？' }] })
  const { result: reply, logs } = await withCapturedLogs(() => fixture.ask({ msgId: 'plain-1', text: '@椰椰 你好' }))
  try {
    assert(reply === '今天天气不错，你那边呢？', `an ordinary answer was altered: ${reply}`)
    assert(
      logs.some((line) => line.includes('[AGENT_ANSWER_GUARD]') && line.includes('outcome=CLEAN')),
      'an ordinary answer was not reported as CLEAN',
    )
    const guardLine = logs.find((line) => line.includes('[AGENT_ANSWER_GUARD]')) ?? ''
    assert(guardLine.includes('detections=NONE'), 'the guard reported a detection for ordinary text')
  } finally {
    fixture.restore()
  }
}

// ------------------------------------------------------------------ execution

const CASES: Array<[string, () => Promise<void>]> = [
  ['current-speaker-is-described-not-labelled', testCurrentSpeakerIsDescribedNotLabelled],
  ['another-member-is-never-the-current-speaker', testAnotherMemberIsNeverTheCurrentSpeaker],
  ['memory-zero-forbids-long-term-claims', testMemoryZeroForbidsLongTermClaims],
  ['retrieved-codename-is-answerable', testRetrievedCodenameIsAnswerable],
  ['group-context-codename-is-not-memory', testGroupContextCodenameIsNotMemory],
  ['retention-policy-is-never-invented', testRetentionPolicyIsNeverInvented],
  ['internal-label-is-never-sent-verbatim', testInternalLabelIsNeverSentVerbatim],
  ['final-answer-boundary-unchanged', testFinalAnswerBoundaryUnchanged],
  ['raw-identity-echo-is-never-sent', testRawIdentityEchoIsNeverSent],
  ['no-internal-label-reaches-the-outbound-reply', testNoInternalLabelReachesTheOutboundReply],
  ['ordinary-answer-is-untouched', testOrdinaryAnswerIsUntouched],
]

let failures = 0
for (const [name, run] of CASES) {
  try {
    await run()
    console.log(`[GROUNDING_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    const message = error instanceof Error ? error.message : String(error)
    console.log(`[GROUNDING_CASE] name=${name} result=FAIL message=${message}`)
  }
}

cleanup()
console.log(`[GROUNDING_TEST_SUMMARY] cases=${CASES.length} failures=${failures}`)
if (failures > 0) {
  console.log('[ANSWER_GROUNDING] result=FAIL')
  process.exitCode = 1
} else {
  console.log('[ANSWER_GROUNDING] result=PASS')
}
