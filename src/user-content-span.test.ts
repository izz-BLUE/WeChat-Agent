import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalUserText, MENTION_SEPARATOR } from './canonical-user-text.js'
import { GroupAmbientContext } from './group-ambient-context.js'
import { MemoryExtractor } from './memory-extractor.js'
import { MemoryService } from './memory-service.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'
import { normalizeRawHookMessage, type RawHookMessage } from './message-contract.js'
import {
  runRawPassiveContextPipeline,
  toAgentRequest,
} from './agent-adapter.js'
import { ProductionChatAgent } from './production-agent-receiver.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const SIGNATURE = 'synthetic-signature'
const PREFIX = `${SIGNATURE}:\n`
const ROOM = 'user-content-span-room@chatroom'
const BOT_TOKEN = `@测试助手${MENTION_SEPARATOR}`
const MEMBER_TOKEN = `@张三${MENTION_SEPARATOR}`
const BODY = '记住我不吃香菜'
const NOW = 1_757_000_000_000
const temporaryDirectories: string[] = []

interface ProviderCall {
  ambient?: readonly { text: string }[]
  questionText?: string
}

interface Harness {
  directory: string
  agent: ProductionChatAgent
  ambient: GroupAmbientContext
  store: MemoryStore
  service: MemoryService
  mutationCalls: string[]
  finalCalls: ProviderCall[]
  logs: string[]
  extractorCalls: { count: number }
}

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-agent-user-content-span-'))
  temporaryDirectories.push(directory)
  return directory
}

function cleanup(): void {
  for (const directory of temporaryDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Synthetic cleanup must never hide a test result.
    }
  }
}

function createHarness(
  mutateResponse = '{"operation":"NONE"}',
  directory = tempDir(),
  extractorResponse = '[]',
): Harness {
  const logs: string[] = []
  const mutationCalls: string[] = []
  const finalCalls: ProviderCall[] = []
  const extractorCalls = { count: 0 }
  const store = new MemoryStore({ filePath: memoryFileIn(directory), log: (line) => logs.push(line), pathSource: 'TEST' })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => {
      extractorCalls.count += 1
      return extractorResponse
    }),
    mutate: async (_system, user) => {
      mutationCalls.push(user)
      return mutateResponse
    },
    log: (line) => logs.push(line),
    enableTimer: false,
  })
  const chat = {
    async reply(_context: unknown, question: unknown, request: ProviderCall): Promise<string> {
      const questionText = typeof question === 'object' && question !== null &&
        'text' in question && typeof question.text === 'string'
        ? question.text
        : undefined
      finalCalls.push({ ...request, questionText })
      return '收到。'
    },
  }
  const ambient = new GroupAmbientContext({ sink: undefined, now: () => NOW })
  const agent = new ProductionChatAgent(chat as never, {
    memory: service,
    ambientContext: ambient,
  })
  return { directory, agent, ambient, store, service, mutationCalls, finalCalls, logs, extractorCalls }
}

function rawMessage(
  content: string,
  options: {
    userContentSpan?: unknown
    botMentionSpans?: unknown
    isMentioned?: boolean | null
    requesterRole?: 'OWNER' | 'MEMBER'
  } = {},
): RawHookMessage {
  return {
    msgId: `user-content-${Math.random().toString(16).slice(2)}`,
    type: 1,
    timestamp: NOW,
    from: ROOM,
    wxid: 'shared-account-synthetic',
    content,
    signature: SIGNATURE,
    senderName: 'Synthetic Sender',
    isMentioned: options.isMentioned ?? true,
    conversationType: 'GROUP',
    conversationId: ROOM,
    senderId: SIGNATURE,
    requesterId: SIGNATURE,
    requesterSource: 'Signature',
    requesterRole: options.requesterRole ?? 'OWNER',
    ownerConfigured: options.requesterRole !== 'MEMBER',
    userContentSpan: options.userContentSpan as RawHookMessage['userContentSpan'],
    botMentionSpans: options.botMentionSpans as RawHookMessage['botMentionSpans'],
  }
}

function validSpan(content: string, start = 0): { start: number; length: number } {
  return { start, length: content.length - start }
}

function normalize(raw: RawHookMessage) {
  const result = normalizeRawHookMessage(raw)
  assert(result.status === 'VALID', `expected VALID, got ${result.status}`)
  return result.message
}

async function complete(harness: Harness, raw: RawHookMessage): Promise<void> {
  await harness.agent.complete(toAgentRequest(normalize(raw)))
}

function admissionLine(harness: Harness): string {
  return harness.logs.filter((line) => line.includes('[MEMORY_ADMISSION]')).pop() ?? ''
}

async function testRealShapeIsCanonicalAndAdmitted(): Promise<void> {
  const content = `${PREFIX}${BOT_TOKEN}${BODY}`
  const harness = createHarness('{"operation":"ADD","target":null,"content":"不吃香菜","scope":"MEMBER"}')
  try {
    const message = normalize(rawMessage(content, {
      userContentSpan: validSpan(content, PREFIX.length),
      botMentionSpans: [{ start: PREFIX.length, length: BOT_TOKEN.length }],
    }))
    assert(message.userContentSpan.trust === 'VALID', 'real shape user span was not trusted')
    assert(message.botMentionSpans.trust === 'VALID', 'real shape bot span was not trusted')
    assert(
      canonicalUserText(message.rawText, message.botMentionSpans, message.userContentSpan) === BODY,
      'real shape canonical text still contains framing or bot token',
    )

    await harness.agent.complete(toAgentRequest(message))
    const line = admissionLine(harness)
    assert(line.includes('result=ADMITTED'), `real shape was not admitted: ${line}`)
    assert(!line.includes('BODY_PREFIX_PRESENT'), `real shape retained the old blocker: ${line}`)
    assert(harness.mutationCalls.length === 1, 'real shape did not call the mutation provider once')
    assert(harness.finalCalls.length === 0, 'real shape also called the final provider')
    assert(harness.store.liveRecordCount === 1, 'real shape did not persist the mutation')
  } finally {
    harness.service.close()
  }
}

async function testPersistenceRestartReadsMemory(): Promise<void> {
  const directory = tempDir()
  const first = createHarness('{"operation":"ADD","target":null,"content":"不吃香菜","scope":"MEMBER"}', directory)
  try {
    const content = `${PREFIX}${BOT_TOKEN}${BODY}`
    await complete(first, rawMessage(content, {
      userContentSpan: validSpan(content, PREFIX.length),
      botMentionSpans: [{ start: PREFIX.length, length: BOT_TOKEN.length }],
    }))
    assert(first.store.liveRecordCount === 1, 'restart fixture did not write memory')
  } finally {
    first.service.close()
  }

  const reopenedStore = new MemoryStore({ filePath: memoryFileIn(directory), log: () => undefined, pathSource: 'TEST' })
  const reopened = new MemoryService({
    store: reopenedStore,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => '{"operation":"NONE"}',
    enableTimer: false,
  })
  try {
    const records = await reopened.retrieveForChat({
      conversationType: 'GROUP',
      conversationId: ROOM,
      requesterId: SIGNATURE,
      requesterRole: 'OWNER',
      question: '我有什么忌口',
    })
    assert(records.some((record) => record.content.includes('不吃香菜')), 'restart did not reload the personal memory')
  } finally {
    reopened.close()
  }
}

async function assertNonBotMentionIsPreservedAndCannotMutate(body: string): Promise<void> {
  const content = PREFIX + body
  const botStart = PREFIX.length + body.indexOf(BOT_TOKEN)
  const harness = createHarness('{"operation":"ADD","target":null,"content":"不吃香菜","scope":"MEMBER"}')
  try {
    const message = normalize(rawMessage(content, {
      userContentSpan: validSpan(content, PREFIX.length),
      botMentionSpans: [{ start: botStart, length: BOT_TOKEN.length }],
    }))
    const canonical = canonicalUserText(message.rawText, message.botMentionSpans, message.userContentSpan)
    assert(canonical.includes(MEMBER_TOKEN), 'non-Bot mention was removed')
    assert(!canonical.includes(BOT_TOKEN), 'Bot mention was not removed')
    await harness.agent.complete(toAgentRequest(message))
    assert(harness.mutationCalls.length === 0, 'non-Bot command shape reached persistent mutation')
    assert(harness.finalCalls.length === 1, 'non-Bot mention did not continue as normal chat')
  } finally {
    harness.service.close()
  }
}

async function testNonBotMentionSingleLineIsPreserved(): Promise<void> {
  await assertNonBotMentionIsPreservedAndCannotMutate(`${MEMBER_TOKEN}${BODY} ${BOT_TOKEN}你怎么看`)
}

async function testNonBotMentionMultilineIsPreserved(): Promise<void> {
  await assertNonBotMentionIsPreservedAndCannotMutate(`${MEMBER_TOKEN}${BODY}\n${BOT_TOKEN}你怎么看`)
}

async function testInvalidAndAbsentSpansFailClosed(): Promise<void> {
  const content = `${BOT_TOKEN}${BODY}`
  const cases: Array<[string, unknown]> = [
    ['negative', { start: -1, length: content.length + 1 }],
    ['non-integer', { start: 0.5, length: content.length - 0.5 }],
    ['not-suffix', { start: 0, length: content.length - 1 }],
    ['malformed', { start: 0 }],
    ['absent', undefined],
  ]
  for (const [name, span] of cases) {
    const harness = createHarness('{"operation":"ADD","target":null,"content":"不吃香菜","scope":"MEMBER"}')
    try {
      const message = normalize(rawMessage(content, {
        userContentSpan: span,
        botMentionSpans: [{ start: 0, length: BOT_TOKEN.length }],
      }))
      const expected = name === 'absent' ? 'ABSENT' : 'INVALID'
      assert(message.userContentSpan.trust === expected, `${name}: unexpected trust ${message.userContentSpan.trust}`)
      await harness.agent.complete(toAgentRequest(message))
      assert(harness.mutationCalls.length === 0, `${name}: invalid body span reached mutation`)
      assert(harness.finalCalls.length === 1, `${name}: normal chat did not continue`)
      assert(!admissionLine(harness).includes('result=ADMITTED'), `${name}: invalid body span was admitted`)
    } finally {
      harness.service.close()
    }
  }
}

async function testBotSpanOutsideTrustedBodyInvalidatesBotClaim(): Promise<void> {
  const content = `${PREFIX}${BOT_TOKEN}${BODY}`
  const message = normalize(rawMessage(content, {
    userContentSpan: validSpan(content, PREFIX.length + BOT_TOKEN.length),
    botMentionSpans: [{ start: PREFIX.length, length: BOT_TOKEN.length }],
  }))
  assert(message.userContentSpan.trust === 'VALID', 'the suffix span was not valid')
  assert(message.botMentionSpans.trust === 'INVALID', 'a bot span outside the trusted body was accepted')
}

function testCrLfKeepsRawBotCoordinates(): void {
  const body = `第一行\r\n${BOT_TOKEN}第二行`
  const content = PREFIX + body
  const botStart = PREFIX.length + '第一行\r\n'.length
  const message = normalize(rawMessage(content, {
    userContentSpan: validSpan(content, PREFIX.length),
    botMentionSpans: [{ start: botStart, length: BOT_TOKEN.length }],
  }))
  assert(
    canonicalUserText(message.rawText, message.botMentionSpans, message.userContentSpan) === '第一行\n第二行',
    'CRLF raw-coordinate projection was applied in the wrong order',
  )
}

async function testPassiveAmbientUsesTrustedBody(): Promise<void> {
  const harness = createHarness()
  try {
    const passiveContent = `${PREFIX}今晚吃火锅`
    const passive = await runRawPassiveContextPipeline(
      rawMessage(passiveContent, {
        isMentioned: false,
        userContentSpan: validSpan(passiveContent, PREFIX.length),
        botMentionSpans: [],
      }),
      harness.agent,
    )
    assert(passive.status === 'PASSIVE_CONTEXT', `passive event was not captured: ${passive.status}`)

    const activeContent = `${PREFIX}${BOT_TOKEN}你怎么看`
    await complete(harness, rawMessage(activeContent, {
      userContentSpan: validSpan(activeContent, PREFIX.length),
      botMentionSpans: [{ start: PREFIX.length, length: BOT_TOKEN.length }],
    }))
    assert(harness.finalCalls.length === 1, 'passive ambient unexpectedly changed provider call count')
    const ambient = harness.finalCalls[0]?.ambient ?? []
    assert(ambient.some((line) => line.text === '今晚吃火锅'), 'ambient did not store only the user body')
    assert(!ambient.some((line) => line.text.includes(SIGNATURE)), 'ambient retained signature framing')
    assert(harness.mutationCalls.length === 0, 'passive ambient caused a memory mutation')
  } finally {
    harness.service.close()
  }
}

async function testUntrustedSpanBlocksAutomaticMemory(): Promise<void> {
  const content = `${PREFIX}普通聊天`
  const cases: Array<[string, unknown]> = [
    ['absent', undefined],
    ['invalid', { start: 0, length: content.length - 1 }],
  ]
  for (const [name, userContentSpan] of cases) {
    const harness = createHarness(
      '{"operation":"NONE"}',
      tempDir(),
      '[{"scope":"MEMBER","content":"不应被写入"}]',
    )
    try {
      for (let index = 0; index < 3; index += 1) {
        await complete(harness, rawMessage(content, {
          userContentSpan,
          botMentionSpans: [],
        }))
      }
      await harness.service.flushAll()
      assert(harness.extractorCalls.count === 0, `${name}: untrusted span entered automatic extraction`)
      assert(harness.store.liveRecordCount === 0, `${name}: untrusted span wrote persistent memory`)
      assert(harness.finalCalls.length === 3, `${name}: ordinary chat did not continue`)
      assert(
        harness.logs.some((line) => line.includes('trigger=NONE') && line.includes('reason=USER_CONTENT_SPAN_UNTRUSTED')),
        `${name}: missing untrusted-span diagnostic`,
      )
    } finally {
      harness.service.close()
    }
  }
}

async function testUntrustedSpanRedactsRawIdsFromProviderQuestion(): Promise<void> {
  const harness = createHarness()
  const content = `${PREFIX}${BOT_TOKEN}你好`
  try {
    await complete(harness, rawMessage(content, {
      userContentSpan: undefined,
      botMentionSpans: [{ start: PREFIX.length, length: BOT_TOKEN.length }],
    }))
    assert(harness.finalCalls.length === 1, 'untrusted old wire did not make one normal chat provider call')
    const question = harness.finalCalls[0]?.questionText ?? ''
    assert(!question.includes(SIGNATURE), 'raw Signature reached the provider-visible question')
    assert(!question.includes(ROOM), 'raw conversation id reached the provider-visible question')
    assert(!question.includes('shared-account-synthetic'), 'raw wxid reached the provider-visible question')
    assert(harness.mutationCalls.length === 0, 'untrusted old wire reached mutation')
    assert(harness.extractorCalls.count === 0, 'untrusted old wire reached automatic extraction')
    assert(harness.store.liveRecordCount === 0, 'untrusted old wire wrote persistent memory')
  } finally {
    harness.service.close()
  }
}

async function testUntrustedPassiveSpanIsDropped(): Promise<void> {
  const content = `${PREFIX}今晚吃火锅`
  for (const [name, userContentSpan] of [
    ['absent', undefined],
    ['invalid', { start: 0, length: content.length - 1 }],
  ] as const) {
    const harness = createHarness()
    try {
      const result = await runRawPassiveContextPipeline(
        rawMessage(content, { isMentioned: false, userContentSpan, botMentionSpans: [] }),
        harness.agent,
      )
      assert(result.status === 'INVALID', `${name}: untrusted passive event was not dropped`)
      assert(harness.finalCalls.length === 0, `${name}: untrusted passive event reached provider`)
      assert(harness.mutationCalls.length === 0, `${name}: untrusted passive event reached mutation`)
      assert(harness.extractorCalls.count === 0, `${name}: untrusted passive event reached extractor`)
      assert(harness.store.liveRecordCount === 0, `${name}: untrusted passive event changed memory`)
      assert(harness.ambient.count(ROOM) === 0, `${name}: untrusted passive event was appended`)
    } finally {
      harness.service.close()
    }
  }
}

const cases: Array<[string, () => Promise<void> | void]> = [
  ['real-shape-canonical-and-admitted', testRealShapeIsCanonicalAndAdmitted],
  ['persistence-restart-reads-memory', testPersistenceRestartReadsMemory],
  ['non-bot-mention-single-line-preserved', testNonBotMentionSingleLineIsPreserved],
  ['non-bot-mention-multiline-preserved', testNonBotMentionMultilineIsPreserved],
  ['invalid-and-absent-spans-fail-closed', testInvalidAndAbsentSpansFailClosed],
  ['bot-span-outside-body-invalidates-claim', testBotSpanOutsideTrustedBodyInvalidatesBotClaim],
  ['crlf-keeps-raw-bot-coordinates', testCrLfKeepsRawBotCoordinates],
  ['passive-ambient-uses-trusted-body', testPassiveAmbientUsesTrustedBody],
  ['untrusted-span-blocks-automatic-memory', testUntrustedSpanBlocksAutomaticMemory],
  ['untrusted-span-redacts-raw-ids-from-provider-question', testUntrustedSpanRedactsRawIdsFromProviderQuestion],
  ['untrusted-passive-span-is-dropped', testUntrustedPassiveSpanIsDropped],
]

let failures = 0
for (const [name, testCase] of cases) {
  try {
    await testCase()
    console.log(`[USER_CONTENT_SPAN_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.error(`[USER_CONTENT_SPAN_CASE] name=${name} result=FAIL message=${error instanceof Error ? error.message : String(error)}`)
  }
}

cleanup()
console.log(`[USER_CONTENT_SPAN_SUMMARY] cases=${cases.length} failures=${failures}`)
if (failures > 0) {
  process.exitCode = 1
}
