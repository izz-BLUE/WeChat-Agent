/**
 * Durable memory diagnostics: wiring, namespace, privacy and fail-open.
 *
 * The memory runtime used to print `[MEMORY_STORE]` / `[MEMORY_TRIGGER]` /
 * `[MEMORY_READ]` / `[MEMORY_WRITE]` to stdout only, so after a process exit an
 * operator could not answer "did this fact get written / was it selected".
 * `MemoryService` and `MemoryStore` now share the persistent sink the receiver,
 * transport and chat already use: the same fields render the stdout line and the
 * durable event, and `GroupContext` moved to the `CONTEXT_*` namespace so a
 * transcript read can no longer be mistaken for a long-term memory read.
 *
 * These cases run the real components against a real `PersistentRuntimeLog` and
 * assert on the bytes it wrote to disk. The cross-process variant (real receiver
 * subprocess + named pipe) lives in `memory-log-persist.test.ts`.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GroupContext } from './context.js'
import { MemoryExtractor } from './memory-extractor.js'
import type { MemoryScopeType } from './memory-models.js'
import { MemoryService } from './memory-service.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'
import { PersistentRuntimeLog, PersistentRuntimeLogSink } from './persistent-runtime-log.js'
import type { RequesterRole } from './message-contract.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

// --------------------------------------------------------------- test harness

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-memory-runtime-log-'))
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

const ROOM = 'room-runtime-log@chatroom'
const REQUESTER = 'sig-runtime-log-a'
/** A raw canonical requester id shape that must never reach the log. */
const RAW_REQUESTER = 'wxid_test_runtime_log'
const FACT = 'A 的代号是 Alpha'

/** One durable line, split into the envelope and its `key=value` fields. */
interface DurableLine {
  component: string
  event: string
  fields: string[]
  raw: string
}

function parseDurable(text: string): DurableLine[] {
  const lines: DurableLine[] = []
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.length === 0) {
      continue
    }
    // timestamp|process|component|event|pid=N|k=v|...
    const parts = raw.split('|')
    if (parts.length < 5) {
      continue
    }
    lines.push({
      component: parts[2] ?? '',
      event: parts[3] ?? '',
      fields: parts.slice(5),
      raw,
    })
  }
  return lines
}

function fieldOf(line: DurableLine, name: string): string {
  const prefix = `${name}=`
  const found = line.fields.find((field) => field.startsWith(prefix))
  return found === undefined ? '' : found.slice(prefix.length)
}

function ofEvent(lines: readonly DurableLine[], event: string): DurableLine[] {
  return lines.filter((line) => line.event === event)
}

interface DiagnosticHarness {
  logDirectory: string
  log: PersistentRuntimeLog
  sink: PersistentRuntimeLogSink
  /** The operator-facing lines the components printed. */
  stdout: string[]
  /** Everything the persistent log wrote, re-read from the file. */
  durable(): DurableLine[]
  text(): string
}

function createDiagnosticHarness(): DiagnosticHarness {
  const logDirectory = tempDir()
  const log = new PersistentRuntimeLog({ fileBaseName: 'memorydiag', directory: logDirectory })
  const stdout: string[] = []
  const read = (): string => {
    log.flush()
    const files = readdirSync(logDirectory)
      .filter((name) => name.startsWith('memorydiag-') && name.endsWith('.log'))
      .sort()
    return files.map((name) => readFileSync(join(logDirectory, name), 'utf8')).join('')
  }
  return {
    logDirectory,
    log,
    sink: new PersistentRuntimeLogSink(log, 'agent-memory'),
    stdout,
    durable: () => parseDurable(read()),
    text: read,
  }
}

function sequentialIds(): () => string {
  let counter = 0
  return () => {
    counter += 1
    return `rtl-${counter.toString().padStart(4, '0')}`
  }
}

interface MemoryHarness extends DiagnosticHarness {
  directory: string
  filePath: string
  store: MemoryStore
  service: MemoryService
}

function createMemoryHarness(options: {
  extractorResponses?: readonly string[]
  storeFilePath?: string
} = {}): MemoryHarness {
  const diagnostics = createDiagnosticHarness()
  const directory = tempDir()
  const filePath = options.storeFilePath ?? memoryFileIn(directory)
  const responses = options.extractorResponses ?? ['[]']
  let extractorCalls = 0

  const store = new MemoryStore({
    filePath,
    log: (message) => diagnostics.stdout.push(message),
    sink: diagnostics.sink,
    pathSource: 'TEST',
  })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => {
      const index = Math.min(extractorCalls, responses.length - 1)
      extractorCalls += 1
      return responses[index] ?? '[]'
    }),
    mutate: async () => '{"operation":"NONE"}',
    now: () => 1_757_000_000_000,
    idFactory: sequentialIds(),
    log: (message) => diagnostics.stdout.push(message),
    sink: diagnostics.sink,
  })

  return { ...diagnostics, directory, filePath, store, service }
}

function observe(
  service: MemoryService,
  count: number,
  options: {
    text?: string
    chatTriggered?: boolean
    messageIdPrefix?: string
    requesterId?: string
    requesterRole?: RequesterRole
  } = {},
): void {
  const prefix = options.messageIdPrefix ?? 'msg'
  for (let index = 0; index < count; index += 1) {
    service.observeHumanMessage({
      messageId: `${prefix}-${index}`,
      conversationType: 'GROUP',
      conversationId: ROOM,
      requesterId: options.requesterId ?? REQUESTER,
      requesterRole: options.requesterRole ?? 'MEMBER',
      speakerLabel: 'MEMBER_1',
      text: options.text ?? '我们约定周五发版',
      timestamp: 1_757_000_000_000,
      chatTriggered: options.chatTriggered ?? true,
    })
  }
}

function seed(
  store: MemoryStore,
  options: { memoryId: string; scopeType: MemoryScopeType; scopeId: string; content: string },
): void {
  const status = store.add({
    memoryId: options.memoryId,
    scopeType: options.scopeType,
    scopeId: options.scopeId,
    content: options.content,
    contentHash: '',
    visibility: 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: ROOM,
    sourceSenderId: options.scopeId,
    createdAt: 1,
    updatedAt: 1,
    isDeleted: false,
  })
  assert(status === 'WRITTEN', `seed write failed: ${status}`)
}

// ------------------------------------------------------------------ the cases

/**
 * `MEMORY_STORE` is durable for every decision the store makes: load, save,
 * enabled/disabled and the failure reason. A field that only survives on stdout
 * cannot answer "was the fact persisted" after the process is gone.
 */
async function testMemoryStoreEventsAreDurable(): Promise<void> {
  const diagnostics = createDiagnosticHarness()
  const directory = tempDir()
  const filePath = memoryFileIn(directory)

  // 1. First start: created + enabled.
  const first = new MemoryStore({
    filePath,
    log: (message) => diagnostics.stdout.push(message),
    sink: diagnostics.sink,
    pathSource: 'TEST',
  })
  seed(first, { memoryId: 'durable-1', scopeType: 'MEMBER', scopeId: REQUESTER, content: FACT })

  // 2. Restart on the same file: the load reports the persisted record.
  const second = new MemoryStore({
    filePath,
    log: (message) => diagnostics.stdout.push(message),
    sink: diagnostics.sink,
    pathSource: 'TEST',
  })
  assert(second.liveRecordCount === 1, 'the restarted store did not load the record')

  const lines = diagnostics.durable()
  const init = ofEvent(lines, 'MEMORY_STORE').filter((line) => fieldOf(line, 'operation') === 'INIT')
  const load = ofEvent(lines, 'MEMORY_STORE').filter((line) => fieldOf(line, 'operation') === 'LOAD')
  const save = ofEvent(lines, 'MEMORY_STORE').filter((line) => fieldOf(line, 'operation') === 'SAVE')

  assert(init.length >= 1, 'no MEMORY_STORE INIT event was persisted')
  assert(
    init.some((line) => fieldOf(line, 'result') === 'PASS' && fieldOf(line, 'enabled') === 'true'),
    `no enabled store was persisted: ${init.map((line) => line.raw).join(' | ')}`,
  )
  assert(load.length >= 2, `the LOAD events were not persisted: ${load.length}`)
  assert(
    load.some((line) => fieldOf(line, 'reason') === 'CREATED'),
    'the initial LOAD (CREATED) was not persisted',
  )
  assert(
    load.some((line) => fieldOf(line, 'recordCount') === '1'),
    'the restart LOAD did not persist the persisted record count',
  )
  assert(
    save.some((line) => fieldOf(line, 'result') === 'PASS'),
    'a successful SAVE was not persisted',
  )
  assert(
    save.every((line) => fieldOf(line, 'recordCount') !== ''),
    'a persisted SAVE carries no recordCount',
  )

  // 3. A corrupt file disables the store and says so, both on stdout and durably.
  const corruptDirectory = tempDir()
  writeFileSync(memoryFileIn(corruptDirectory), '{ "version": 1, "records": [ { broken', 'utf8')
  const corrupt = new MemoryStore({
    filePath: memoryFileIn(corruptDirectory),
    log: (message) => diagnostics.stdout.push(message),
    sink: diagnostics.sink,
    pathSource: 'TEST',
  })
  assert(!corrupt.isEnabled, 'the corrupt store stayed enabled')

  const afterCorruption = ofEvent(diagnostics.durable(), 'MEMORY_STORE')
  assert(
    afterCorruption.some(
      (line) => fieldOf(line, 'result') === 'FAIL' && fieldOf(line, 'reason') === 'CORRUPT',
    ),
    'the corrupt LOAD failure was not persisted',
  )
  assert(
    afterCorruption.some(
      (line) => fieldOf(line, 'operation') === 'INIT' && fieldOf(line, 'enabled') === 'false',
    ),
    'a disabled store was not persisted as an explicit DISABLED decision',
  )
}

/**
 * `MEMORY_TRIGGER` and `MEMORY_WRITE` are durable: which trigger fired, with what
 * result, and the scope/visibility/result of every write attempt.
 */
async function testTriggerAndWriteEventsAreDurable(): Promise<void> {
  const harness = createMemoryHarness({
    extractorResponses: [`[{"scope":"MEMBER","content":"${FACT}"}]`],
  })

  // Two messages only buffer; the third reaches the chat threshold and flushes.
  observe(harness.service, 3, { text: FACT })
  await harness.service.flushAll()

  assert(harness.store.liveRecordCount === 1, 'the automatic write did not reach the store')
  const lines = harness.durable()

  const buffered = ofEvent(lines, 'MEMORY_TRIGGER').filter((line) => fieldOf(line, 'trigger') === 'BUFFERED')
  assert(
    buffered.length === 2 && buffered.every((line) => fieldOf(line, 'result') === 'PASS'),
    `the BUFFERED triggers were not persisted as two passes: ${buffered.map((line) => line.raw).join(' | ')}`,
  )

  const threshold = ofEvent(lines, 'MEMORY_TRIGGER').filter(
    (line) => fieldOf(line, 'trigger') === 'AUTO_CHAT_THRESHOLD',
  )
  assert(threshold.length === 1, `expected exactly one AUTO_CHAT_THRESHOLD trigger, got ${threshold.length}`)
  const flush = threshold[0] as DurableLine
  assert(fieldOf(flush, 'result') === 'PASS', `the threshold flush was not a pass: ${flush.raw}`)
  assert(fieldOf(flush, 'candidates') === '1', `the persisted candidate count is wrong: ${flush.raw}`)
  assert(fieldOf(flush, 'written') === '1', `the persisted written count is wrong: ${flush.raw}`)

  const writes = ofEvent(lines, 'MEMORY_WRITE')
  assert(writes.length === 1, `expected exactly one MEMORY_WRITE event, got ${writes.length}`)
  const write = writes[0] as DurableLine
  assert(fieldOf(write, 'scope') === 'MEMBER', `the write scope is not the requester scope: ${write.raw}`)
  assert(fieldOf(write, 'visibility') === 'SHARED', `the write visibility is wrong: ${write.raw}`)
  assert(fieldOf(write, 'result') === 'WRITTEN', `the write result is wrong: ${write.raw}`)

  // A candidate whose scope contradicts the trusted role is durable too, reported
  // as the reason enum only.
  const rejected = createMemoryHarness({
    extractorResponses: [`[{"scope":"OWNER","content":"${FACT}"}]`],
  })
  observe(rejected.service, 3, { text: FACT, messageIdPrefix: 'reject' })
  await rejected.service.flushAll()
  const rejections = ofEvent(rejected.durable(), 'MEMORY_WRITE')
  assert(
    rejections.some(
      (line) =>
        fieldOf(line, 'result') === 'SKIPPED' &&
        fieldOf(line, 'reason') === 'SCOPE_NOT_ALLOWED_FOR_ROLE',
    ),
    `a rejected candidate was not persisted as a reason code: ${rejections.map((line) => line.raw).join(' | ')}`,
  )

  // A store-degraded intake is durable as an explicit skip.
  const disabledDirectory = tempDir()
  writeFileSync(memoryFileIn(disabledDirectory), 'not json', 'utf8')
  const disabledDiagnostics = createDiagnosticHarness()
  const brokenStore = new MemoryStore({
    filePath: memoryFileIn(disabledDirectory),
    log: (message) => disabledDiagnostics.stdout.push(message),
    sink: disabledDiagnostics.sink,
    pathSource: 'TEST',
  })
  const brokenService = new MemoryService({
    store: brokenStore,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => '{"operation":"NONE"}',
    log: (message) => disabledDiagnostics.stdout.push(message),
    sink: disabledDiagnostics.sink,
  })
  observe(brokenService, 1, { messageIdPrefix: 'disabled' })
  assert(
    ofEvent(disabledDiagnostics.durable(), 'MEMORY_TRIGGER').some(
      (line) => fieldOf(line, 'result') === 'SKIPPED' && fieldOf(line, 'reason') === 'STORE_UNAVAILABLE',
    ),
    'the disabled-store trigger skip was not persisted',
  )
}

/**
 * `MEMORY_READ` is durable with the requester's scope enum, the eligible
 * candidate count and the selected count — the three values a field RCA needs,
 * and the ones the field log carries in `personalCount` / `selectedCount`.
 */
async function testReadEventCarriesScopeAndCounts(): Promise<void> {
  const harness = createMemoryHarness()
  seed(harness.store, { memoryId: 'read-personal', scopeType: 'MEMBER', scopeId: REQUESTER, content: FACT })
  seed(harness.store, { memoryId: 'read-group', scopeType: 'GROUP', scopeId: ROOM, content: '本群约定周五发版' })

  const items = await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: REQUESTER,
    requesterRole: 'MEMBER',
    question: '我的代号是什么',
  })
  assert(items.length === 1, `the personal fact was not selected: ${items.length}`)

  const reads = ofEvent(harness.durable(), 'MEMORY_READ')
  assert(reads.length === 1, `expected exactly one MEMORY_READ event, got ${reads.length}`)
  const read = reads[0] as DurableLine
  assert(fieldOf(read, 'scope') === 'MEMBER', `the read scope enum is missing: ${read.raw}`)
  assert(fieldOf(read, 'personalCount') === '1', `personalCount is wrong: ${read.raw}`)
  assert(fieldOf(read, 'groupCount') === '1', `groupCount is wrong: ${read.raw}`)
  assert(fieldOf(read, 'candidateCount') === '2', `candidateCount is wrong: ${read.raw}`)
  assert(fieldOf(read, 'selectedCount') === '1', `selectedCount is wrong: ${read.raw}`)
  assert(fieldOf(read, 'result') === 'PASS', `the read result is wrong: ${read.raw}`)

  // The personal scope enum follows the trusted requester role.
  await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: REQUESTER,
    requesterRole: 'OWNER',
    question: '我的代号是什么',
  })
  const ownerReads = ofEvent(harness.durable(), 'MEMORY_READ')
  assert(ownerReads.length === 2, `expected two durable MEMORY_READ events, got ${ownerReads.length}`)
  assert(fieldOf(ownerReads[1] as DurableLine, 'scope') === 'OWNER', 'the owner read did not report scope=OWNER')

  // A DIRECT read is disabled, and the reason is durable instead of silent.
  await harness.service.retrieveForChat({
    conversationType: 'DIRECT',
    conversationId: 'direct-room',
    requesterId: REQUESTER,
    requesterRole: 'MEMBER',
    question: '我的代号是什么',
  })
  const directReads = ofEvent(harness.durable(), 'MEMORY_READ').filter(
    (line) => fieldOf(line, 'reason') === 'DIRECT_MEMORY_DISABLED',
  )
  assert(directReads.length === 1, 'the disabled DIRECT read was not persisted')
}

/**
 * The namespace split. A short-term transcript operation must never produce a
 * `MEMORY_*` event, and the memory runtime must never produce a `CONTEXT_*` one,
 * so a log search by event name cannot confuse the two.
 */
async function testContextEventsUseTheirOwnNamespace(): Promise<void> {
  const diagnostics = createDiagnosticHarness()
  const context = new GroupContext(20, diagnostics.sink)
  const message = { senderId: REQUESTER, senderName: 'MEMBER_1', text: '你好', timestamp: 1 }
  context.append(ROOM, message, 'context-msg-1')
  context.recent(ROOM, 10, 1000, 'context-msg-2')

  const contextLines = diagnostics.durable()
  assert(contextLines.length === 2, `the transcript wrote ${contextLines.length} durable events instead of 2`)
  assert(
    contextLines[0]?.event === 'CONTEXT_APPEND' && fieldOf(contextLines[0], 'phase') === 'context-append',
    `the transcript append uses the wrong event: ${contextLines[0]?.raw ?? 'NONE'}`,
  )
  assert(
    contextLines[1]?.event === 'CONTEXT_READ' && fieldOf(contextLines[1], 'phase') === 'context-read',
    `the transcript read uses the wrong event: ${contextLines[1]?.raw ?? 'NONE'}`,
  )
  assert(
    ofEvent(contextLines, 'MEMORY_READ').length === 0 && ofEvent(contextLines, 'MEMORY_WRITE').length === 0,
    'a short-term transcript operation still emits a MEMORY_READ / MEMORY_WRITE event',
  )

  // The reverse direction: the memory runtime emits no CONTEXT_* event.
  const harness = createMemoryHarness({ extractorResponses: ['[]'] })
  const memoryContext = new GroupContext(20, harness.sink)
  memoryContext.append(ROOM, message, 'context-msg-3')
  memoryContext.recent(ROOM, 10, 1000)
  observe(harness.service, 3)
  await harness.service.flushAll()
  await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: REQUESTER,
    requesterRole: 'MEMBER',
    question: '我的代号是什么',
  })
  await harness.service.flushAll()

  const memoryLines = harness.durable()
  assert(
    memoryLines.some((line) => line.event === 'MEMORY_READ'),
    'the memory runtime persisted no MEMORY_READ event',
  )
  const memoryNamed = memoryLines.filter(
    (line) => line.event === 'MEMORY_READ' || line.event === 'MEMORY_WRITE',
  )
  assert(
    memoryNamed.every((line) => !line.raw.includes('phase=context-')),
    'a MEMORY_* event carries a transcript phase',
  )
  assert(
    memoryNamed.every((line) => line.component === 'agent-memory'),
    'a memory event was attributed to another component',
  )
}

/**
 * The privacy contract on the memory events: tokens, counts, enums, results. A
 * raw requester id, conversation id, scope id, member name or memory content must
 * never reach the file — even when the write itself is rejected for carrying one.
 */
async function testDurableMemoryLogCarriesNoRawIdentityOrContent(): Promise<void> {
  const harness = createMemoryHarness({
    extractorResponses: [
      `[{"scope":"MEMBER","content":"${FACT}"}]`,
      `[{"scope":"MEMBER","content":"代号是 ${RAW_REQUESTER}"}]`,
    ],
  })

  observe(harness.service, 3, { text: FACT, requesterId: RAW_REQUESTER, messageIdPrefix: 'raw' })
  await harness.service.flushAll()
  observe(harness.service, 3, { text: FACT, requesterId: RAW_REQUESTER, messageIdPrefix: 'raw2' })
  await harness.service.flushAll()
  await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: RAW_REQUESTER,
    requesterRole: 'MEMBER',
    question: FACT,
  })

  const text = harness.text()
  assert(text.length > 0, 'the persistent memory log is empty, so the case proves nothing')
  for (const forbidden of [RAW_REQUESTER, ROOM, REQUESTER, FACT, 'Alpha', 'MEMBER_1']) {
    assert(!text.includes(forbidden), `the durable log carries a raw value: ${forbidden}`)
  }
  // The rejected write is still reported, as the reason enum only.
  assert(
    ofEvent(harness.durable(), 'MEMORY_WRITE').some(
      (line) => fieldOf(line, 'reason') === 'RAW_IDENTITY_IN_CONTENT',
    ),
    'the raw-identity rejection was not persisted as a reason code',
  )
}

/**
 * The stdout line and the durable event are rendered from the same fields, so a
 * `result=` (or any other field) can never disagree between what the operator
 * saw live and what the file holds afterwards.
 */
async function testStdoutAndDurableEventsAgree(): Promise<void> {
  const harness = createMemoryHarness({
    extractorResponses: [`[{"scope":"MEMBER","content":"${FACT}"}]`],
  })
  seed(harness.store, { memoryId: 'agree-1', scopeType: 'MEMBER', scopeId: REQUESTER, content: FACT })
  observe(harness.service, 3, { text: FACT })
  await harness.service.flushAll()
  await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: REQUESTER,
    requesterRole: 'MEMBER',
    question: '我的代号是什么',
  })

  const events = new Set(['MEMORY_STORE', 'MEMORY_TRIGGER', 'MEMORY_READ', 'MEMORY_WRITE'])
  const stdoutLines = harness.stdout.filter((line) => {
    const match = /^\[([A-Z_]+)\]/u.exec(line)
    return match !== null && events.has(match[1] as string)
  })
  const durableLines = harness.durable().filter((line) => events.has(line.event))

  assert(stdoutLines.length > 0, 'the case captured no memory diagnostic on stdout')
  assert(
    stdoutLines.length === durableLines.length,
    `stdout has ${stdoutLines.length} memory diagnostics but the durable log has ${durableLines.length}`,
  )
  for (let index = 0; index < stdoutLines.length; index += 1) {
    const stdoutLine = stdoutLines[index] as string
    const durableLine = durableLines[index] as DurableLine
    const separator = stdoutLine.indexOf(']')
    const event = stdoutLine.slice(1, separator)
    assert(event === durableLine.event, `event #${index} disagrees: ${event} vs ${durableLine.event}`)
    assert(
      stdoutLine.slice(separator + 2) === durableLine.fields.join(' '),
      `field #${index} disagrees:\n  stdout: ${stdoutLine}\n  durable: ${durableLine.raw}`,
    )
  }
}

/**
 * Requirement: a logging failure must never affect memory or chat. Both halves of
 * the failure are covered — a sink that throws (the memory path isolates the
 * durable call) and a real `PersistentRuntimeLog` whose directory cannot be
 * created, where the whole stack keeps running on the stdout channel alone.
 */
async function testLoggingFailureNeverBreaksMemoryOrChat(): Promise<void> {
  // 1. A sink implementation that throws on every write.
  const throwingSink = {
    writeStructured(): void {
      throw new Error('synthetic sink failure')
    },
  } as unknown as PersistentRuntimeLogSink
  const directory = tempDir()
  const store = new MemoryStore({
    filePath: memoryFileIn(directory),
    log: () => undefined,
    sink: throwingSink,
    pathSource: 'TEST',
  })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => `[{"scope":"MEMBER","content":"${FACT}"}]`),
    mutate: async () => '{"operation":"NONE"}',
    idFactory: sequentialIds(),
    log: () => undefined,
    sink: throwingSink,
  })
  observe(service, 3, { text: FACT })
  await service.flushAll()
  assert(store.liveRecordCount === 1, 'a throwing sink broke the memory write')

  const items = await service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: REQUESTER,
    requesterRole: 'MEMBER',
    question: '我的代号是什么',
  })
  assert(items.length === 1, 'a throwing sink broke the memory retrieval')

  // 2. A real persistent log whose directory cannot be created: a regular file
  //    occupies the path, so every rotation fails and is reported fail-open. The
  //    whole memory stack, including the transcript, keeps working.
  const blockedRoot = tempDir()
  const blockedPath = join(blockedRoot, 'not-a-directory')
  writeFileSync(blockedPath, 'occupied', 'utf8')
  const brokenLog = new PersistentRuntimeLog({ fileBaseName: 'memorydiag', directory: blockedPath })
  const brokenSink = new PersistentRuntimeLogSink(brokenLog, 'agent-memory')

  const secondDirectory = tempDir()
  const secondStore = new MemoryStore({
    filePath: memoryFileIn(secondDirectory),
    log: () => undefined,
    sink: brokenSink,
    pathSource: 'TEST',
  })
  const secondService = new MemoryService({
    store: secondStore,
    extractor: new MemoryExtractor(async () => `[{"scope":"MEMBER","content":"${FACT}"}]`),
    mutate: async () => '{"operation":"NONE"}',
    idFactory: sequentialIds(),
    log: () => undefined,
    sink: brokenSink,
  })
  observe(secondService, 3, { text: FACT })
  await secondService.flushAll()
  assert(secondStore.liveRecordCount === 1, 'an uncreatable log directory broke the memory write')
  assert(
    (await secondService.retrieveForChat({
      conversationType: 'GROUP',
      conversationId: ROOM,
      requesterId: REQUESTER,
      requesterRole: 'MEMBER',
      question: '我的代号是什么',
    })).length === 1,
    'an uncreatable log directory broke the memory retrieval',
  )

  const context = new GroupContext(20, brokenSink)
  context.append(ROOM, { senderId: REQUESTER, senderName: 'MEMBER_1', text: '你好', timestamp: 1 })
  assert(
    context.recent(ROOM, 10, 1000).length === 1,
    'an uncreatable log directory broke the in-process transcript',
  )
  assert(
    readdirSync(blockedRoot).length === 1,
    'the fail-open path created something next to the blocking file',
  )
  brokenLog.dispose()
}

// ------------------------------------------------------------------ execution

const CASES: Array<[string, () => Promise<void>]> = [
  ['memory-store-events-are-durable', testMemoryStoreEventsAreDurable],
  ['trigger-and-write-events-are-durable', testTriggerAndWriteEventsAreDurable],
  ['read-event-carries-scope-and-counts', testReadEventCarriesScopeAndCounts],
  ['context-events-use-their-own-namespace', testContextEventsUseTheirOwnNamespace],
  ['durable-log-carries-no-raw-identity-or-content', testDurableMemoryLogCarriesNoRawIdentityOrContent],
  ['stdout-and-durable-events-agree', testStdoutAndDurableEventsAgree],
  ['logging-failure-never-breaks-memory-or-chat', testLoggingFailureNeverBreaksMemoryOrChat],
]

let failures = 0
for (const [name, run] of CASES) {
  try {
    await run()
    console.log(`[MEMORY_RUNTIME_LOG_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    const message = error instanceof Error ? error.message : String(error)
    console.log(`[MEMORY_RUNTIME_LOG_CASE] name=${name} result=FAIL message=${message}`)
  }
}

cleanup()
console.log(`[MEMORY_RUNTIME_LOG_TEST_SUMMARY] cases=${CASES.length} failures=${failures}`)
if (failures > 0) {
  console.log('[MEMORY_RUNTIME_LOG] result=FAIL')
  process.exitCode = 1
} else {
  console.log('[MEMORY_RUNTIME_LOG] result=PASS')
}
