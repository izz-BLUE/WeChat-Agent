/**
 * EXPLICIT_MEMORY_FIELD_SHAPE — the production-shaped regression for the field
 * bug: "@bot 记住我不吃香菜" was answered with "好嘞，记下了！" while the runtime
 * wrote nothing.
 *
 * WHY A SEPARATE SUITE. Every earlier explicit-memory test called
 * `tryHandleExplicit({ question: '记住我不吃香菜' })` with a clean, hand-written
 * body. That is not what the runtime delivers: the contract hands the raw WeChat
 * body through verbatim, and a real group mention carries `@` + the group display
 * name + U+2005 (FOUR-PER-EM SPACE) — a separator no keyboard can produce. Those
 * suites therefore proved the grammar and nothing about the wire, and the wire was
 * where admission failed.
 *
 * Every case here goes through the SAME stages production uses:
 *
 *   RawHookMessage -> normalizeRawHookMessage -> toAgentRequest
 *     -> ProductionChatAgent.complete -> canonicalUserText(spans)
 *     -> MemoryService.tryHandleExplicit -> the mutation structured completion
 *
 * and asserts on the exact OpenAI-compatible request bodies the provider received.
 * The bot's framing is identified by the RUNTIME's spans (`botMentionSpans`), never
 * by matching a name. Fixtures are synthetic: synthetic requester, synthetic group,
 * synthetic bot name, synthetic member name.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toAgentRequest } from './agent-adapter.js'
import {
  canonicalUserText,
  describeUserText,
  resolveBotMentionSpans,
  MENTION_SEPARATOR,
  type BotMentionSpan,
} from './canonical-user-text.js'
import { ChatService } from './chat.js'
import { GroupAmbientContext } from './group-ambient-context.js'
import { MemoryExtractor } from './memory-extractor.js'
import { isExplicitMemoryCommand, MemoryService } from './memory-service.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'
import { normalizeRawHookMessage, type RawHookMessage } from './message-contract.js'
import { ProductionChatAgent } from './production-agent-receiver.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

// --------------------------------------------------------------- test harness

/** Synthetic names: never a field name, and the separator is the runtime's real one. */
const BOT_NAME = '测试助手'
const MEMBER_NAME = '张三'
const BOT_TOKEN = `@${BOT_NAME}${MENTION_SEPARATOR}`
const MEMBER_TOKEN = `@${MEMBER_NAME}${MENTION_SEPARATOR}`
const ROOM = 'room-field-shape@chatroom'
const OWNER = 'requester-field-shape-owner'
const MEMBER = 'requester-field-shape-member'
const NAME_MEMORY = '我叫辞老师'
const NOW = 1_757_000_000_000

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-agent-field-shape-'))
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

/**
 * The spans the runtime would publish for a synthetic body: every bot token, and
 * nothing else. This is a stand-in for `LegacyMentionClassifier`, whose real
 * implementation is covered by the C# `BotMentionSpan` suite.
 */
function botSpansFor(text: string): BotMentionSpan[] {
  const spans: BotMentionSpan[] = []
  let index = text.indexOf(BOT_TOKEN)
  while (index >= 0) {
    spans.push({ start: index, length: BOT_TOKEN.length })
    index = text.indexOf(BOT_TOKEN, index + BOT_TOKEN.length)
  }
  return spans
}

interface ProviderCall {
  system: string
  user: string
}

function completion(content: string): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }),
  }
}

interface Harness {
  agent: ProductionChatAgent
  store: MemoryStore
  service: MemoryService
  finalCalls: ProviderCall[]
  mutationCalls: ProviderCall[]
  logs: string[]
  restore(): void
}

function createHarness(options: { mutate?: string; filePath?: string } = {}): Harness {
  const finalCalls: ProviderCall[] = []
  const mutationCalls: ProviderCall[] = []
  const logs: string[] = []
  const mutateResponse = options.mutate ?? '{"operation":"NONE","target":null,"content":null,"scope":null}'

  const originalLog = console.log
  console.log = (message?: unknown) => {
    logs.push(typeof message === 'string' ? message : String(message))
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role: string; content: string }>
    }
    const messages = body.messages ?? []
    const system = messages[0]?.content ?? ''
    const user = messages[1]?.content ?? ''
    if (system.includes('记忆变更解析器')) {
      mutationCalls.push({ system, user })
      return completion(mutateResponse)
    }
    finalCalls.push({ system, user })
    return completion('收到。')
  }) as unknown as typeof fetch

  const store = new MemoryStore({
    filePath: options.filePath ?? memoryFileIn(tempDir()),
    log: (message) => logs.push(message),
    pathSource: 'TEST',
  })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: (system, user) => new ChatService('https://provider.invalid/v1', 'k', 'm').completeStructured(system, user),
    log: (message) => logs.push(message),
  })
  const ambient = new GroupAmbientContext({ sink: undefined, now: () => NOW })
  const agent = new ProductionChatAgent(
    new ChatService('https://provider.invalid/v1', 'k', 'm'),
    { memory: service, ambientContext: ambient },
  )

  return {
    agent,
    store,
    service,
    finalCalls,
    mutationCalls,
    logs,
    restore: () => {
      globalThis.fetch = originalFetch
      console.log = originalLog
    },
  }
}

function groupRaw(overrides: Partial<RawHookMessage> = {}): RawHookMessage {
  const signature = overrides.signature ?? OWNER
  const senderId = overrides.senderId ?? signature
  return {
    msgId: 'field-shape-1',
    type: 1,
    timestamp: NOW,
    from: ROOM,
    wxid: 'shared-account-synthetic',
    content: `${BOT_TOKEN}你好`,
    signature,
    senderName: 'Synthetic Sender',
    isMentioned: true,
    ...overrides,
    conversationType: overrides.conversationType ?? 'GROUP',
    conversationId: overrides.conversationId ?? ROOM,
    senderId,
    requesterId: overrides.requesterId ?? senderId,
    requesterSource: overrides.requesterSource ?? 'Signature',
    requesterRole: overrides.requesterRole ?? 'OWNER',
    ownerConfigured: overrides.ownerConfigured ?? true,
  }
}

/** One production turn: contract -> normalization -> agent, exactly as the transport drives it. */
async function ask(
  harness: Harness,
  options: { content: string; msgId: string; role?: 'OWNER' | 'MEMBER'; spans?: BotMentionSpan[] | null },
): Promise<string> {
  const role = options.role ?? 'OWNER'
  const raw = groupRaw({
    msgId: options.msgId,
    content: options.content,
    signature: role === 'OWNER' ? OWNER : MEMBER,
    requesterRole: role,
    ownerConfigured: role === 'OWNER',
    botMentionSpans: options.spans === undefined ? botSpansFor(options.content) : options.spans,
  })
  const normalized = normalizeRawHookMessage(raw)
  assert(normalized.status === 'VALID', `the synthetic contract message was rejected: ${normalized.status}`)
  assert(normalized.message.text === options.content, 'the contract layer altered the raw body')
  return harness.agent.complete(toAgentRequest(normalized.message))
}

function admissionLine(harness: Harness): string {
  return harness.logs.filter((line) => line.includes('[MEMORY_ADMISSION]')).pop() ?? ''
}

/** Real stdout: the harness patches `console.log` for the case body. */
const realLog = console.log.bind(console)

function reportAdmission(label: string, harness: Harness): void {
  realLog(`[FIELD_SHAPE_ADMISSION] case=${label} ${admissionLine(harness)}`)
}

function finalCallCount(harness: Harness): number {
  return harness.finalCalls.length
}

function mutationCallCount(harness: Harness): number {
  return harness.mutationCalls.length
}

function fieldOf(line: string, name: string): string {
  return new RegExp(`${name}=([^\\s]+)`, 'u').exec(line)?.[1] ?? ''
}

function seedOwnerMemory(harness: Harness, content: string, memoryId = 'field-seed'): void {
  const status = harness.store.add({
    memoryId,
    scopeType: 'OWNER',
    scopeId: OWNER,
    content,
    contentHash: '',
    visibility: 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: ROOM,
    sourceSenderId: OWNER,
    createdAt: NOW,
    updatedAt: NOW,
    isDeleted: false,
  })
  assert(status === 'WRITTEN', `seed write failed: ${status}`)
}

// ------------------------------------------------------------ canonical text

/** The projection itself: only the runtime's spans are removed, nothing else. */
function testCanonicalProjection(): void {
  const botOnly = `${BOT_TOKEN}记住我不吃香菜`
  const memberOnly = `${MEMBER_TOKEN}你怎么看？`
  const mixed = `${MEMBER_TOKEN}你先看\n${BOT_TOKEN}你也说说`

  const cases: Array<[string, string, BotMentionSpan[], string]> = [
    ['bot token opens the body', botOnly, botSpansFor(botOnly), '记住我不吃香菜'],
    ['bot token alone on its own line', `${BOT_TOKEN}\n记住我不吃香菜`, botSpansFor(`${BOT_TOKEN}\n记住我不吃香菜`), '记住我不吃香菜'],
    ['trailing newline', `${BOT_TOKEN}记住我不吃香菜\n`, botSpansFor(`${BOT_TOKEN}记住我不吃香菜\n`), '记住我不吃香菜'],
    ['CRLF line endings', `${BOT_TOKEN}记住我不吃香菜\r\n`, botSpansFor(`${BOT_TOKEN}记住我不吃香菜\r\n`), '记住我不吃香菜'],
    ['token mid-sentence', `那件事 ${BOT_TOKEN}记住我不吃香菜`, botSpansFor(`那件事 ${BOT_TOKEN}记住我不吃香菜`), '那件事 记住我不吃香菜'],
    ['two bot tokens', `${BOT_TOKEN}记住我不吃香菜 ${BOT_TOKEN}`, botSpansFor(`${BOT_TOKEN}记住我不吃香菜 ${BOT_TOKEN}`), '记住我不吃香菜'],
    ['member mention is preserved', memberOnly, [], memberOnly],
    ['member mention survives beside a bot token', mixed, botSpansFor(mixed), `${MEMBER_TOKEN}你先看\n你也说说`],
    ['no claim leaves the body alone', memberOnly, [], memberOnly],
  ]
  for (const [name, raw, spans, expected] of cases) {
    const canonical = canonicalUserText(raw, resolveBotMentionSpans(raw, spans))
    assert(canonical === expected, `${name}: canonical="${canonical}", expected "${expected}"`)
  }

  // The member's mention is never removable: the claim covers only the bot token.
  const resolved = resolveBotMentionSpans(mixed, botSpansFor(mixed))
  assert(resolved.trust === 'VALID', `the synthetic claim was rejected: ${resolved.trust}`)
  assert(resolved.spans.length === 1, `expected one bot span, got ${resolved.spans.length}`)
  assert(
    mixed.slice(resolved.spans[0]!.start, resolved.spans[0]!.start + resolved.spans[0]!.length) === BOT_TOKEN,
    'the span does not cover the bot token',
  )
  assert(canonicalUserText(mixed, resolved).includes(MEMBER_NAME), 'the member mention was removed')

  // Absent and invalid claims both leave the text intact (newline normalization only).
  const absent = canonicalUserText(mixed, resolveBotMentionSpans(mixed, undefined))
  const invalid = canonicalUserText(mixed, resolveBotMentionSpans(mixed, [{ start: 0, length: 9999 }]))
  assert(absent === mixed, `an absent claim altered the text: ${absent}`)
  assert(invalid === mixed, `an invalid claim altered the text: ${invalid}`)

  const shape = describeUserText(mixed, resolved)
  assert(shape.lineCount === 2, `lineCount=${shape.lineCount}`)
  assert(shape.botMentionSpanCount === 1, `botMentionSpanCount=${shape.botMentionSpanCount}`)
  assert(shape.botMentionSpanValid, 'the claim was not reported as valid')
  assert(!shape.botMentionSpanAbsent, 'a present claim was reported as absent')
  assert(shape.canonicalized, 'the projection did not report that it changed the text')

  const absentShape = describeUserText(mixed, resolveBotMentionSpans(mixed, undefined))
  assert(absentShape.botMentionSpanAbsent, 'a missing claim was not reported as absent')

  // The gate stays anchored on the canonical text; framing is removed before it runs.
  assert(isExplicitMemoryCommand('记住我不吃香菜'), 'the canonical command form is not admitted')
  assert(
    !isExplicitMemoryCommand(canonicalUserText(memberOnly, resolveBotMentionSpans(memberOnly, []))),
    'a member-addressed sentence was read as a command',
  )
}

// ------------------------------------------------------- the field-shape cases

/** FIELD-SHAPE CASE 1: the real production shape reaches the mutation path. */
async function testFieldShapeExplicitRememberIsAdmitted(): Promise<void> {
  const shapes: Array<[string, string]> = [
    ['single line', `${BOT_TOKEN}记住我不吃香菜`],
    ['token alone on its own line', `${BOT_TOKEN}\n记住我不吃香菜`],
    ['padded first line', `\u200b\n${BOT_TOKEN}记住我不吃香菜`],
  ]
  for (const [name, content] of shapes) {
    const harness = createHarness()
    try {
      seedOwnerMemory(harness, NAME_MEMORY)

      await ask(harness, { content, msgId: `field-remember-${name.length}` })

      const admission = admissionLine(harness)
      reportAdmission(`admitted/${name}`, harness)
      assert(admission.includes('role=OWNER'), `${name}: the admission role is wrong: ${admission}`)
      assert(admission.includes('explicitCommand=true'), `${name}: the canonical command was not admitted: ${admission}`)
      assert(admission.includes('result=ADMITTED'), `${name}: admission did not report ADMITTED: ${admission}`)
      assert(admission.includes('botMentionSpanValid=true'), `${name}: the span claim was not trusted: ${admission}`)
      assert(admission.includes('botMentionSpanCount=1'), `${name}: the span count was not reported: ${admission}`)
      assert(admission.includes('mentionState=MENTIONED'), `${name}: the mention state was not reported: ${admission}`)

      assert(mutationCallCount(harness) === 1, `${name}: mutation provider calls=${mutationCallCount(harness)}`)
      assert(finalCallCount(harness) === 0, `${name}: final provider calls=${finalCallCount(harness)}`)
      assert(
        harness.mutationCalls[0]?.user.includes('记住我不吃香菜'),
        `${name}: the mutation prompt did not receive the canonical command`,
      )
      assert(
        !(harness.mutationCalls[0]?.user ?? '').includes(MENTION_SEPARATOR),
        `${name}: the mention separator reached the mutation prompt`,
      )
      assert(!admission.includes(MENTION_SEPARATOR), `${name}: the admission diagnostic carried framing`)
      assert(!admission.includes(BOT_NAME), `${name}: the admission diagnostic carried the mention name`)
      assert(!admission.includes(ROOM), `${name}: the admission diagnostic carried the conversation id`)
    } finally {
      harness.restore()
    }
  }
}

/**
 * FIELD-SHAPE BOUNDARY: framing the runtime identified is removed; a body that
 * carries OTHER content before the command does not become a command.
 *
 * This is the deliberate asymmetry, and the reason the fix is a projection plus an
 * anchored gate rather than a looser pattern.
 */
async function testFieldShapePrefixedContentStaysChat(): Promise<void> {
  const harness = createHarness()
  try {
    await ask(harness, { content: `顺便说一句\n${BOT_TOKEN}记住我不吃香菜`, msgId: 'field-prefixed-1' })

    const admission = admissionLine(harness)
    reportAdmission('boundary/prefixed-content', harness)
    assert(admission.includes('result=CHAT'), `a prefixed body was admitted: ${admission}`)
    assert(admission.includes('explicitCommand=false'), `a prefixed body reached the gate as a command: ${admission}`)
    assert(admission.includes('botMentionSpanValid=true'), `the span claim was not trusted: ${admission}`)
    assert(mutationCallCount(harness) === 0, 'a prefixed body entered the mutation path')
    assert(finalCallCount(harness) === 1, 'a prefixed body did not follow the ordinary chat path')
  } finally {
    harness.restore()
  }
}

/** FIELD-SHAPE CASE 2-4: bot-addressed ordinary chat stays chat. */
async function testFieldShapeNormalChatStaysChat(): Promise<void> {
  const cases: Array<[string, string]> = [
    ['recall', `${BOT_TOKEN}你记得不？`],
    ['ordinary forgetfulness', `${BOT_TOKEN}我忘记带钥匙了`],
    ['ordinary edit request', `${BOT_TOKEN}把接口改成 POST`],
    ['ordinary recall', `${BOT_TOKEN}还记得我吗？`],
  ]
  for (const [name, content] of cases) {
    const harness = createHarness()
    try {
      seedOwnerMemory(harness, NAME_MEMORY)

      const reply = await ask(harness, { content, msgId: `field-chat-${name.length}` })

      const admission = admissionLine(harness)
      reportAdmission(`chat/${name}`, harness)
      assert(admission.includes('result=CHAT'), `${name}: admission did not report CHAT: ${admission}`)
      assert(admission.includes('explicitCommand=false'), `${name}: the gate admitted ordinary chat: ${admission}`)
      assert(mutationCallCount(harness) === 0, `${name}: mutation provider calls=${mutationCallCount(harness)}`)
      assert(finalCallCount(harness) === 1, `${name}: final provider calls=${finalCallCount(harness)}`)
      assert(reply === '收到。', `${name}: the turn was swallowed: ${reply}`)

      const prompt = harness.finalCalls[0] as ProviderCall
      const canonical = canonicalUserText(content, resolveBotMentionSpans(content, botSpansFor(content)))
      assert(prompt.user.includes(canonical), `${name}: the canonical current request is missing from the prompt`)
      assert(!prompt.user.includes(MENTION_SEPARATOR), `${name}: the mention token reached the final prompt`)
      assert(prompt.user.includes(NAME_MEMORY), `${name}: the working set was lost`)
    } finally {
      harness.restore()
    }
  }
}

/** A MEMBER is not the owner, and the admission line says so out loud. */
async function testFieldShapeMemberIsNotAdmitted(): Promise<void> {
  const harness = createHarness()
  try {
    await ask(harness, { content: `${BOT_TOKEN}记住我不吃香菜`, msgId: 'field-member-1', role: 'MEMBER' })
    const admission = admissionLine(harness)
    assert(admission.includes('role=MEMBER'), `the member admission role is wrong: ${admission}`)
    assert(admission.includes('result=CHAT'), `a member command was admitted: ${admission}`)
    assert(mutationCallCount(harness) === 0, 'a member reached the owner-only mutation path')
    assert(finalCallCount(harness) === 1, 'a member command did not follow the ordinary chat path')
  } finally {
    harness.restore()
  }
}

// ---------------------------------------------------- real persistence (§7)

/**
 * The complete write path, through the wire shape: the mutation provider returns a
 * real ADD, and the assertions are on the STORE, not on a reply string.
 */
async function testFieldShapeExplicitAddPersists(): Promise<void> {
  const filePath = memoryFileIn(tempDir())
  const harness = createHarness({
    mutate: '{"operation":"ADD","target":null,"content":"我不吃香菜","scope":"OWNER"}',
    filePath,
  })
  try {
    const reply = await ask(harness, { content: `${BOT_TOKEN}记住我不吃香菜`, msgId: 'field-add-1' })
    assert(reply === '记住了。', `the explicit add did not report success: ${reply}`)

    const durable = harness.logs.join('\n')
    assert(
      /\[MEMORY_TRIGGER\] trigger=EXPLICIT_REMEMBER .*result=PASS/u.test(durable),
      'no EXPLICIT_REMEMBER PASS trigger was emitted',
    )
    assert(durable.includes('[MEMORY_WRITE]') && durable.includes('result=WRITTEN'), 'no MEMORY_WRITE WRITTEN event')
    assert(/\[MEMORY_STORE\] operation=SAVE result=PASS/u.test(durable), 'the store never persisted the write')
    assert(mutationCallCount(harness) === 1, `mutation provider calls=${mutationCallCount(harness)}`)
    assert(finalCallCount(harness) === 0, 'a successful memory write still reached the final chat model')

    const stored = harness.store.retrieve([{ scopeType: 'OWNER', scopeId: OWNER, visibility: 'SHARED' }], 10)
    assert(stored.length === 1, `expected exactly one stored record, got ${stored.length}`)
    assert(stored[0]?.content === '我不吃香菜', `the stored content is wrong: ${stored[0]?.content}`)
    assert(!(stored[0]?.content ?? '').includes(MENTION_SEPARATOR), 'framing was persisted as memory content')

    const followUp = await ask(harness, { content: `${BOT_TOKEN}我有什么忌口来着？`, msgId: 'field-add-2' })
    assert(followUp === '收到。', `the follow-up turn was swallowed: ${followUp}`)
    assert(finalCallCount(harness) === 1, `follow-up final provider calls=${finalCallCount(harness)}`)
    const prompt = harness.finalCalls[0] as ProviderCall
    assert(
      prompt.user.includes('[Authorized Personal Memory]\n- 我不吃香菜'),
      'the newly written memory is not in the authorized working set',
    )
  } finally {
    harness.restore()
  }
}

/** The written fact survives a restart: a new store over the same file. */
async function testFieldShapePersistedMemorySurvivesRestart(): Promise<void> {
  const filePath = memoryFileIn(tempDir())
  const harness = createHarness({
    mutate: '{"operation":"ADD","target":null,"content":"我不吃香菜","scope":"OWNER"}',
    filePath,
  })
  try {
    const reply = await ask(harness, { content: `${BOT_TOKEN}记住我不吃香菜`, msgId: 'field-restart-1' })
    assert(reply === '记住了。', `the restart fixture write failed: ${reply}`)
  } finally {
    harness.restore()
  }

  const reopened = new MemoryStore({ filePath, log: () => {}, pathSource: 'TEST' })
  const reopenedService = new MemoryService({
    store: reopened,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => '{"operation":"NONE"}',
    log: () => {},
  })
  const items = await reopenedService.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: OWNER,
    requesterRole: 'OWNER',
    question: '我有什么忌口来着？',
  })
  assert(items.length === 1 && items[0]?.content === '我不吃香菜', 'the written memory did not survive the restart')
}

/** The final prompt carries the runtime truth about persistence side effects. */
async function testFieldShapeGroundingForbidsPersistenceClaim(): Promise<void> {
  const harness = createHarness()
  try {
    seedOwnerMemory(harness, NAME_MEMORY)
    await ask(harness, { content: `${BOT_TOKEN}你好`, msgId: 'grounding-1' })

    const prompt = harness.finalCalls[0] as ProviderCall
    assert(
      prompt.system.includes('普通聊天生成绝对不能声称本轮已经写入、删除或修改了长期记忆'),
      'the final chat contract does not forbid claiming a persistence side effect',
    )
    assert(
      prompt.system.includes('如果本轮走的是普通聊天，就说明本轮没有任何成功的显式记忆变更'),
      'the final chat contract does not state the runtime truth about this turn',
    )
    assert(
      prompt.system.includes('不要因为可能发生了自动提取就承诺'),
      'background auto extraction is not distinguished from an explicit mutation',
    )
  } finally {
    harness.restore()
  }
}

/** Ambient capture keeps the canonical body, and the transcript stays framing-free. */
async function testFieldShapeCanonicalBodyReachesAmbientOnly(): Promise<void> {
  const harness = createHarness()
  try {
    seedOwnerMemory(harness, NAME_MEMORY)
    await ask(harness, { content: `${BOT_TOKEN}你记得不？`, msgId: 'ambient-1' })
    assert(harness.store.liveRecordCount === 1, `the retrieval-only turn wrote memory: ${harness.store.liveRecordCount}`)

    await ask(harness, { content: `${BOT_TOKEN}${MEMBER_TOKEN}那它现在怎么样了`, msgId: 'ambient-2' })
    assert(finalCallCount(harness) === 2, `expected two final calls, got ${finalCallCount(harness)}`)
    const prompt = harness.finalCalls[1] as ProviderCall
    // The earlier bot-addressed line lost its own bot token; the member mention in
    // the current request stays, because it is user content.
    assert(prompt.user.includes('你记得不？'), 'the canonical earlier request is missing from the transcript')
    assert(!prompt.user.includes(BOT_TOKEN), 'a bot token was rendered into the transcript')
    assert(prompt.user.includes(MEMBER_TOKEN), 'the member mention was stripped from the current request')
  } finally {
    harness.restore()
  }
}

// ------------------------------------------------------------------ execution

const CASES: Array<[string, () => Promise<void> | void]> = [
  ['canonical-projection', testCanonicalProjection],
  ['field-shape-1-explicit-remember-admitted', testFieldShapeExplicitRememberIsAdmitted],
  ['field-shape-prefixed-content-stays-chat', testFieldShapePrefixedContentStaysChat],
  ['field-shape-2-4-normal-chat-stays-chat', testFieldShapeNormalChatStaysChat],
  ['field-shape-member-not-admitted', testFieldShapeMemberIsNotAdmitted],
  ['field-shape-explicit-add-persists', testFieldShapeExplicitAddPersists],
  ['field-shape-persisted-memory-survives-restart', testFieldShapePersistedMemorySurvivesRestart],
  ['field-shape-grounding-forbids-persistence-claim', testFieldShapeGroundingForbidsPersistenceClaim],
  ['field-shape-canonical-body-in-transcript', testFieldShapeCanonicalBodyReachesAmbientOnly],
]

let failures = 0
for (const [name, run] of CASES) {
  try {
    await run()
    console.log(`[FIELD_SHAPE_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(
      `[FIELD_SHAPE_CASE] name=${name} result=FAIL message=${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

cleanup()
console.log(`[FIELD_SHAPE_SUMMARY] cases=${CASES.length} failures=${failures}`)
if (failures > 0) {
  console.log('[EXPLICIT_MEMORY_FIELD_SHAPE] result=BLOCKED')
  process.exitCode = 1
} else {
  console.log('[EXPLICIT_MEMORY_FIELD_SHAPE] result=PASS')
}
