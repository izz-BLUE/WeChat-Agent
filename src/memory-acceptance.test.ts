/**
 * Persistent-memory acceptance: the constraints that are not already covered by
 * `memory-scope.test.ts` (scope selection, visibility, restart persistence, write
 * failure, corrupt store and requester isolation all live there).
 *
 * This suite owns three constraints of the acceptance contract:
 *   - duplicate writes: `(scopeType, scopeId, contentHash)` produces exactly one
 *     persisted record, including across a restart;
 *   - soft delete: a deleted record is never retrieved, injected or re-added;
 *   - background extraction: the 5-minute timer may write memory and must never
 *     produce a chat call, an outbound command or a reply.
 *
 * It also asserts the two boundaries the memory subsystem shares with the rest of
 * the product: unrelated chat can never cause a write by itself, and GroupContext
 * (ephemeral transcript) is not a persistent-memory store.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRawAgentPipeline, toAgentRequest, type AgentRequest } from './agent-adapter.js'
import type { ChatRequestContext } from './chat.js'
import type { GroupMessage } from './context.js'
import { MemoryExtractor } from './memory-extractor.js'
import type { MemoryOrigin, MemoryScopeType } from './memory-models.js'
import { MemoryService, MEMORY_TIMER_INTERVAL_MS, memberScopeId } from './memory-service.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'
import { normalizeRawHookMessage, type InboundMessage, type RawHookMessage } from './message-contract.js'
import { ProductionChatAgent } from './production-agent-receiver.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

// --------------------------------------------------------------- test harness

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-memory-acceptance-'))
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
    return `acc-${counter.toString().padStart(4, '0')}`
  }
}

const ROOM_A = 'room-acc-a@chatroom'
const ROOM_B = 'room-acc-b@chatroom'
const REQUESTER_A = 'sig-acc-a'
const REQUESTER_B = 'sig-acc-b'
const FACT = 'A 的代号是 Alpha'

interface CapturingChatService {
  calls: Array<{ context: GroupMessage[]; question: GroupMessage; request: ChatRequestContext }>
  reply(context: GroupMessage[], question: GroupMessage, request: ChatRequestContext): Promise<string>
}

function createChatService(): CapturingChatService {
  const service: CapturingChatService = {
    calls: [],
    async reply(context, question, request): Promise<string> {
      service.calls.push({ context, question, request })
      return 'synthetic reply'
    },
  }
  return service
}

interface Harness {
  directory: string
  filePath: string
  store: MemoryStore
  service: MemoryService
  logs: string[]
  /** Structured completions that reached the memory extractor / mutation parser. */
  structuredCalls: string[]
}

function createHarness(options: {
  extractorResponses?: readonly string[]
  now?: () => number
} = {}): Harness {
  const directory = tempDir()
  const filePath = memoryFileIn(directory)
  const logs: string[] = []
  const structuredCalls: string[] = []
  const responses = options.extractorResponses ?? ['[]']

  const store = new MemoryStore({ filePath, log: (message) => logs.push(message), pathSource: 'TEST' })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async (_system, user) => {
      structuredCalls.push(user)
      const index = Math.min(structuredCalls.length - 1, responses.length - 1)
      return responses[index] ?? '[]'
    }),
    mutate: async (_system, user) => {
      structuredCalls.push(user)
      return '{"operation":"NONE"}'
    },
    now: options.now ?? (() => 1_757_000_000_000),
    idFactory: sequentialIds(),
    log: (message) => logs.push(message),
  })

  return { directory, filePath, store, service, logs, structuredCalls }
}

function groupRaw(overrides: Partial<RawHookMessage> = {}): RawHookMessage {
  const from = overrides.from ?? ROOM_A
  const signature = overrides.signature ?? REQUESTER_A
  const senderId = overrides.senderId ?? signature
  return {
    msgId: 'acc-message-1',
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

function validMessage(input: RawHookMessage): InboundMessage {
  const result = normalizeRawHookMessage(input)
  assert(result.status === 'VALID', `expected VALID, got ${result.status}`)
  return result.message
}

interface TurnOptions {
  conversationId?: string
  signature?: string
  role?: 'OWNER' | 'MEMBER'
  text?: string
  msgId?: string
  isMentioned?: boolean
}

/** One production Agent for a whole conversation, exactly as production wires it. */
function createSession(service: MemoryService, chat: CapturingChatService): {
  agent: ProductionChatAgent
  ask(options?: TurnOptions): Promise<{ request: AgentRequest; reply: string }>
} {
  const agent = new ProductionChatAgent(chat as never, { memory: service })
  let counter = 0
  return {
    agent,
    async ask(options: TurnOptions = {}) {
      counter += 1
      const raw = groupRaw({
        from: options.conversationId ?? ROOM_A,
        conversationId: options.conversationId ?? ROOM_A,
        signature: options.signature ?? REQUESTER_A,
        msgId: options.msgId ?? `acc-message-${counter}`,
        content: options.text ?? '@椰椰 你好',
        isMentioned: options.isMentioned ?? true,
        requesterRole: options.role ?? 'MEMBER',
        ownerConfigured: (options.role ?? 'MEMBER') === 'OWNER',
      })
      const request = toAgentRequest(validMessage(raw))
      const reply = await agent.complete(request)
      await service.flushAll()
      return { request, reply }
    },
  }
}

function seed(
  store: MemoryStore,
  options: {
    memoryId: string
    scopeType: MemoryScopeType
    scopeId: string
    content: string
    origin?: MemoryOrigin
    updatedAt?: number
  },
): void {
  const status = store.add({
    memoryId: options.memoryId,
    scopeType: options.scopeType,
    scopeId: options.scopeId,
    content: options.content,
    contentHash: '',
    visibility: 'SHARED',
    origin: options.origin ?? (options.scopeType === 'GROUP' ? 'EXPLICIT_OWNER' : 'AUTOMATIC'),
    sourceConversationType: 'GROUP',
    sourceConversationId: ROOM_A,
    sourceSenderId: options.scopeId,
    createdAt: options.updatedAt ?? 1,
    updatedAt: options.updatedAt ?? 1,
    isDeleted: false,
  })
  assert(status === 'WRITTEN', `seed write failed: ${status}`)
}

/** Drives the automatic extractor with `count` admitted messages. */
async function feed(
  service: MemoryService,
  count: number,
  options: { signature?: string; conversationId?: string; role?: 'OWNER' | 'MEMBER'; text?: string; chatTriggered?: boolean; msgId?: string } = {},
): Promise<void> {
  const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  for (let index = 0; index < count; index += 1) {
    service.observeHumanMessage({
      messageId: options.msgId ? `${options.msgId}-${index}` : `feed-${run}-${index}`,
      conversationType: 'GROUP',
      conversationId: options.conversationId ?? ROOM_A,
      requesterId: options.signature ?? REQUESTER_A,
      requesterRole: options.role ?? 'MEMBER',
      speakerLabel: (options.role ?? 'MEMBER') === 'OWNER' ? 'OWNER' : 'MEMBER_1',
      text: options.text ?? `第 ${index} 条消息`,
      timestamp: 1_757_000_000_000 + index,
      chatTriggered: options.chatTriggered ?? true,
    })
  }
  await service.flushAll()
}

function readStoreFile(filePath: string): { records: Array<{ scopeType: string; scopeId: string; content: string; contentHash: string; isDeleted: boolean }> } {
  return JSON.parse(readFileSync(filePath, 'utf8')) as {
    records: Array<{ scopeType: string; scopeId: string; content: string; contentHash: string; isDeleted: boolean }>
  }
}

/**
 * Narrowing-safe accessors: TypeScript keeps property narrowing across awaits, so
 * a `recordCount === 0` assertion would otherwise make a later `=== 1` comparison
 * look impossible to the compiler.
 */
function liveRecordCount(store: MemoryStore): number {
  return store.liveRecordCount
}

function memoryRecordCount(service: MemoryService): number {
  return service.recordCount
}

function chatCallCount(chat: CapturingChatService): number {
  return chat.calls.length
}

// ------------------------------------------------------------------ the cases

/**
 * Duplicate `(scopeType, scopeId, contentHash)` never produces a second persisted
 * record, whether the write arrives through the extractor or through an explicit
 * OWNER "记住", and whether or not the process was restarted in between.
 */
async function testDuplicateKeyNeverDuplicatesARecord(): Promise<void> {
  // 1. Two identical extractor batches write one record.
  const harness = createHarness({ extractorResponses: [`[{"scope":"MEMBER","content":"${FACT}","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":["M1"]}]`] })
  await feed(harness.service, 3, { text: FACT })
  await feed(harness.service, 3, { text: FACT })
  assert(memoryRecordCount(harness.service) === 1, `a duplicate extractor batch wrote ${memoryRecordCount(harness.service)} records`)
  assert(
    harness.logs.some((line) => line.includes('result=SKIPPED')),
    'the duplicate write was not reported as SKIPPED',
  )

  // 2. Whitespace-only differences normalize to the same content hash.
  const spaced = createHarness({ extractorResponses: [`[{"scope":"MEMBER","content":"${FACT}","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":["M1"]}]`, '[{"scope":"MEMBER","content":"A  的代号是    Alpha","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":["M1"]}]'] })
  await feed(spaced.service, 3, { text: FACT })
  await feed(spaced.service, 3, { text: FACT })
  assert(memoryRecordCount(spaced.service) === 1, `a normalized duplicate wrote ${memoryRecordCount(spaced.service)} records`)

  // 3. The key is per scope: a legal explicit GROUP record with the same
  // content is a new record, while automatic GROUP extraction is rejected.
  const scoped = createHarness({ extractorResponses: [`[{"scope":"MEMBER","content":"${FACT}","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":["M1"]}]`] })
  await feed(scoped.service, 3, { text: FACT })
  seed(scoped.store, { memoryId: 'scoped-group', scopeType: 'GROUP', scopeId: ROOM_A, content: FACT })
  assert(memoryRecordCount(scoped.service) === 2, `distinct scopes collapsed into ${memoryRecordCount(scoped.service)} records`)

  // 4. Across a restart: a fresh store loads the persisted hash and still skips.
  const restartRoot = tempDir()
  const firstLogs: string[] = []
  const firstStore = new MemoryStore({ filePath: memoryFileIn(restartRoot), log: (message) => firstLogs.push(message), pathSource: 'TEST' })
  const firstService = new MemoryService({
    store: firstStore,
    extractor: new MemoryExtractor(async () => `[{"scope":"MEMBER","content":"${FACT}","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":["M1"]}]`),
    mutate: async () => '{"operation":"NONE"}',
    idFactory: sequentialIds(),
    log: (message) => firstLogs.push(message),
  })
  await feed(firstService, 3, { text: FACT })
  assert(liveRecordCount(firstStore) === 1, 'the first process did not write exactly one record')
  const hashBefore = readStoreFile(memoryFileIn(restartRoot)).records[0]?.contentHash ?? ''
  assert(hashBefore.length > 0, 'the persisted record carries no content hash')

  const secondLogs: string[] = []
  const secondStore = new MemoryStore({ filePath: memoryFileIn(restartRoot), log: (message) => secondLogs.push(message), pathSource: 'TEST' })
  const secondService = new MemoryService({
    store: secondStore,
    extractor: new MemoryExtractor(async () => `[{"scope":"MEMBER","content":"${FACT}","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":["M1"]}]`),
    mutate: async () => '{"operation":"NONE"}',
    idFactory: sequentialIds(),
    log: (message) => secondLogs.push(message),
  })
  await feed(secondService, 3, { text: FACT })

  const document = readStoreFile(memoryFileIn(restartRoot))
  assert(liveRecordCount(secondStore) === 1, `a restarted process duplicated the record: ${liveRecordCount(secondStore)}`)
  assert(document.records.length === 1, `the store file holds ${document.records.length} records`)
  assert(document.records[0]?.contentHash === hashBefore, 'the persisted content hash changed across the restart')
  assert(
    secondLogs.some((line) => line.includes('result=SKIPPED')),
    'the restarted process did not report the duplicate as SKIPPED',
  )
}

/**
 * A soft-deleted record is never retrieved, never injected into a prompt and never
 * silently restored; a genuinely new fact for the same scope still writes.
 */
async function testSoftDeletedRecordIsNeverRetrieved(): Promise<void> {
  const harness = createHarness()
  seed(harness.store, {
    memoryId: 'soft-1',
    scopeType: 'MEMBER',
    scopeId: REQUESTER_A,
    content: FACT,
  })

  const before = await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM_A,
    requesterId: REQUESTER_A,
    requesterRole: 'MEMBER',
    question: '我的代号是什么',
  })
  assert(before.length === 1, `the live record was not retrievable: ${before.length}`)

  assert(harness.store.delete('soft-1', 2), 'the soft delete failed')
  const afterDelete = await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM_A,
    requesterId: REQUESTER_A,
    requesterRole: 'MEMBER',
    question: '我的代号是什么',
  })
  assert(afterDelete.length === 0, 'a soft-deleted record was retrieved')
  assert(
    harness.logs.some((line) => line.includes('selectedCount=0')),
    'the post-delete retrieval did not report a zero selection',
  )

  // It is gone from the live set but still on disk as a tombstone, so the history
  // is auditable instead of silently rewritten.
  const document = readStoreFile(harness.filePath)
  const tombstone = document.records.find((record) => record.content === FACT)
  assert(tombstone !== undefined, 'the soft delete removed the record from the file')
  assert(tombstone.isDeleted === true, 'the record was not marked deleted on disk')
  assert(liveRecordCount(harness.store) === 0, 'the live record count still counts a deleted record')

  // A deleted record does not block the same content from being stored again:
  // the duplicate check only considers live records.
  const reAdded = harness.store.add({
    memoryId: 'soft-2',
    scopeType: 'MEMBER',
    scopeId: REQUESTER_A,
    content: FACT,
    contentHash: '',
    visibility: 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: ROOM_A,
    sourceSenderId: REQUESTER_A,
    createdAt: 3,
    updatedAt: 3,
    isDeleted: false,
  })
  assert(reAdded === 'WRITTEN', `re-adding a deleted fact reported ${reAdded}`)
  assert(liveRecordCount(harness.store) === 1, 'the re-added fact is not live')
}

/**
 * Background extraction may write memory. It must never reach the chat provider,
 * never produce an outbound command and never produce a reply, because the only
 * reply producer in this process answers one admitted inbound line.
 */
async function testTimerExtractionWritesMemoryWithoutAnyOutbound(): Promise<void> {
  assert(MEMORY_TIMER_INTERVAL_MS === 300_000, 'the timer interval is not the historical five minutes')

  const harness = createHarness({ extractorResponses: [`[{"scope":"MEMBER","content":"${FACT}","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":["M1"]}]`] })
  const chat = createChatService()
  const session = createSession(harness.service, chat)

  // Three admitted messages with no chat turn: only the timer can flush them.
  await feed(harness.service, 3, { chatTriggered: false, text: FACT })
  assert(memoryRecordCount(harness.service) === 0, 'an unflushed buffer already wrote memory')
  assert(chatCallCount(chat) === 0, 'a buffered message reached the chat provider')

  harness.service.flushPendingBuffers()
  await harness.service.flushAll()

  assert(memoryRecordCount(harness.service) === 1, `the timer flush wrote ${memoryRecordCount(harness.service)} records`)
  assert(chatCallCount(chat) === 0, 'the timer reached the chat provider')
  assert(
    harness.logs.some((line) => line.includes('trigger=AUTO_TIMER') && line.includes('result=PASS')),
    'the timer flush was not reported as an AUTO_TIMER pass',
  )
  const text = harness.logs.join('\n')
  assert(!text.includes('OUTBOUND'), 'the timer produced an outbound diagnostic')
  assert(!text.includes('PROVIDER_CALL'), 'the timer produced a chat provider diagnostic')
  assert(!/\breply=/u.test(text), 'the timer reported a reply')
  assert(session !== undefined, 'the chat session fixture was not constructed')
}

/**
 * Unrelated chat cannot write memory by itself: retrieval and the reply path are
 * read-only, so nothing about an existing memory entry triggers a new write.
 */
async function testUnrelatedChatNeverWritesByItself(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[]'] })
  const chat = createChatService()
  const session = createSession(harness.service, chat)

  seed(harness.store, {
    memoryId: 'unrelated-seed',
    scopeType: 'MEMBER',
    scopeId: REQUESTER_A,
    content: FACT,
  })
  const afterSeed = memoryRecordCount(harness.service)

  await session.ask({ text: '@椰椰 今天天气不错', msgId: 'unrelated-1' })
  await session.ask({ text: '@椰椰 帮我总结一下这段话', msgId: 'unrelated-2' })

  assert(memoryRecordCount(harness.service) === afterSeed, 'unrelated chat changed the record count')
  assert(
    harness.logs.some((line) => line.includes('[MEMORY_READ]')),
    'the chat turn performed no memory retrieval, so the case proves nothing',
  )
  const writes = harness.logs.filter((line) => line.includes('[MEMORY_WRITE]'))
  assert(writes.length === 0, `unrelated chat produced memory writes: ${writes.join(' | ')}`)

  // The seed is still the only record on disk.
  const document = readStoreFile(harness.filePath)
  assert(document.records.length === afterSeed, `the store file grew to ${document.records.length} records`)
}

/**
 * The ephemeral GroupContext is not a memory store: a transcript turn changes no
 * record, and a fresh Agent (empty context) still retrieves the persisted fact.
 */
async function testGroupContextIsNotPersistentMemory(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[]'] })
  const chat = createChatService()
  const session = createSession(harness.service, chat)

  seed(harness.store, {
    memoryId: 'context-seed',
    scopeType: 'MEMBER',
    scopeId: REQUESTER_A,
    content: FACT,
  })

  await session.ask({ text: '@椰椰 我刚才说了什么', msgId: 'context-1' })
  assert(memoryRecordCount(harness.service) === 1, 'a transcript turn changed the memory record count')
  assert(chatCallCount(chat) === 1, 'the transcript turn did not reach the chat provider')
  const contexts = chat.calls[0]?.context ?? []
  assert(contexts.length === 0, 'the first turn already carried a transcript')

  // Second turn: the context carries the first turn, and memory still carries the
  // persisted fact — two separate stores, two separate prompt sections. The
  // question names the codename so the personal record is relevant to it.
  await session.ask({ text: '@椰椰 我的代号是什么', msgId: 'context-2' })
  const second = chat.calls[1]
  assert(second !== undefined, 'the second turn did not reach the chat provider')
  assert(second.context.length === 1, 'the ephemeral transcript did not carry the previous turn')
  assert(second.request.memory?.length === 1, 'the persisted fact was not retrieved on the second turn')
  assert(
    second.request.memory?.[0]?.content.includes('Alpha') === true,
    'the retrieved memory item lost its content',
  )

  // A restart with the same store still retrieves the fact, while the transcript is
  // gone: that is the difference the acceptance contract cares about.
  const restarted = new MemoryStore({ filePath: harness.filePath, log: () => {}, pathSource: 'TEST' })
  const restartedService = new MemoryService({
    store: restarted,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => '{"operation":"NONE"}',
    log: () => {},
  })
  const afterRestart = await restartedService.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM_A,
    requesterId: REQUESTER_A,
    requesterRole: 'MEMBER',
    question: '我的代号是什么',
  })
  assert(afterRestart.length === 1, 'the persisted fact did not survive a restart')

  const freshChat = createChatService()
  const freshAgent = new ProductionChatAgent(freshChat as never, { memory: restartedService })
  const reply = await freshAgent.complete(
    toAgentRequest(validMessage(groupRaw({ msgId: 'context-3', content: '@椰椰 我的代号是什么' }))),
  )
  assert(typeof reply === 'string' && reply.length > 0, 'the reply path returned nothing')
  const restartedCall = freshChat.calls[0]
  assert(restartedCall !== undefined, 'the restarted agent produced no provider call')
  assert(restartedCall.context.length === 0, 'a restarted agent carried a transcript')
  assert(restartedCall.request.memory?.length === 1, 'a restarted agent lost the persisted memory')
}

/**
 * GROUP-scope isolation through the production agent: a fact stored for room A is
 * never retrieved in room B, while same requester/member memory remains room
 * scoped rather than crossing into the other room.
 */
async function testGroupScopeNeverLeaksAcrossRooms(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[]'] })
  const chat = createChatService()
  const session = createSession(harness.service, chat)

  seed(harness.store, { memoryId: 'room-a-fact', scopeType: 'GROUP', scopeId: ROOM_A, content: '本群活动时间是周五' })
  seed(harness.store, { memoryId: 'room-b-fact', scopeType: 'GROUP', scopeId: ROOM_B, content: '本群活动时间是周六' })
  seed(harness.store, {
    memoryId: 'personal-fact-a',
    scopeType: 'MEMBER',
    scopeId: memberScopeId(ROOM_A, REQUESTER_A),
    content: '本群活动时间的个人备注是 Alpha-A',
  })
  seed(harness.store, {
    memoryId: 'personal-fact-b',
    scopeType: 'MEMBER',
    scopeId: memberScopeId(ROOM_B, REQUESTER_A),
    content: '本群活动时间的个人备注是 Alpha-B',
  })

  await session.ask({ conversationId: ROOM_A, text: '@椰椰 本群活动时间是什么', msgId: 'room-a-1' })
  await session.ask({ conversationId: ROOM_B, text: '@椰椰 本群活动时间是什么', msgId: 'room-b-1' })

  const inA = chat.calls[0]?.request.memory ?? []
  const inB = chat.calls[1]?.request.memory ?? []
  const contentsA = inA.map((item) => item.content)
  const contentsB = inB.map((item) => item.content)

  assert(contentsA.some((content) => content.includes('周五')), `room A did not see its own group fact: ${contentsA.join('|')}`)
  assert(!contentsA.some((content) => content.includes('周六')), `room A saw room B's group fact: ${contentsA.join('|')}`)
  assert(contentsB.some((content) => content.includes('周六')), `room B did not see its own group fact: ${contentsB.join('|')}`)
  assert(!contentsB.some((content) => content.includes('周五')), `room B saw room A's group fact: ${contentsB.join('|')}`)
  assert(
    inA.some((item) => item.scope === 'PERSONAL' && item.content.includes('Alpha-A')) &&
      !inA.some((item) => item.scope === 'PERSONAL' && item.content.includes('Alpha-B')),
    `the same requester lost their personal fact in room A: ${contentsA.join('|')}`,
  )
  assert(
    inB.some((item) => item.scope === 'PERSONAL' && item.content.includes('Alpha-B')) &&
      !inB.some((item) => item.scope === 'PERSONAL' && item.content.includes('Alpha-A')),
    `the same requester lost their personal fact in room B: ${contentsB.join('|')}`,
  )
}

// ------------------------------------------------------------------ execution

const CASES: Array<[string, () => Promise<void>]> = [
  ['duplicate-key-never-duplicates-a-record', testDuplicateKeyNeverDuplicatesARecord],
  ['soft-deleted-record-is-never-retrieved', testSoftDeletedRecordIsNeverRetrieved],
  ['timer-extraction-writes-memory-without-outbound', testTimerExtractionWritesMemoryWithoutAnyOutbound],
  ['unrelated-chat-never-writes-by-itself', testUnrelatedChatNeverWritesByItself],
  ['group-context-is-not-persistent-memory', testGroupContextIsNotPersistentMemory],
  ['group-scope-never-leaks-across-rooms', testGroupScopeNeverLeaksAcrossRooms],
]

let failures = 0
for (const [name, run] of CASES) {
  try {
    await run()
    console.log(`[MEMORY_ACCEPTANCE_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    const message = error instanceof Error ? error.message : String(error)
    console.log(`[MEMORY_ACCEPTANCE_CASE] name=${name} result=FAIL message=${message}`)
  }
}

cleanup()
console.log(`[MEMORY_ACCEPTANCE_TEST_SUMMARY] cases=${CASES.length} failures=${failures}`)
if (failures > 0) {
  console.log('[MEMORY_ACCEPTANCE] result=FAIL')
  process.exitCode = 1
} else {
  console.log('[MEMORY_ACCEPTANCE] result=PASS')
}
