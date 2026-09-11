/**
 * Memory scope, trigger and persistence contract tests.
 *
 * Historical semantics come from `WeixinHookCs-v02/WeixinHookCs/src/WeixinHook.UI`
 * (`MemoryModels` / `MemoryStore` / `MemoryService` / `MemoryExtractor` /
 * `MemoryRelevance`). Every migration decision that differs from v02 is marked
 * CURRENT_MIGRATION_DECISION in the implementation and asserted here.
 *
 * The identity contract under test is the current trusted one: GROUP requester
 * id and conversation id come from the wire, the role comes from the runtime, and
 * no raw identity may reach a provider prompt or a log line.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runRawAgentPipeline, toAgentRequest, type AgentRequest } from './agent-adapter.js'
import { MENTION_SEPARATOR } from './canonical-user-text.js'
import { buildUserPrompt, type ChatRequestContext } from './chat.js'
import { normalizeRawHookMessage, type InboundMessage, type RawHookMessage } from './message-contract.js'
import type { GroupMessage } from './context.js'
import { MemoryExtractor } from './memory-extractor.js'
import {
  MEMORY_AUTO_FLUSH_BATCH_SIZE,
  MEMORY_CHAT_FLUSH_MINIMUM,
  MEMORY_TIMER_INTERVAL_MS,
  MemoryService,
} from './memory-service.js'
import { MemoryStore, isReleaseArtifactPath, memoryFileIn } from './memory-store.js'
import { MemoryText, type MemoryInputMessage, type MemoryScopeType, type MemoryVisibility } from './memory-models.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import { SpeakerLabelRegistry, isPseudonymousMemberLabel } from './speaker-labels.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

// --------------------------------------------------------------- test harness

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-memory-scope-'))
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
 * The runtime facts a real GROUP request carries into the explicit-memory entry.
 *
 * A persistent memory side effect is only admitted when the runtime confirmed a
 * trusted bot mention token for this message, so a direct service call in a test has
 * to state the same facts the Agent would (see `bot-mention-span.test.ts` for the
 * boundary itself, including the absent and invalid cases).
 */
const TRUSTED_BOT_MENTION = {
  mentionState: 'MENTIONED',
  botMentionSpanTrust: 'VALID',
  botMentionSpanCount: 1,
  userContentSpanTrust: 'VALID',
} as const

function sequentialIds(): () => string {
  let counter = 0
  return () => {
    counter += 1
    return `mem-${counter.toString().padStart(4, '0')}`
  }
}

function steppingClock(start = 1_700_000_000_000): () => number {
  let value = start
  return () => {
    value += 1000
    return value
  }
}

interface Harness {
  directory: string
  filePath: string
  store: MemoryStore
  service: MemoryService
  logs: string[]
  extractorCalls: MemoryInputMessage[][]
  mutateCalls: string[]
  textOf(): string
}

interface HarnessOptions {
  directory?: string
  /** Responses for successive extractor calls; the last one repeats. */
  extractorResponses?: string[]
  mutateResponse?: string
  now?: () => number
  enableTimer?: boolean
}

function createHarness(options: HarnessOptions = {}): Harness {
  const directory = options.directory ?? tempDir()
  const filePath = memoryFileIn(directory)
  const logs: string[] = []
  const extractorCalls: MemoryInputMessage[][] = []
  const mutateCalls: string[] = []
  const responses = options.extractorResponses ?? ['[]']
  const log = (message: string): void => {
    logs.push(message)
  }

  const store = new MemoryStore({ filePath, log, pathSource: 'TEST' })
  const extractor = new MemoryExtractor(async (_system, user) => {
    const messages = parseExtractorInput(user)
    extractorCalls.push(messages)
    const index = Math.min(extractorCalls.length - 1, responses.length - 1)
    const response = responses[index] ?? '[]'
    if (response === 'THROW') {
      throw new Error('synthetic extractor failure')
    }
    return response
  })
  const service = new MemoryService({
    store,
    extractor,
    mutate: async (_system, user) => {
      mutateCalls.push(user)
      return options.mutateResponse ?? '{"operation":"NONE"}'
    },
    now: options.now ?? steppingClock(),
    idFactory: sequentialIds(),
    log,
    enableTimer: options.enableTimer ?? false,
  })

  return {
    directory,
    filePath,
    store,
    service,
    logs,
    extractorCalls,
    mutateCalls,
    textOf: () => logs.join('\n'),
  }
}

/** Narrowing-safe accessors: TypeScript keeps property narrowing across awaits. */
function extractorCallCount(harness: Harness): number {
  return harness.extractorCalls.length
}

function mutationRecordCount(service: MemoryService): number {
  return service.recordCount
}

/** Reverses the extractor input so the assertions can inspect the messages. */
function parseExtractorInput(user: string): MemoryInputMessage[] {
  const body = user.split('messages:\n')[1] ?? ''
  const messages: MemoryInputMessage[] = []
  for (const block of body.split(/\n(?=\[)/u)) {
    const match = /^\[(.+) \| (OWNER|MEMBER)\]\n([\s\S]*)$/u.exec(block.trim())
    if (match) {
      messages.push({ speakerLabel: match[1] as string, role: match[2] as 'OWNER' | 'MEMBER', content: match[3] as string })
    }
  }
  return messages
}

interface CapturingChatService {
  calls: Array<{ context: GroupMessage[]; question: GroupMessage; request: ChatRequestContext }>
  fail: boolean
  reply(context: GroupMessage[], question: GroupMessage, request: ChatRequestContext): Promise<string>
}

function createChatService(): CapturingChatService {
  const service: CapturingChatService = {
    calls: [],
    fail: false,
    async reply(context, question, request): Promise<string> {
      if (service.fail) {
        throw new Error('synthetic provider failure')
      }
      service.calls.push({ context, question, request })
      return 'synthetic reply'
    },
  }
  return service
}

function groupRaw(overrides: Partial<RawHookMessage> = {}): RawHookMessage {
  const from = overrides.from ?? 'room-a@chatroom'
  const signature = overrides.signature ?? 'sig-a'
  const senderId = overrides.senderId ?? signature
  const content = overrides.content ?? '@椰椰 你好'
  return {
    msgId: 'memory-message-1',
    type: 1,
    timestamp: 1_757_000_000_000,
    from,
    wxid: 'shared-account-wxid',
    content,
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
    userContentSpan: overrides.userContentSpan ?? { start: 0, length: content.length },
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
  ownerDisplayName?: string
  /**
   * True when this turn's wire body carries a REAL bot mention token in front of the
   * text, plus the span that identifies it.
   *
   * A persistent memory side effect is only admitted when the runtime confirmed a
   * trusted bot mention token, so a write fixture has to be a real
   * `@<display name><U+2005>command` body — the `@椰椰 ` with a plain space used by the
   * older fixtures is hand-typed text and never was a token.
   */
  botMention?: boolean
}

/** The runtime's real mention token for the synthetic display name used here. */
const BOT_MENTION_TOKEN = `@椰椰${MENTION_SEPARATOR}`

interface Session {
  ask(options?: TurnOptions): Promise<{ request: AgentRequest; reply: string }>
}

/**
 * One production Agent for a whole conversation: the speaker-label registry and
 * the recent-context store live for the session, exactly as in production.
 */
function createSession(service: MemoryService, chat: CapturingChatService): Session {
  const agent = new ProductionChatAgent(chat as never, { memory: service })
  let counter = 0
  return {
    async ask(options: TurnOptions = {}) {
      counter += 1
      const body = options.text ?? '@椰椰 你好'
      const raw = groupRaw({
        from: options.conversationId ?? 'room-a@chatroom',
        conversationId: options.conversationId ?? 'room-a@chatroom',
        signature: options.signature ?? 'sig-a',
        msgId: options.msgId ?? `memory-message-${counter}`,
        content: options.botMention === true ? `${BOT_MENTION_TOKEN}${body}` : body,
        isMentioned: options.isMentioned ?? true,
        requesterRole: options.role ?? 'MEMBER',
        ownerConfigured: (options.role ?? 'MEMBER') === 'OWNER',
        ownerDisplayName: options.ownerDisplayName,
        botMentionSpans: options.botMention === true
          ? [{ start: 0, length: BOT_MENTION_TOKEN.length }]
          : undefined,
      })
      const request = toAgentRequest(validMessage(raw))
      const reply = await agent.complete(request)
      await service.flushAll()
      return { request, reply }
    },
  }
}

/** One production turn through the real ProductionChatAgent + memory runtime. */
async function turn(
  service: MemoryService,
  chat: CapturingChatService,
  options: TurnOptions = {},
): Promise<{ request: AgentRequest; reply: string }> {
  return createSession(service, chat).ask(options)
}

async function retrieve(
  service: MemoryService,
  options: TurnOptions & { question?: string } = {},
): Promise<ReturnType<MemoryService['retrieveForChat']>> {
  return service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: options.conversationId ?? 'room-a@chatroom',
    requesterId: options.signature ?? 'sig-a',
    requesterRole: options.role ?? 'MEMBER',
    question: options.question ?? '我的代号是什么',
  })
}

function seed(
  store: MemoryStore,
  options: {
    scopeType: MemoryScopeType
    scopeId: string
    content: string
    visibility?: MemoryVisibility
    updatedAt?: number
  },
): void {
  const status = store.add({
    memoryId: `seed-${options.scopeType}-${options.scopeId}-${options.content.length}`,
    scopeType: options.scopeType,
    scopeId: options.scopeId,
    content: options.content,
    contentHash: '',
    visibility: options.visibility ?? 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: 'room-a@chatroom',
    sourceSenderId: options.scopeId,
    createdAt: options.updatedAt ?? 1,
    updatedAt: options.updatedAt ?? 1,
    isDeleted: false,
  })
  assert(status === 'WRITTEN', `seed write failed: ${status}`)
}

let feedRun = 0

/** Drives the automatic extractor with `count` admitted messages. */
async function feed(service: MemoryService, count: number, options: TurnOptions & { chatTriggered?: boolean } = {}): Promise<void> {
  feedRun += 1
  const prefix = options.msgId ?? `auto${feedRun}`
  for (let index = 0; index < count; index += 1) {
    service.observeHumanMessage({
      messageId: `${prefix}-${index}`,
      conversationType: 'GROUP',
      conversationId: options.conversationId ?? 'room-a@chatroom',
      requesterId: options.signature ?? 'sig-a',
      requesterRole: options.role ?? 'MEMBER',
      speakerLabel: (options.role ?? 'MEMBER') === 'OWNER' ? 'OWNER' : 'MEMBER_1',
      text: options.text ?? `第 ${index} 条消息`,
      timestamp: 1_757_000_000_000 + index,
      chatTriggered: options.chatTriggered ?? true,
    })
  }
  await service.flushAll()
}

// ------------------------------------------------------------------ the cases

/** 1. Same requester, same conversation: memory persists across turns. */
async function testSameRequesterContinuity(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[{"scope":"MEMBER","content":"A 的代号是 Alpha"}]'] })
  await feed(harness.service, 3, { signature: 'sig-a', text: '记住我的代号是 Alpha' })

  const first = await retrieve(harness.service, { signature: 'sig-a' })
  assert(first.length === 1 && first[0]?.content.includes('Alpha'), 'the same requester lost its personal memory')
  assert(first[0]?.scope === 'PERSONAL', 'personal memory was not classified as PERSONAL')

  const again = await retrieve(harness.service, { signature: 'sig-a' })
  assert(again.length === 1, 'a repeated read changed the personal memory set')
}

/** 2. Real cross-process restart persistence (no shared in-memory map). */
async function testRestartPersistence(): Promise<void> {
  const directory = tempDir()
  const script = fileURLToPath(import.meta.url)
  const runChild = (phase: string): string => {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, MEMORY_RESTART_PHASE: phase, MEMORY_RESTART_DIR: directory },
    })
    assert(result.status === 0, `restart child ${phase} exited ${result.status}: ${result.stderr}`)
    return `${result.stdout}\n${result.stderr}`
  }

  const written = runChild('write')
  assert(written.includes('phase=write handled=true'), `the write process did not store memory: ${written}`)

  const read = runChild('read')
  assert(read.includes('phase=read'), `the read process produced no result: ${read}`)
  assert(read.includes('"content":"我的代号是 Alpha"'), 'the second process could not read the stored memory')
  assert(read.includes('b=[]'), 'another requester read the first requester personal memory after restart')

  // The store file is the only bridge between the two processes.
  const document = JSON.parse(readFileSync(memoryFileIn(directory), 'utf8')) as { records: unknown[] }
  assert(document.records.length === 1, 'the restart store does not hold exactly one record')
}

/** 3. Personal memory is isolated per requester. */
async function testCrossRequesterIsolation(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[{"scope":"MEMBER","content":"A 的代号是 Alpha"}]'] })
  await feed(harness.service, 3, { signature: 'sig-a' })

  const a = await retrieve(harness.service, { signature: 'sig-a' })
  const b = await retrieve(harness.service, { signature: 'sig-b' })
  assert(a.length === 1, 'the owner of the memory lost it')
  assert(b.length === 0, 'another requester read a personal memory')
  assert(harness.textOf().includes('reason=DIRECT') === false, 'unexpected direct diagnostic')
}

/** 4. Personal memory follows the requester across conversations. */
async function testCrossGroupPersonalContinuity(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[{"scope":"MEMBER","content":"A 的代号是 Alpha"}]'] })
  await feed(harness.service, 3, { signature: 'sig-a', conversationId: 'room-a@chatroom' })

  const otherRoom = await retrieve(harness.service, { signature: 'sig-a', conversationId: 'room-b@chatroom' })
  assert(otherRoom.length === 1, 'personal memory did not follow the requester across rooms')

  const otherRequester = await retrieve(harness.service, { signature: 'sig-b', conversationId: 'room-b@chatroom' })
  assert(otherRequester.length === 0, 'cross-room personal memory leaked to another requester')
}

/** 5. Group shared memory is visible to every member of that room. */
async function testGroupSharedSameRoomVisibility(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[{"scope":"GROUP","content":"本群活动时间是周五"}]'] })
  await feed(harness.service, 3, { signature: 'sig-a', conversationId: 'room-a@chatroom' })

  const a = await retrieve(harness.service, { signature: 'sig-a', question: '本群活动时间' })
  const b = await retrieve(harness.service, { signature: 'sig-b', question: '本群活动时间' })
  assert(a.length === 1 && a[0]?.scope === 'GROUP', 'the writer could not read the group memory')
  assert(b.length === 1 && b[0]?.scope === 'GROUP', 'another member of the same room could not read the group memory')
}

/** 6. Group memory is keyed by conversation, never by requester. */
async function testGroupCrossRoomIsolation(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[{"scope":"GROUP","content":"本群活动时间是周五"}]'] })
  await feed(harness.service, 3, { signature: 'sig-a', conversationId: 'room-a@chatroom' })

  const otherRoom = await retrieve(harness.service, {
    signature: 'sig-a',
    conversationId: 'room-b@chatroom',
    question: '本群活动时间',
  })
  assert(otherRoom.length === 0, 'group memory crossed into another conversation')
}

/** 7. Owner personal writes land in the OWNER scope. */
async function testOwnerPersonalScope(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[{"scope":"OWNER","content":"Owner 的代号是 Boss"}]'] })
  await feed(harness.service, 3, { signature: 'sig-o', role: 'OWNER' })

  const record = harness.store.retrieve([{ scopeType: 'OWNER', scopeId: 'sig-o', visibility: 'SHARED' }], 10)
  assert(record.length === 1, 'the owner candidate was not written to the owner scope')
  assert(record[0]?.visibility === 'SHARED', 'a GROUP write was not SHARED')

  const read = await retrieve(harness.service, { signature: 'sig-o', role: 'OWNER' })
  assert(read.length === 1, 'the owner could not read its own personal memory')
}

/** 8. Member personal writes land in the MEMBER scope. */
async function testMemberPersonalScope(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[{"scope":"MEMBER","content":"A 的代号是 Alpha"}]'] })
  await feed(harness.service, 3, { signature: 'sig-a', role: 'MEMBER' })

  const record = harness.store.retrieve([{ scopeType: 'MEMBER', scopeId: 'sig-a', visibility: 'SHARED' }], 10)
  assert(record.length === 1, 'the member candidate was not written to the member scope')
  const ownerScope = harness.store.retrieve([{ scopeType: 'OWNER', scopeId: 'sig-a', visibility: 'SHARED' }], 10)
  assert(ownerScope.length === 0, 'a member write reached the owner scope')
}

/** 9. A member can never read the owner's personal memory. */
async function testMemberCannotReadOwnerPersonal(): Promise<void> {
  const harness = createHarness()
  seed(harness.store, { scopeType: 'OWNER', scopeId: 'sig-o', content: 'Owner 的代号是 Boss' })

  const member = await retrieve(harness.service, { signature: 'sig-a', role: 'MEMBER', question: 'Owner 的代号是什么' })
  assert(member.length === 0, 'a member read the owner personal memory')
}

/** 10. The owner does not automatically read another member's personal memory. */
async function testOwnerCannotReadMemberPersonal(): Promise<void> {
  const harness = createHarness()
  seed(harness.store, { scopeType: 'MEMBER', scopeId: 'sig-b', content: 'B 的代号是 Beta' })

  const owner = await retrieve(harness.service, { signature: 'sig-o', role: 'OWNER', question: 'B 的代号是什么' })
  assert(owner.length === 0, 'the owner read another member personal memory')
}

/** 11. PRIVATE records are never injected into a GROUP prompt. */
async function testPrivateNeverInjectedIntoGroup(): Promise<void> {
  const harness = createHarness()
  seed(harness.store, { scopeType: 'MEMBER', scopeId: 'sig-a', content: 'A 的代号是 SecretPersonal', visibility: 'PRIVATE' })
  seed(harness.store, { scopeType: 'GROUP', scopeId: 'room-a@chatroom', content: '本群代号是 SecretGroup', visibility: 'PRIVATE' })
  seed(harness.store, { scopeType: 'MEMBER', scopeId: 'sig-a', content: 'A 的代号是 Alpha' })

  const items = await retrieve(harness.service, { signature: 'sig-a', question: '我的代号是什么' })
  assert(items.length === 1 && items[0]?.content === 'A 的代号是 Alpha', `PRIVATE memory reached GROUP retrieval: ${JSON.stringify(items)}`)
  assert(!JSON.stringify(items).includes('Secret'), 'a PRIVATE record was injected into GROUP memory')
}

/** 12. SHARED memory is injected according to its scope. */
async function testSharedInjectedByScope(): Promise<void> {
  const harness = createHarness()
  seed(harness.store, { scopeType: 'MEMBER', scopeId: 'sig-a', content: 'A 的代号是 Alpha' })
  seed(harness.store, { scopeType: 'GROUP', scopeId: 'room-a@chatroom', content: '本群活动时间是周五' })

  const items = await retrieve(harness.service, { signature: 'sig-a', question: '我的代号和本群活动时间' })
  assert(items.length === 2, `expected personal + group memory, got ${items.length}`)
  assert(items.some((item) => item.scope === 'PERSONAL'), 'personal memory was not labelled PERSONAL')
  assert(items.some((item) => item.scope === 'GROUP'), 'group memory was not labelled GROUP')
}

/** 13. Explicit "记住": OWNER only, historical scope routing and replies. */
async function testExplicitRememberHistoricalBehavior(): Promise<void> {
  const harness = createHarness({
    mutateResponse: '{"operation":"ADD","target":null,"content":"我的代号是 Alpha","scope":"OWNER"}',
  })

  const owner = await harness.service.tryHandleExplicit({
    conversationType: 'GROUP',
    conversationId: 'room-a@chatroom',
    requesterId: 'sig-o',
    requesterRole: 'OWNER',
    question: '记住我的代号是 Alpha',
    ...TRUSTED_BOT_MENTION,
  })
  assert(owner.handled && owner.reply === '记住了。', `unexpected explicit result: ${JSON.stringify(owner)}`)
  const personal = harness.store.retrieve([{ scopeType: 'OWNER', scopeId: 'sig-o', visibility: 'SHARED' }], 10)
  assert(personal.length === 1 && personal[0]?.origin === 'EXPLICIT_OWNER', 'the explicit add did not use the owner scope')

  // Group keywords route the explicit add to the conversation scope.
  const groupScoped = await harness.service.tryHandleExplicit({
    conversationType: 'GROUP',
    conversationId: 'room-a@chatroom',
    requesterId: 'sig-o',
    requesterRole: 'OWNER',
    question: '记住以后这个群活动时间是周五',
    ...TRUSTED_BOT_MENTION,
  })
  assert(groupScoped.handled, 'the group-scoped explicit request was not handled')
  const group = harness.store.retrieve([{ scopeType: 'GROUP', scopeId: 'room-a@chatroom', visibility: 'SHARED' }], 10)
  assert(group.length === 1, 'the group-scoped explicit add did not use the conversation scope')

  // A member can never reach the explicit path, whatever the text says.
  const member = await harness.service.tryHandleExplicit({
    conversationType: 'GROUP',
    conversationId: 'room-a@chatroom',
    requesterId: 'sig-a',
    requesterRole: 'MEMBER',
    question: '记住我的代号是 Alpha',
    ...TRUSTED_BOT_MENTION,
  })
  assert(member.handled === false, 'a member triggered the owner-only explicit path')

  // DIRECT stays out of memory entirely (identity still unverified).
  const direct = await harness.service.tryHandleExplicit({
    conversationType: 'DIRECT',
    conversationId: 'private-a',
    requesterId: 'private-a',
    requesterRole: 'OWNER',
    question: '记住我的代号是 Alpha',
    ...TRUSTED_BOT_MENTION,
  })
  assert(direct.handled === false, 'DIRECT memory was enabled')
}

/** 14. Historical batch threshold 8. */
async function testBatchThreshold(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[]'] })
  await feed(harness.service, MEMORY_AUTO_FLUSH_BATCH_SIZE - 1, { chatTriggered: false })
  assert(extractorCallCount(harness) === 0, 'the extractor ran before the batch threshold')
  await feed(harness.service, 1, { chatTriggered: false })
  assert(extractorCallCount(harness) === 1, 'the batch threshold did not trigger the extractor')
  assert(harness.extractorCalls[0]?.length === MEMORY_AUTO_FLUSH_BATCH_SIZE, 'the batch did not contain every pending message')
  assert(harness.textOf().includes('trigger=AUTO_BATCH'), 'the batch trigger was not reported')
}

/** 15. Historical chat-triggered threshold 3. */
async function testChatThreshold(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[]'] })
  await feed(harness.service, MEMORY_CHAT_FLUSH_MINIMUM - 1, { chatTriggered: true })
  assert(extractorCallCount(harness) === 0, 'the extractor ran before the chat threshold')

  await feed(harness.service, 2, { chatTriggered: false })
  assert(extractorCallCount(harness) === 0, 'a non chat-triggered message flushed early')

  await feed(harness.service, 1, { chatTriggered: true })
  assert(extractorCallCount(harness) === 1, 'the chat threshold did not trigger the extractor')
  // The threshold is the trigger minimum; the batch itself is every pending
  // message, exactly like the historical `TryBeginFlush`.
  assert(harness.extractorCalls[0]?.length === 5, 'the chat batch did not contain every pending message')
  assert(harness.textOf().includes('trigger=AUTO_CHAT_THRESHOLD'), 'the chat threshold trigger was not reported')
}

/** 16. Historical 5-minute timer flush. */
async function testTimerFlush(): Promise<void> {
  assert(MEMORY_TIMER_INTERVAL_MS === 300_000, 'the timer interval is not the historical five minutes')

  const harness = createHarness({ extractorResponses: ['[]'] })
  await feed(harness.service, 2, { chatTriggered: false })
  harness.service.flushPendingBuffers()
  await harness.service.flushAll()
  assert(extractorCallCount(harness) === 0, 'the timer flushed a buffer below the minimum')

  await feed(harness.service, 1, { chatTriggered: false })
  harness.service.flushPendingBuffers()
  await harness.service.flushAll()
  assert(extractorCallCount(harness) === 1, 'the timer did not flush a buffer at the minimum')
  assert(harness.textOf().includes('trigger=AUTO_TIMER'), 'the timer trigger was not reported')
}

/**
 * 16b. The timer may only extract and write memory. It must never reach the chat
 * provider, and it must never produce a reply or an outbound command: the only
 * outbound producer in this process answers one inbound line, so a background
 * flush that stayed on the memory path can never send anything by itself.
 */
async function testTimerNeverReplies(): Promise<void> {
  const directory = tempDir()
  const logs: string[] = []
  const chat = createChatService()
  const structuredCalls: string[] = []
  const store = new MemoryStore({
    filePath: memoryFileIn(directory),
    log: (message) => logs.push(message),
    pathSource: 'TEST',
  })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async (_system, user) => {
      structuredCalls.push(user)
      return '[{"scope":"MEMBER","content":"A 的代号是 Alpha"}]'
    }),
    mutate: async (_system, user) => {
      structuredCalls.push(user)
      return '{"operation":"NONE"}'
    },
    now: steppingClock(),
    idFactory: sequentialIds(),
    log: (message) => logs.push(message),
    enableTimer: false,
  })

  // Memory intake only: no agent turn and no inbound line is produced here.
  for (let index = 0; index < 3; index += 1) {
    service.observeHumanMessage({
      messageId: `timer-${index}`,
      conversationType: 'GROUP',
      conversationId: 'room-a@chatroom',
      requesterId: 'sig-a',
      requesterRole: 'MEMBER',
      speakerLabel: 'MEMBER_1',
      text: `第 ${index} 条消息`,
      timestamp: index,
      chatTriggered: false,
    })
  }

  service.flushPendingBuffers()
  await service.flushAll()

  assert(structuredCalls.length === 1, 'the timer did not run exactly one memory completion')
  assert(chat.calls.length === 0, 'the memory timer reached the chat provider')
  assert(store.liveRecordCount === 1, 'the timer flush did not write memory')
  assert(!logs.join('\n').includes('OUTBOUND'), 'the memory timer produced an outbound diagnostic')
}

/** 17. One message enters the memory pipeline exactly once. */
async function testDuplicateMessageWritesOnce(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[{"scope":"MEMBER","content":"A 的代号是 Alpha"}]'] })
  await feed(harness.service, 3, { chatTriggered: true, msgId: 'dup' })
  assert(extractorCallCount(harness) === 1, 'the first batch did not run once')
  assert(harness.service.recordCount === 1, 'the first batch did not write exactly one record')

  harness.service.observeHumanMessage({
    messageId: 'dup-0',
    conversationType: 'GROUP',
    conversationId: 'room-a@chatroom',
    requesterId: 'sig-a',
    requesterRole: 'MEMBER',
    speakerLabel: 'MEMBER_1',
    text: '第 0 条消息',
    timestamp: 1,
    chatTriggered: true,
  })
  await harness.service.flushAll()
  assert(extractorCallCount(harness) === 1, 'a duplicate message re-entered the memory pipeline')
  assert(harness.service.recordCount === 1, 'a duplicate message wrote a second record')
  assert(harness.textOf().includes('reason=DUPLICATE_MESSAGE'), 'the duplicate was not reported')
}

/** 18. A GROUP message that is not mentioned never reads or writes memory. */
async function testNoMentionMemoryZero(): Promise<void> {
  const harness = createHarness()
  const chat = createChatService()
  const agent = new ProductionChatAgent(chat as never, { memory: harness.service })
  const result = await runRawAgentPipeline(groupRaw({ isMentioned: false }), agent)
  assert(result.status === 'IGNORED', 'an unmentioned group message was not ignored')
  assert(chat.calls.length === 0, 'an unmentioned group message reached the provider')
  assert(extractorCallCount(harness) === 0, 'an unmentioned group message entered memory')
  assert(harness.service.recordCount === 0, 'an unmentioned group message wrote memory')
  assert(!harness.textOf().includes('[MEMORY_READ]'), 'an unmentioned group message triggered a memory read')
}

/** 19. A self echo never reads or writes memory (it is dropped before the Agent). */
async function testSelfEchoMemoryZero(): Promise<void> {
  const harness = createHarness()
  const chat = createChatService()
  const agent = new ProductionChatAgent(chat as never, { memory: harness.service })

  // The runtime drops the bot's own message before the wire; on the Agent side
  // such a message can only ever appear as unmentioned, which is the same gate.
  const echo = await runRawAgentPipeline(
    groupRaw({ isMentioned: false, content: '@椰椰 这是我自己刚才说的话' }),
    agent,
  )
  assert(echo.status === 'IGNORED', 'a self echo was admitted')
  assert(extractorCallCount(harness) === 0 && harness.service.recordCount === 0, 'a self echo reached memory')

  // Structural invariant: memory is only reachable from the Agent executor, so
  // no transport/normalization path can write memory behind the gates.
  const transport = readFileSync(new URL('../src/production-agent-transport.ts', import.meta.url), 'utf8')
  const adapter = readFileSync(new URL('../src/agent-adapter.ts', import.meta.url), 'utf8')
  assert(!/memory-service|memory-store|memory-extractor/u.test(transport), 'the transport imports the memory runtime')
  assert(!/memory-service|memory-store|memory-extractor/u.test(adapter), 'the pipeline imports the memory runtime')
}

/** 20. A malformed extractor response writes nothing. */
async function testMalformedExtractorNoWrite(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['not json at all'] })
  await feed(harness.service, 3, { chatTriggered: true })
  assert(harness.service.recordCount === 0, 'a malformed extractor response wrote memory')

  const failing = createHarness({ extractorResponses: ['THROW'] })
  await feed(failing.service, 3, { chatTriggered: true })
  assert(failing.service.recordCount === 0, 'a failed extractor wrote memory')
  assert(failing.textOf().includes('reason=EXTRACTOR_FAILED'), 'an extractor failure was not reported')
  assert(failing.textOf().includes('result=FAIL'), 'an extractor failure was not observable')
}

/** 21. An empty extractor response writes nothing. */
async function testEmptyExtractorNoWrite(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[]', '{"candidates":[]}', '[{"scope":"BOGUS","content":"x"},{"scope":"MEMBER","content":"  "}]'] })
  await feed(harness.service, 3, { chatTriggered: true })
  await feed(harness.service, 3, { chatTriggered: true, msgId: 'empty-2' })
  await feed(harness.service, 3, { chatTriggered: true, msgId: 'empty-3' })
  assert(harness.service.recordCount === 0, 'an empty or invalid candidate list wrote memory')
}

/** 22. Provider reasoning is never persisted as memory. */
async function testReasoningNeverPersisted(): Promise<void> {
  const harness = createHarness({
    extractorResponses: ['<think>我在推理用户想让我记住什么</think>[{"scope":"MEMBER","content":"A 的代号是 Alpha"}]'],
  })
  await feed(harness.service, 3, { chatTriggered: true })
  assert(harness.service.recordCount === 1, 'the balanced thinking block broke extraction')
  const stored = harness.store.retrieve([{ scopeType: 'MEMBER', scopeId: 'sig-a', visibility: 'SHARED' }], 10)
  assert(stored[0]?.content === 'A 的代号是 Alpha', 'thinking markup leaked into memory')
  assert(!stored[0]?.content.includes('推理'), 'reasoning text was persisted')

  const unterminated = createHarness({ extractorResponses: ['<think>只有推理，没有结论'] })
  await feed(unterminated.service, 3, { chatTriggered: true })
  assert(unterminated.service.recordCount === 0, 'an unterminated thinking block was persisted')

  const mutation = createHarness({ mutateResponse: '<think>我在推理</think>{"operation":"NONE"}' })
  const explicit = await mutation.service.tryHandleExplicit({
    conversationType: 'GROUP',
    conversationId: 'room-a@chatroom',
    requesterId: 'sig-o',
    requesterRole: 'OWNER',
    question: '记住我的代号是 Alpha',
    ...TRUSTED_BOT_MENTION,
  })
  assert(explicit.reply === '这条记忆没有保存成功。', 'a reasoning-only mutation was accepted')
  assert(mutationRecordCount(mutation.service) === 0, 'a reasoning-only mutation wrote memory')
}

/** 23. No raw identity reaches the provider prompt; memory content is masked. */
async function testRawIdentityNeverReachesProvider(): Promise<void> {
  const harness = createHarness()
  seed(harness.store, { scopeType: 'MEMBER', scopeId: 'sig-a', content: 'A 的代号是 Alpha' })
  seed(harness.store, { scopeType: 'GROUP', scopeId: 'room-a@chatroom', content: '本群活动时间是周五' })
  const chat = createChatService()
  await turn(harness.service, chat, { signature: 'sig-a', text: '我的代号是啥，本群活动时间是几点' })

  const call = chat.calls[0]
  assert(call !== undefined, 'the provider was not called')
  const prompt = buildUserPrompt(call.context, call.question, call.request)
  for (const raw of ['sig-a', 'room-a@chatroom', 'shared-account-wxid']) {
    assert(!prompt.includes(raw), `a raw identity reached the provider prompt: ${raw}`)
  }
  assert(prompt.includes('[Authorized Personal Memory]'), 'the personal memory section is missing')
  assert(prompt.includes('[Authorized Group Memory]'), 'the group memory section is missing')
  assert(prompt.includes('A 的代号是 Alpha'), 'personal memory content is missing from the prompt')
  assert(prompt.includes('本群活动时间是周五'), 'group memory content is missing from the prompt')
  assert(MemoryText.forModel('联系 wxid_abc123 那个人') === '联系 群成员 那个人', 'the raw identity mask changed')
}

/** 24. No raw identity or memory content reaches a log line. */
async function testRawIdentityNeverLogged(): Promise<void> {
  const harness = createHarness({
    mutateResponse: '{"operation":"ADD","target":null,"content":"我的代号是 Alpha","scope":"OWNER"}',
  })
  const chat = createChatService()
  await turn(harness.service, chat, { signature: 'sig-o', role: 'OWNER', text: '记住我的代号是 Alpha', ownerDisplayName: 'Boss', botMention: true })
  await turn(harness.service, chat, { signature: 'sig-a', role: 'MEMBER', text: '我的代号是什么' })

  const text = harness.textOf()
  assert(text.includes('[MEMORY_STORE]'), 'the store produced no diagnostics')
  assert(text.includes('[MEMORY_WRITE]'), 'no memory write was reported')
  assert(text.includes('[MEMORY_READ]'), 'no memory read was reported')
  assert(text.includes('[MEMORY_TRIGGER]'), 'no memory trigger was reported')
  for (const raw of ['sig-o', 'sig-a', 'room-a@chatroom', 'shared-account-wxid', 'Boss', 'Alpha']) {
    assert(!text.includes(raw), `a raw identity or memory content reached a log line: ${raw}`)
  }
}

/** 25. A provider failure never fabricates a memory write. */
async function testProviderFailureNoFalseWrite(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[{"scope":"MEMBER","content":"A 的代号是 Alpha"}]'] })
  const chat = createChatService()
  chat.fail = true
  let failed = false
  try {
    await turn(harness.service, chat, { signature: 'sig-a', text: '你好' })
  } catch {
    failed = true
  }
  assert(failed, 'the provider failure was swallowed')
  assert(harness.service.recordCount === 0, 'a provider failure wrote memory')
  assert(!harness.textOf().includes('[MEMORY_WRITE]'), 'a provider failure produced a memory write log')
}

/** 26. A store write failure is observable and never pretended to be persisted. */
async function testWriteFailureObservable(): Promise<void> {
  const directory = tempDir()
  const filePath = memoryFileIn(directory)
  const logs: string[] = []
  const store = new MemoryStore({ filePath, log: (message) => logs.push(message), pathSource: 'TEST' })
  assert(store.isEnabled, 'the store did not initialize')

  // Replace the target with a directory so the atomic rename must fail.
  rmSync(filePath, { force: true })
  mkdirSync(filePath)

  const status = store.add({
    memoryId: 'fail-1',
    scopeType: 'MEMBER',
    scopeId: 'sig-a',
    content: 'A 的代号是 Alpha',
    contentHash: '',
    visibility: 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: 'room-a@chatroom',
    sourceSenderId: 'sig-a',
    createdAt: 1,
    updatedAt: 1,
    isDeleted: false,
  })
  assert(status === 'FAILED', `a failed save reported ${status}`)
  assert(store.liveRecordCount === 0, 'a failed save kept a phantom in-memory record')
  assert(logs.join('\n').includes('operation=SAVE result=FAIL'), 'the save failure was not reported')
}

/** 27. A broken store degrades explicitly and chat still works. */
async function testReadFailureObservable(): Promise<void> {
  const directory = tempDir()
  const blocker = join(directory, 'not-a-directory')
  writeFileSync(blocker, 'x', 'utf8')
  const logs: string[] = []
  const store = new MemoryStore({
    filePath: join(blocker, 'memory.json'),
    log: (message) => logs.push(message),
    pathSource: 'TEST',
  })
  assert(!store.isEnabled, 'a store under a file path reported itself enabled')

  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => '{"operation":"NONE"}',
    log: (message) => logs.push(message),
  })
  const items = await retrieve(service, { signature: 'sig-a' })
  assert(items.length === 0, 'a disabled store returned memory')
  const text = logs.join('\n')
  assert(text.includes('operation=INIT result=FAIL'), 'the store init failure was not reported')
  assert(text.includes('[MEMORY_READ]') && text.includes('result=FAIL'), 'the read degradation was not reported')
  assert(text.includes('reason=STORE_UNAVAILABLE'), 'the read degradation reason is missing')

  // Chat still works with a broken store.
  const chat = createChatService()
  await turn(service, chat, { signature: 'sig-a', text: '你好' })
  assert(chat.calls.length === 1, 'a broken store broke normal chat')
}

/** 28. Recent context and persistent memory stay separate stores. */
async function testRecentContextSeparatedFromMemory(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[]'] })
  const chat = createChatService()
  const session = createSession(harness.service, chat)
  await session.ask({ signature: 'sig-a', text: '今天天气不错' })
  await session.ask({ signature: 'sig-a', text: '刚才说什么', msgId: 'memory-message-2' })

  assert(harness.service.recordCount === 0, 'recent context was auto-promoted to memory')
  const prompt = buildUserPrompt(chat.calls[1]!.context, chat.calls[1]!.question, chat.calls[1]!.request)
  assert(prompt.includes('[Recent Group Context]'), 'the recent context section is missing')
  assert(prompt.includes('今天天气不错'), 'the recent context lost the earlier message')
  assert(prompt.includes('[Authorized Personal Memory]\n（无）'), 'an empty personal memory section is not explicit')
  assert(prompt.includes('[Authorized Group Memory]\n（无）'), 'an empty group memory section is not explicit')
}

/** 29. Two members in one room are never conflated in memory or transcript. */
async function testSpeakerAttributionDoesNotConfusePersonalMemory(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[{"scope":"MEMBER","content":"A 的代号是 Alpha"}]'] })
  const chat = createChatService()

  // A tells the bot its codename; the automatic batch writes A's personal scope.
  await feed(harness.service, 3, { signature: 'sig-a', text: '我的代号是 Alpha' })
  assert(harness.service.recordCount === 1, 'A personal memory was not written')
  const records = harness.store.retrieve([{ scopeType: 'MEMBER', scopeId: 'sig-a', visibility: 'SHARED' }], 10)
  assert(records.length === 1, 'A personal memory is missing')
  const bRecords = harness.store.retrieve([{ scopeType: 'MEMBER', scopeId: 'sig-b', visibility: 'SHARED' }], 10)
  assert(bRecords.length === 0, 'A personal memory was keyed to B')

  // A turn, then B turn in the same room, through one production session.
  const session = createSession(harness.service, chat)
  await session.ask({ signature: 'sig-a', text: '我的代号是什么', msgId: 'attr-a' })
  await session.ask({ signature: 'sig-b', text: '我的代号是什么', msgId: 'attr-b' })

  const aCall = chat.calls[0]!
  const bCall = chat.calls[1]!
  const aPrompt = buildUserPrompt(aCall.context, aCall.question, aCall.request)
  const bPrompt = buildUserPrompt(bCall.context, bCall.question, bCall.request)

  assert(aPrompt.includes('A 的代号是 Alpha'), 'A could not read its own personal memory')
  assert(!bPrompt.includes('A 的代号是 Alpha'), 'B was injected with A personal memory')
  assert(bCall.request.memory?.length === 0, 'B received a non-empty memory context')

  // The transcript must distinguish the two members without exposing identity.
  const aLabel = aCall.question.senderName
  const bLabel = bCall.question.senderName
  assert(isPseudonymousMemberLabel(aLabel) && isPseudonymousMemberLabel(bLabel), 'member labels are not pseudonymous')
  assert(aLabel !== bLabel, 'two members share one speaker label')
  assert(bCall.request.currentSpeakerLabel === bLabel, 'the prompt does not state the current speaker label')
  assert(!/[A-Za-z0-9+/=]{8,}/u.test(bLabel), 'a speaker label looks like a raw identity token')
  const bContextLabels = bCall.context.map((item) => item.senderName)
  assert(bContextLabels.includes(aLabel), 'B transcript lost A earlier turn')
  assert(!bContextLabels.includes('sig-a') && !bContextLabels.includes('sig-b'), 'a raw requester id leaked into the transcript')
}

/** 30. GROUP reply / recipient / mention / FINAL_ANSWER boundaries are intact. */
async function testGroupRegressions(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[]'] })
  const chat = createChatService()
  const agent = new ProductionChatAgent(chat as never, { memory: harness.service })

  const mentioned = await runRawAgentPipeline(
    groupRaw({ from: 'room-z@chatroom', msgId: 'regression-1', content: '<think>推理</think>群回复' }),
    agent,
  )
  assert(mentioned.status === 'AGENT_RESULT', 'a mentioned group message did not reach the agent')
  assert(mentioned.outboundCommand?.conversationType === 'GROUP', 'the group recipient type changed')
  assert(mentioned.outboundCommand?.conversationId === 'room-z@chatroom', 'the group recipient id changed')
  assert(mentioned.outboundCommand?.text === 'synthetic reply', 'the reply text changed')

  const scripted = new ProductionChatAgent(
    { reply: async () => '<think>推理</think>群回复' } as never,
    { memory: harness.service },
  )
  const finalAnswer = await runRawAgentPipeline(groupRaw({ msgId: 'regression-2' }), scripted)
  assert(finalAnswer.status === 'AGENT_RESULT', 'the final-answer case did not reach the agent')
  assert(finalAnswer.outboundCommand?.text === '群回复', 'the FINAL_ANSWER boundary regressed')

  const notMentioned = await runRawAgentPipeline(groupRaw({ isMentioned: false, msgId: 'regression-3' }), agent)
  assert(notMentioned.status === 'IGNORED', 'the no-mention gate regressed')
}

/** Extra: corruption is reported and never silently overwritten. */
async function testCorruptionIsExplicit(): Promise<void> {
  const directory = tempDir()
  const filePath = memoryFileIn(directory)
  writeFileSync(filePath, '{ this is not json', 'utf8')
  const logs: string[] = []
  const store = new MemoryStore({ filePath, log: (message) => logs.push(message), pathSource: 'TEST' })

  assert(!store.isEnabled, 'a corrupt store reported itself enabled')
  assert(store.disabledReason === 'CORRUPT', `unexpected corrupt reason: ${store.disabledReason}`)
  assert(logs.join('\n').includes('operation=LOAD result=FAIL reason=CORRUPT'), 'corruption was not reported')
  assert(store.add({
    memoryId: 'corrupt-1',
    scopeType: 'MEMBER',
    scopeId: 'sig-a',
    content: 'x',
    contentHash: '',
    visibility: 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: 'room-a@chatroom',
    sourceSenderId: 'sig-a',
    createdAt: 1,
    updatedAt: 1,
    isDeleted: false,
  }) === 'DISABLED', 'a corrupt store accepted a write')
  assert(readFileSync(filePath, 'utf8') === '{ this is not json', 'a corrupt store overwrote its own data')
}

/** Extra: runtime memory data may never live in a release artifact root. */
async function testReleaseArtifactPathRejected(): Promise<void> {
  assert(isReleaseArtifactPath('E:/wxhook/WeixinHookCs/artifacts/p0-x/memory.json'), 'an artifact path was accepted')
  assert(isReleaseArtifactPath('E:/wxhook/WeixinHookCs/artifacts/p0-owner/freeze/memory.json'), 'a freeze path was accepted')
  assert(!isReleaseArtifactPath('C:/Users/tester/AppData/Local/WeChatAgent/memory/memory.json'), 'a runtime path was rejected')

  const logs: string[] = []
  const store = new MemoryStore({
    filePath: join(tempDir(), 'artifacts', 'p0-fake', 'memory.json'),
    log: (message) => logs.push(message),
    pathSource: 'TEST',
  })
  assert(!store.isEnabled, 'the store accepted an artifact path')
  assert(logs.join('\n').includes('reason=RESERVED_RELEASE_PATH'), 'the reserved path was not reported')
}

/** Extra: the memory path default is runtime data, not a release artifact. */
async function testDefaultMemoryPathIsRuntimeData(): Promise<void> {
  const { resolveMemoryFilePath } = await import('./config.js')
  const resolved = resolveMemoryFilePath()
  assert(resolved.filePath.endsWith('memory.json'), 'the default memory path is not a memory file')
  assert(!isReleaseArtifactPath(resolved.filePath), 'the default memory path is inside a release artifact root')
  assert(dirname(resolved.filePath).length > 0, 'the default memory path has no directory')
}

/** Extra: DIRECT memory stays disabled while DIRECT identity is unverified. */
async function testDirectMemoryDisabled(): Promise<void> {
  const harness = createHarness({ extractorResponses: ['[{"scope":"MEMBER","content":"不该被写入"}]'] })
  seed(harness.store, { scopeType: 'MEMBER', scopeId: 'private-a', content: 'DIRECT 私聊记忆', visibility: 'PRIVATE' })

  const chat = createChatService()
  const agent = new ProductionChatAgent(chat as never, { memory: harness.service })
  const direct = normalizeRawHookMessage({
    msgId: 'direct-1',
    type: 1,
    timestamp: 1_757_000_000_000,
    from: 'private-a',
    wxid: 'shared-account-wxid',
    content: '你好',
    signature: '',
    conversationType: 'DIRECT',
    conversationId: 'private-a',
    isMentioned: null,
  })
  assert(direct.status === 'VALID', 'the DIRECT fixture is invalid')
  await agent.complete(toAgentRequest(direct.message))
  await harness.service.flushAll()

  assert(chat.calls.length === 1, 'the DIRECT turn did not reach the provider')
  assert(chat.calls[0]?.request.memory?.length === 0, 'DIRECT received memory')
  assert(harness.service.recordCount === 1, 'a DIRECT turn wrote memory')
  assert(extractorCallCount(harness) === 0, 'a DIRECT turn entered the extractor')
  const text = harness.textOf()
  assert(text.includes('reason=DIRECT_IDENTITY_UNVERIFIED'), 'the DIRECT skip was not reported')
  assert(text.includes('reason=DIRECT_MEMORY_DISABLED'), 'the DIRECT read skip was not reported')

  const explicit = await harness.service.tryHandleExplicit({
    conversationType: 'DIRECT',
    conversationId: 'private-a',
    requesterId: 'private-a',
    requesterRole: 'OWNER',
    question: '记住我的代号是 Alpha',
    ...TRUSTED_BOT_MENTION,
  })
  assert(explicit.handled === false, 'DIRECT explicit remember was enabled')
}

// ------------------------------------------------------------------ execution

const CASES: Array<[string, () => Promise<void>]> = [
  ['same-requester-continuity', testSameRequesterContinuity],
  ['restart-persistence', testRestartPersistence],
  ['cross-requester-personal-isolation', testCrossRequesterIsolation],
  ['requester-cross-group-continuity', testCrossGroupPersonalContinuity],
  ['group-shared-same-room-visibility', testGroupSharedSameRoomVisibility],
  ['group-shared-cross-room-isolation', testGroupCrossRoomIsolation],
  ['owner-personal-scope', testOwnerPersonalScope],
  ['member-personal-scope', testMemberPersonalScope],
  ['member-cannot-read-owner-personal', testMemberCannotReadOwnerPersonal],
  ['owner-cannot-read-member-personal', testOwnerCannotReadMemberPersonal],
  ['private-not-injected-into-group', testPrivateNeverInjectedIntoGroup],
  ['shared-injected-by-scope', testSharedInjectedByScope],
  ['explicit-remember-historical-behavior', testExplicitRememberHistoricalBehavior],
  ['batch-trigger-historical-behavior', testBatchThreshold],
  ['chat-threshold-historical-behavior', testChatThreshold],
  ['timer-historical-behavior', testTimerFlush],
  ['timer-never-replies', testTimerNeverReplies],
  ['duplicate-message-writes-once', testDuplicateMessageWritesOnce],
  ['no-mention-memory-zero', testNoMentionMemoryZero],
  ['self-echo-memory-zero', testSelfEchoMemoryZero],
  ['malformed-extractor-no-write', testMalformedExtractorNoWrite],
  ['empty-extractor-no-write', testEmptyExtractorNoWrite],
  ['reasoning-never-persisted', testReasoningNeverPersisted],
  ['raw-identity-not-sent-to-provider', testRawIdentityNeverReachesProvider],
  ['raw-identity-not-logged', testRawIdentityNeverLogged],
  ['provider-failure-no-false-write', testProviderFailureNoFalseWrite],
  ['write-failure-observable', testWriteFailureObservable],
  ['read-failure-observable', testReadFailureObservable],
  ['recent-context-separated-from-memory', testRecentContextSeparatedFromMemory],
  ['speaker-attribution-keeps-personal-memory', testSpeakerAttributionDoesNotConfusePersonalMemory],
  ['group-regressions-unchanged', testGroupRegressions],
  ['corruption-is-explicit', testCorruptionIsExplicit],
  ['release-artifact-path-rejected', testReleaseArtifactPathRejected],
  ['default-memory-path-is-runtime-data', testDefaultMemoryPathIsRuntimeData],
  ['direct-memory-disabled', testDirectMemoryDisabled],
]

async function runRestartChild(phase: string): Promise<void> {
  const directory = process.env.MEMORY_RESTART_DIR ?? ''
  const logs: string[] = []
  const store = new MemoryStore({ filePath: memoryFileIn(directory), log: (message) => logs.push(message), pathSource: 'RESTART_CHILD' })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => '{"operation":"ADD","target":null,"content":"我的代号是 Alpha","scope":"OWNER"}',
    now: () => 1_700_000_000_000,
    idFactory: sequentialIds(),
    log: (message) => logs.push(message),
  })

  if (phase === 'write') {
    const result = await service.tryHandleExplicit({
      conversationType: 'GROUP',
      conversationId: 'room-x@chatroom',
      requesterId: 'sig-a',
      requesterRole: 'OWNER',
      question: '记住我的代号是 Alpha',
      ...TRUSTED_BOT_MENTION,
    })
    console.log(`[MEMORY_RESTART_CHILD] phase=write handled=${result.handled} records=${service.recordCount}`)
  } else {
    const a = await service.retrieveForChat({
      conversationType: 'GROUP',
      conversationId: 'room-x@chatroom',
      requesterId: 'sig-a',
      requesterRole: 'OWNER',
      question: '我的代号是什么',
    })
    const b = await service.retrieveForChat({
      conversationType: 'GROUP',
      conversationId: 'room-x@chatroom',
      requesterId: 'sig-b',
      requesterRole: 'MEMBER',
      question: '我的代号是什么',
    })
    console.log(`[MEMORY_RESTART_CHILD] phase=read a=${JSON.stringify(a)} b=${JSON.stringify(b)}`)
  }

  service.close()
}

async function main(): Promise<void> {
  const phase = process.env.MEMORY_RESTART_PHASE
  if (phase === 'write' || phase === 'read') {
    await runRestartChild(phase)
    return
  }

  let failures = 0
  for (const [name, run] of CASES) {
    try {
      await run()
      console.log(`[MEMORY_SCOPE_CASE] name=${name} result=PASS`)
    } catch (error) {
      failures += 1
      const message = error instanceof Error ? error.message : String(error)
      console.log(`[MEMORY_SCOPE_CASE] name=${name} result=FAIL message=${message}`)
    }
  }

  cleanup()
  console.log(`[MEMORY_SCOPE_TEST_SUMMARY] cases=${CASES.length} failures=${failures}`)
  if (failures > 0) {
    console.log('[MEMORY_SCOPE] result=FAIL')
    process.exitCode = 1
    return
  }
  console.log('[MEMORY_SCOPE] result=PASS')
}

void main()
