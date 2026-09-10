/**
 * TRANSPORT_FRAMING_ADMISSION — the field RCA as a permanent regression.
 *
 * THE FIELD CASE. A human sent one line, `@bot 记住我不吃香菜`. The runtime
 * confirmed the bot mention (`botMentionSpanValid=true botMentionSpanCount=1`) and
 * the Agent removed exactly that token (`canonicalized=true`), yet admission ended
 * as:
 *
 *   [MEMORY_ADMISSION] ... explicitCommand=false result=CHAT
 *     reason=NOT_AN_EXPLICIT_COMMAND canonicalized=true lineCount=2 ...
 *
 * `lineCount=2` is the decisive fact: the wire body has two lines, and the Agent
 * never adds one. The command gate is anchored at the start of the canonical text,
 * so it can only miss if something non-empty precedes the command — every
 * whitespace-only variant collapses during projection and admits (see the matrix
 * below, cases B/C/D/I/J).
 *
 * WHAT THIS SUITE PINS:
 *  - the shape matrix that reproduces the field signature exactly, and the shapes
 *    that must keep admitting (so a "drop the first line" fix cannot pass here);
 *  - the three failure modes staying distinguishable in the log
 *    (`blocker=ROLE_NOT_OWNER | BOT_MENTION_SPAN_UNTRUSTED | BODY_PREFIX_PRESENT |
 *    GRAMMAR_MISS`) instead of all reading `NOT_AN_EXPLICIT_COMMAND`;
 *  - fail-closed: while a prefix is present the side effect does not happen, nothing
 *    is written, and the turn still answers as ordinary chat.
 *
 * WHAT THIS SUITE DELIBERATELY DOES NOT DO: it does not decide whether the leading
 * line is runtime transport framing or genuine user content. The contract carries no
 * body boundary, no C# layer parses one, and trimming to the mention's line would
 * delete real user text in the accepted "first line ordinary text, second line
 * @bot" shape. Guessing that boundary is the bug class this project already removed
 * twice (mention identity, then global mention stripping), so the prefix stays and
 * the log states the shape instead.
 *
 * Synthetic fixtures only: synthetic bot name, synthetic member name, synthetic
 * framing text.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toAgentRequest } from './agent-adapter.js'
import { canonicalUserText, describeUserText, resolveBotMentionSpans, MENTION_SEPARATOR } from './canonical-user-text.js'
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

const BOT_NAME = '测试助手'
const MEMBER_NAME = '张三'
const BOT_TOKEN = `@${BOT_NAME}${MENTION_SEPARATOR}`
const MEMBER_TOKEN = `@${MEMBER_NAME}${MENTION_SEPARATOR}`
/** Synthetic stand-in for whatever the client puts in front of the message line. */
const ASCII_FRAME = 'wxid_synthetic000'
const CJK_FRAME = '引用的一条旧消息'
const ROOM = 'room-framing@chatroom'
const OWNER = 'requester-framing-owner'
const NOW = 1_757_000_000_000

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-agent-framing-'))
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

function botSpansFor(text: string): Array<{ start: number; length: number }> {
  const spans: Array<{ start: number; length: number }> = []
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
  finalCalls: ProviderCall[]
  mutationCalls: ProviderCall[]
  logs: string[]
  restore(): void
}

function createHarness(options: { mutate?: string } = {}): Harness {
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
    if (system.includes('记忆变更解析器')) {
      mutationCalls.push({ system, user: messages[1]?.content ?? '' })
      return completion(mutateResponse)
    }
    finalCalls.push({ system, user: messages[1]?.content ?? '' })
    return completion('收到。')
  }) as unknown as typeof fetch

  const store = new MemoryStore({ filePath: memoryFileIn(tempDir()), log: (m) => logs.push(m), pathSource: 'TEST' })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: (system, user) => new ChatService('https://provider.invalid/v1', 'k', 'm').completeStructured(system, user),
    log: (m) => logs.push(m),
  })
  const agent = new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'k', 'm'), {
    memory: service,
    ambientContext: new GroupAmbientContext({ sink: undefined, now: () => NOW }),
  })
  return {
    agent,
    store,
    finalCalls,
    mutationCalls,
    logs,
    restore: () => {
      globalThis.fetch = originalFetch
      console.log = originalLog
    },
  }
}

async function ask(
  harness: Harness,
  options: { content: string; msgId: string; role?: 'OWNER' | 'MEMBER'; spans?: Array<{ start: number; length: number }> | null },
): Promise<string> {
  const role = options.role ?? 'OWNER'
  const raw: RawHookMessage = {
    msgId: options.msgId,
    type: 1,
    timestamp: NOW,
    from: ROOM,
    wxid: 'shared-account-synthetic',
    content: options.content,
    signature: OWNER,
    senderName: 'Synthetic Sender',
    isMentioned: true,
    conversationType: 'GROUP',
    conversationId: ROOM,
    senderId: OWNER,
    requesterId: OWNER,
    requesterSource: 'Signature',
    requesterRole: role,
    ownerConfigured: role === 'OWNER',
    botMentionSpans: options.spans === undefined ? botSpansFor(options.content) : options.spans,
  }
  const normalized = normalizeRawHookMessage(raw)
  assert(normalized.status === 'VALID', `the synthetic contract message was rejected: ${normalized.status}`)
  return harness.agent.complete(toAgentRequest(normalized.message))
}

const realLog = console.log.bind(console)

function admissionLine(harness: Harness): string {
  return harness.logs.filter((line) => line.includes('[MEMORY_ADMISSION]')).pop() ?? ''
}

function fieldOf(line: string, name: string): string {
  return new RegExp(`${name}=([^\\s]+)`, 'u').exec(line)?.[1] ?? ''
}

function finalCallCount(harness: Harness): number {
  return harness.finalCalls.length
}

function mutationCallCount(harness: Harness): number {
  return harness.mutationCalls.length
}

function seedOwnerMemory(harness: Harness): void {
  const status = harness.store.add({
    memoryId: 'framing-seed',
    scopeType: 'OWNER',
    scopeId: OWNER,
    content: '我叫辞老师',
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

// ------------------------------------------------------------- shape matrix

/**
 * The matrix that reproduces the field signature, and the shapes that must keep
 * admitting. This is the RCA in executable form.
 */
function testShapeMatrixReproducesTheFieldSignature(): void {
  const command = '记住我不吃香菜'
  const matrix: Array<[string, string, boolean, boolean]> = [
    // name, raw body, expected explicitCommand, "removing the frame admits"
    ['command only', `${BOT_TOKEN}${command}`, true, false],
    ['command then trailing newline', `${BOT_TOKEN}${command}\n`, true, false],
    ['leading newline then command', `\n${BOT_TOKEN}${command}`, true, false],
    ['token alone on line 0', `${BOT_TOKEN}\n${command}`, true, false],
    ['blank line then command', `\n\n${BOT_TOKEN}${command}`, true, false],
    ['spaces-only first line', `   \n${BOT_TOKEN}${command}`, true, false],
    ['command then framing line', `${BOT_TOKEN}${command}\n${ASCII_FRAME}`, true, false],
    // The field signature: non-empty content before the command line.
    ['ascii framing line then command', `${ASCII_FRAME}\n${BOT_TOKEN}${command}`, false, true],
    ['cjk framing line then command', `${CJK_FRAME}\n${BOT_TOKEN}${command}`, false, true],
    // A hand-typed name is typeable text, never transport framing: it stays, and the
    // remainder is still not a command.
    ['framing line, mention not a token', `${CJK_FRAME}\n@${BOT_NAME} ${command}`, false, false],
  ]

  for (const [name, body, expected, frameRemovalAdmits] of matrix) {
    const facts = resolveBotMentionSpans(body, botSpansFor(body))
    const canonical = canonicalUserText(body, facts)
    const admitted = isExplicitMemoryCommand(canonical)
    assert(
      admitted === expected,
      `${name}: explicitCommand=${admitted}, expected ${expected} (canonical=${JSON.stringify(canonical)})`,
    )
    if (frameRemovalAdmits) {
      // The framing line really is what blocks admission: removing it admits, so the
      // row isolates the framing rather than a broken command.
      const withoutFrame = body.slice(body.indexOf('\n') + 1)
      assert(
        isExplicitMemoryCommand(canonicalUserText(withoutFrame, resolveBotMentionSpans(withoutFrame, botSpansFor(withoutFrame)))),
        `${name}: the command after the framing line is not a command either, so the case proves nothing`,
      )
      assert(
        canonical.includes(command) && canonical.split('\n').length === 2,
        `${name}: the framing line is not what precedes the command`,
      )
    }
    if (name === 'framing line, mention not a token') {
      assert(
        canonical.includes(`@${BOT_NAME} ${command}`),
        `${name}: a hand-typed name was stripped from the canonical text`,
      )
    }
  }
}

// -------------------------------------------------- the field shape on the wire

/** The exact field shape, end to end: framing line present, side effect refused. */
async function testFieldShapeFailsClosedWithNamedBlocker(): Promise<void> {
  const harness = createHarness()
  try {
    seedOwnerMemory(harness)
    const content = `${ASCII_FRAME}\n${BOT_TOKEN}记住我不吃香菜`
    await ask(harness, { content, msgId: 'framing-1' })

    const line = admissionLine(harness)
    realLog(`[FRAMING_ADMISSION] case=field-shape ${line}`)
    assert(line.includes('result=CHAT'), `the field shape was admitted: ${line}`)
    assert(line.includes('explicitCommand=false'), `the field shape reported a command: ${line}`)
    assert(fieldOf(line, 'lineCount') === '2', `the raw line count is not 2: ${line}`)
    assert(fieldOf(line, 'canonicalLineCount') === '2', `the canonical line count is not 2: ${line}`)
    assert(
      line.includes('blocker=BODY_PREFIX_PRESENT'),
      `the blocker does not name the real situation: ${line}`,
    )
    assert(line.includes('botMentionSpanValid=true'), `the span claim was not trusted: ${line}`)
    assert(line.includes('mentionState=MENTIONED'), `the mention fact was lost: ${line}`)

    // Nothing is written and the turn still answers.
    assert(mutationCallCount(harness) === 0, 'the field shape entered the mutation path')
    assert(finalCallCount(harness) === 1, `final provider calls=${finalCallCount(harness)}`)
    assert(harness.store.liveRecordCount === 1, 'the field shape wrote memory')
    const prompt = harness.finalCalls[0] as ProviderCall
    assert(prompt.user.includes('记住我不吃香菜'), 'the user text did not reach the final prompt')
  } finally {
    harness.restore()
  }
}

/** The three failure modes stay distinguishable instead of reading the same. */
async function testFailureModesAreDistinguishable(): Promise<void> {
  // 1. Role: a member command is refused for authorization, not for shape.
  const member = createHarness()
  try {
    await ask(member, { content: `${BOT_TOKEN}记住我不吃香菜`, msgId: 'mode-role', role: 'MEMBER' })
    const line = admissionLine(member)
    assert(line.includes('blocker=ROLE_NOT_OWNER'), `the role blocker is missing: ${line}`)
    assert(mutationCallCount(member) === 0 && finalCallCount(member) === 1, 'the member turn was mishandled')
  } finally {
    member.restore()
  }

  // 2. Runtime mention verdict absent (old wire): refused on purpose.
  const oldWire = createHarness()
  try {
    await ask(oldWire, { content: '记住我不吃香菜', msgId: 'mode-span', spans: null })
    const line = admissionLine(oldWire)
    assert(line.includes('blocker=BOT_MENTION_SPAN_UNTRUSTED'), `the span blocker is missing: ${line}`)
    assert(mutationCallCount(oldWire) === 0 && finalCallCount(oldWire) === 1, 'the old wire turn was mishandled')
  } finally {
    oldWire.restore()
  }

  // 3. One canonical line that is not a command shape at all.
  const grammar = createHarness()
  try {
    await ask(grammar, { content: `${BOT_TOKEN}我忘记带钥匙了`, msgId: 'mode-grammar' })
    const line = admissionLine(grammar)
    assert(line.includes('blocker=GRAMMAR_MISS'), `the grammar blocker is missing: ${line}`)
    assert(fieldOf(line, 'canonicalLineCount') === '1', `the canonical line count is wrong: ${line}`)
    assert(mutationCallCount(grammar) === 0 && finalCallCount(grammar) === 1, 'the grammar turn was mishandled')
  } finally {
    grammar.restore()
  }

  // 4. The accepted shape still admits, so the blocker never blocks a real command.
  const admitted = createHarness()
  try {
    await ask(admitted, { content: `${BOT_TOKEN}记住我不吃香菜`, msgId: 'mode-admitted' })
    const line = admissionLine(admitted)
    assert(line.includes('result=ADMITTED'), `the command was not admitted: ${line}`)
    assert(line.includes('blocker=NONE'), `an admitted command reported a blocker: ${line}`)
    assert(mutationCallCount(admitted) === 1 && finalCallCount(admitted) === 0, 'the admitted command did not short-circuit')
  } finally {
    admitted.restore()
  }
}

/** The leading-line shape facts that settle framing-vs-user-content in the field. */
async function testLeadingLineShapeIsReported(): Promise<void> {
  const cases: Array<[string, string, string, string]> = [
    ['ascii framing', `${ASCII_FRAME}\n${BOT_TOKEN}记住我不吃香菜`, 'ASCII_ONLY', 'MEDIUM'],
    ['cjk framing', `${CJK_FRAME}\n${BOT_TOKEN}记住我不吃香菜`, 'CJK_ONLY', 'MEDIUM'],
  ]
  for (const [name, content, expectedClass, expectedBucket] of cases) {
    const harness = createHarness()
    try {
      seedOwnerMemory(harness)
      await ask(harness, { content, msgId: `shape-${name.length}` })
      const line = admissionLine(harness)
      realLog(`[FRAMING_ADMISSION] case=leading-line/${name} ${line}`)
      assert(
        line.includes(`leadingLineClass=${expectedClass}`),
        `${name}: leading line class=${fieldOf(line, 'leadingLineClass')}, expected ${expectedClass}`,
      )
      assert(
        line.includes(`leadingLineLengthBucket=${expectedBucket}`),
        `${name}: leading line bucket=${fieldOf(line, 'leadingLineLengthBucket')}, expected ${expectedBucket}`,
      )
      // The diagnostic carries no text and no identity.
      for (const forbidden of [ASCII_FRAME, CJK_FRAME, BOT_NAME, MEMBER_NAME, ROOM, OWNER, MENTION_SEPARATOR]) {
        assert(!line.includes(forbidden), `${name}: the diagnostic carried "${forbidden}"`)
      }
    } finally {
      harness.restore()
    }
  }
}

/** A non-bot mention stays preserved even with a framing line in front. */
async function testNonBotMentionPreservedWithFraming(): Promise<void> {
  const harness = createHarness()
  try {
    seedOwnerMemory(harness)
    const content = `${ASCII_FRAME}\n${MEMBER_TOKEN}你先看\n${BOT_TOKEN}你也说说`
    await ask(harness, { content, msgId: 'framing-nonbot' })

    const canonical = canonicalUserText(content, resolveBotMentionSpans(content, botSpansFor(content)))
    assert(canonical.includes(MEMBER_TOKEN), `the member mention was removed: ${JSON.stringify(canonical)}`)
    assert(!canonical.includes(BOT_TOKEN), `the bot token survived: ${JSON.stringify(canonical)}`)
    assert(mutationCallCount(harness) === 0, 'the two-addressee sentence entered the mutation path')
    assert(finalCallCount(harness) === 1, `final provider calls=${finalCallCount(harness)}`)
    const prompt = harness.finalCalls[0] as ProviderCall
    assert(prompt.user.includes(MEMBER_NAME), 'the member mention was deleted from the prompt')
  } finally {
    harness.restore()
  }
}

/** The P0 shape keeps failing closed with a framing line in front. */
async function testP0ShapeStillCannotMutate(): Promise<void> {
  for (const [name, content] of [
    ['multiline', `${CJK_FRAME}\n${MEMBER_TOKEN}记住我不吃香菜\n${BOT_TOKEN}你怎么看`],
    ['single line', `${CJK_FRAME}\n${MEMBER_TOKEN}记住我不吃香菜 ${BOT_TOKEN}你怎么看`],
  ] as Array<[string, string]>) {
    const harness = createHarness()
    try {
      seedOwnerMemory(harness)
      await ask(harness, { content, msgId: `p0-${name.length}` })
      const line = admissionLine(harness)
      assert(line.includes('result=CHAT'), `${name}: the P0 shape was admitted: ${line}`)
      assert(mutationCallCount(harness) === 0, `${name}: the P0 shape reached the mutation path`)
      assert(finalCallCount(harness) === 1, `${name}: final provider calls=${finalCallCount(harness)}`)
    } finally {
      harness.restore()
    }
  }
}

/** An invalid span claim still fails closed, with the span blocker named. */
async function testInvalidSpanNamesTheSpanBlocker(): Promise<void> {
  const harness = createHarness()
  try {
    seedOwnerMemory(harness)
    await ask(harness, {
      content: `${BOT_TOKEN}记住我不吃香菜`,
      msgId: 'framing-invalid-span',
      spans: [{ start: 0, length: 9999 }],
    })
    const line = admissionLine(harness)
    assert(line.includes('botMentionSpanValid=false'), `an invalid claim was trusted: ${line}`)
    assert(line.includes('blocker=BOT_MENTION_SPAN_UNTRUSTED'), `the span blocker is missing: ${line}`)
    assert(mutationCallCount(harness) === 0 && finalCallCount(harness) === 1, 'an invalid claim was mishandled')
  } finally {
    harness.restore()
  }
}

// ------------------------------------------------------------------ execution

const CASES: Array<[string, () => Promise<void> | void]> = [
  ['shape-matrix-reproduces-field-signature', testShapeMatrixReproducesTheFieldSignature],
  ['field-shape-fails-closed-with-named-blocker', testFieldShapeFailsClosedWithNamedBlocker],
  ['failure-modes-are-distinguishable', testFailureModesAreDistinguishable],
  ['leading-line-shape-is-reported', testLeadingLineShapeIsReported],
  ['non-bot-mention-preserved-with-framing', testNonBotMentionPreservedWithFraming],
  ['p0-shape-cannot-mutate-with-framing', testP0ShapeStillCannotMutate],
  ['invalid-span-names-the-span-blocker', testInvalidSpanNamesTheSpanBlocker],
]

let failures = 0
for (const [name, run] of CASES) {
  try {
    await run()
    console.log(`[FRAMING_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(
      `[FRAMING_CASE] name=${name} result=FAIL message=${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

cleanup()
console.log(`[FRAMING_SUMMARY] cases=${CASES.length} failures=${failures}`)
if (failures > 0) {
  console.log('[TRANSPORT_FRAMING_ADMISSION] result=BLOCKED')
  process.exitCode = 1
} else {
  console.log('[TRANSPORT_FRAMING_ADMISSION] result=PASS')
}
