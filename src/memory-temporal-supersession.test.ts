/** Temporal current-value Memory regressions. All data is synthetic. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryExtractor } from './memory-extractor.js'
import { MemoryService, memberScopeId } from './memory-service.js'
import {
  MEMORY_SLOTS,
  MemoryText,
  type MemoryRecord,
  type MemorySlot,
} from './memory-models.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'
import { PersistentRuntimeLog, PersistentRuntimeLogSink } from './persistent-runtime-log.js'

const ROOM = 'room-temporal-test@chatroom'
const REQUESTER = 'requester-temporal-test'
const SCOPE_ID = memberScopeId(ROOM, REQUESTER)
const RULE = [{ scopeType: 'MEMBER' as const, scopeId: SCOPE_ID, visibility: 'SHARED' as const }]
const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-memory-temporal-'))
  temporaryDirectories.push(directory)
  return directory
}

function cleanup(): void {
  for (const directory of temporaryDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Cleanup must never mask a test result.
    }
  }
}

interface Harness {
  filePath: string
  store: MemoryStore
  service: MemoryService
  logs: string[]
  extractionCalls: number
}

function createHarness(
  responses: string[],
  options: { storeFilePath?: string; sink?: PersistentRuntimeLogSink } = {},
): Harness {
  const filePath = options.storeFilePath ?? memoryFileIn(tempDir())
  const logs: string[] = []
  let responseIndex = 0
  let extractionCalls = 0
  let idIndex = 0
  let now = 1_780_000_000_000
  const store = new MemoryStore({ filePath, log: () => undefined, pathSource: 'TEST_TEMPORAL' })
  const extractor = new MemoryExtractor(async () => {
    extractionCalls += 1
    const response = responses[responseIndex] ?? '[]'
    responseIndex += 1
    return response
  })
  const service = new MemoryService({
    store,
    extractor,
    mutate: async () => '{"operation":"NONE"}',
    now: () => { now += 1000; return now },
    idFactory: () => `temporal-memory-${++idIndex}`,
    log: (line) => logs.push(line),
    sink: options.sink,
    enableTimer: false,
  })
  return { filePath, store, service, logs, get extractionCalls() { return extractionCalls } }
}

let feedIndex = 0

async function feed(
  service: MemoryService,
  text = '普通聊天消息',
  identity: { conversationId?: string; requesterId?: string; requesterRole?: 'OWNER' | 'MEMBER' } = {},
): Promise<void> {
  const batch = ++feedIndex
  const conversationId = identity.conversationId ?? ROOM
  const requesterId = identity.requesterId ?? REQUESTER
  const requesterRole = identity.requesterRole ?? 'MEMBER'
  for (let index = 0; index < 3; index += 1) {
    service.observeHumanMessage({
      messageId: `temporal-feed-${batch}-${index}`,
      conversationType: 'GROUP',
      conversationId,
      requesterId,
      requesterRole,
      speakerLabel: requesterRole === 'OWNER' ? 'OWNER_1' : 'MEMBER_1',
      text,
      timestamp: 1_780_000_000_000 + batch * 10 + index,
      chatTriggered: index === 2,
    })
  }
  await service.flushAll()
}

function candidateItem(
  content: string,
  options: {
    slot?: string
    kind?: string
    evidenceType?: string
    evidence?: string[]
  } = {},
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    subject: 'CURRENT_REQUESTER',
    scope: 'MEMBER',
    kind: options.kind ?? 'SELF_FACT',
    content,
    evidenceType: options.evidenceType ?? 'EXPLICIT_SELF_STATEMENT',
    evidence: options.evidence ?? ['M1'],
  }
  if (options.slot !== undefined) item.memorySlot = options.slot
  return item
}

function candidate(
  content: string,
  options: {
    slot?: string
    kind?: string
    evidenceType?: string
    evidence?: string[]
  } = {},
): string {
  return JSON.stringify([candidateItem(content, options)])
}

function candidateBatch(items: readonly {
  content: string
  slot?: string
  kind?: string
  evidenceType?: string
  evidence?: string[]
}[]): string {
  return JSON.stringify(items.map(({ content, ...options }) => candidateItem(content, options)))
}

function record(options: {
  memoryId: string
  content: string
  slot?: MemorySlot
  scopeType?: 'OWNER' | 'MEMBER'
  scopeId?: string
  subject?: 'CURRENT_REQUESTER' | 'OTHER_MEMBER'
  kind?: MemoryRecord['kind']
  origin?: MemoryRecord['origin']
  evidenceType?: MemoryRecord['evidenceType']
  isDeleted?: boolean
}): MemoryRecord {
  const content = MemoryText.normalize(options.content)
  const timestamp = 1_780_000_000_000
  const explicitEvidence = options.evidenceType ?? 'EXPLICIT_SELF_STATEMENT'
  return {
    memoryId: options.memoryId,
    scopeType: options.scopeType ?? 'MEMBER',
    subject: options.subject ?? 'CURRENT_REQUESTER',
    kind: options.kind ?? 'SELF_FACT',
    ...(options.slot === undefined ? {} : { memorySlot: options.slot }),
    scopeId: options.scopeId ?? SCOPE_ID,
    content,
    contentHash: MemoryText.hash(content),
    visibility: 'SHARED',
    origin: options.origin ?? 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: ROOM,
    sourceSenderId: 'raw-requester-id-for-test-only',
    createdAt: timestamp,
    updatedAt: timestamp,
    isDeleted: options.isDeleted ?? false,
    evidenceType: explicitEvidence,
    confidence: explicitEvidence === 'REPEATED_BEHAVIOR' ? 0.75 : 0.95,
    evidenceCount: 1,
    firstEvidenceAt: timestamp,
    lastEvidenceAt: timestamp,
  }
}

function document(filePath: string): { version: number; records: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(filePath, 'utf8')) as { version: number; records: Array<Record<string, unknown>> }
}

async function testClosedSlotParsingAndUnknownFallback(): Promise<void> {
  let calls = 0
  const extractor = new MemoryExtractor(async () => {
    calls += 1
    return JSON.stringify([
      { subject: 'CURRENT_REQUESTER', scope: 'MEMBER', kind: 'SELF_FACT', content: '我现在主要住广州', evidenceType: 'EXPLICIT_SELF_STATEMENT', evidence: ['M1'], memorySlot: 'current_primary_residence' },
      { subject: 'CURRENT_REQUESTER', scope: 'MEMBER', kind: 'SELF_FACT', content: '我目前在找工作', evidenceType: 'EXPLICIT_SELF_STATEMENT', evidence: ['M1'], memorySlot: 'CURRENT_JOB_ROLE' },
    ])
  })
  const parsed = await extractor.extract('GROUP', [{ speakerLabel: 'MEMBER_1', role: 'MEMBER', content: 'test' }])
  assert.equal(calls, 1, 'slot parsing must stay inside the existing extractor completion')
  assert.equal(parsed.length, 2, 'an unknown slot dropped an otherwise valid candidate')
  assert.equal(parsed[0]?.memorySlot, 'CURRENT_PRIMARY_RESIDENCE', 'a valid slot was not normalized from the closed set')
  assert.equal(parsed[1]?.memorySlot, undefined, 'an unknown slot was not downgraded to undefined')
  assert.deepEqual(MEMORY_SLOTS, [
    'CURRENT_PRIMARY_RESIDENCE',
    'DEFAULT_RESPONSE_DETAIL',
    'DEFAULT_RESPONSE_TONE',
    'DEFAULT_EMOJI_USAGE',
  ])
}

async function testResidenceSupersessionAndSameValueSkip(): Promise<void> {
  const harness = createHarness([
    candidate('我现在主要住广州', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
    candidate('我已经搬到深圳住了', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
    candidate('我已经搬到深圳住了', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
  ])
  await feed(harness.service, '我现在主要住广州')
  await feed(harness.service, '我已经搬到深圳住了')
  await feed(harness.service, '我已经搬到深圳住了')

  const live = harness.store.retrieve(RULE, 20)
  assert.equal(live.length, 1, 'superseded residence remained live or identical content duplicated')
  assert.equal(live[0]?.content, '我已经搬到深圳住了')
  assert.equal(live[0]?.memorySlot, 'CURRENT_PRIMARY_RESIDENCE')
  assert.equal(harness.extractionCalls, 3, 'each flush must use only its one existing extractor call')

  const records = document(harness.filePath).records
  const residences = records.filter((item) => item.memorySlot === 'CURRENT_PRIMARY_RESIDENCE')
  assert.equal(residences.length, 2)
  assert.equal(residences.filter((item) => item.isDeleted === true).length, 1, 'old residence was not soft-deleted')
  assert.equal(residences.filter((item) => item.isDeleted === false).length, 1, 'new residence is not the unique active slot value')
  assert.ok(harness.logs.some((line) => line.startsWith('[MEMORY_TEMPORAL_UPDATE]') && line.includes('action=SUPERSEDE') && line.includes('replacedCount=1')))
  assert.ok(harness.logs.some((line) => line.startsWith('[MEMORY_TEMPORAL_UPDATE]') && line.includes('action=SKIP') && line.includes('replacedCount=0')))
}

async function testUnknownSlotDoesNotSupersedeButCandidatePersists(): Promise<void> {
  const harness = createHarness([
    candidate('我现在主要住广州', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
    candidate('我已经搬到深圳住了', { slot: 'FUTURE_LOCATION' }),
  ])
  await feed(harness.service)
  await feed(harness.service)
  const live = harness.store.retrieve(RULE, 20)
  assert.equal(live.length, 2, 'unknown slot should preserve normal append-only candidate behavior')
  assert.ok(live.some((item) => item.content === '我现在主要住广州' && item.memorySlot === 'CURRENT_PRIMARY_RESIDENCE'))
  assert.ok(live.some((item) => item.content === '我已经搬到深圳住了' && item.memorySlot === undefined))
}

async function testDifferentSlotsAndUnslottedFactsCoexist(): Promise<void> {
  const harness = createHarness([
    candidate('我现在主要住广州', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
    candidate('以后默认回答详细一点', { slot: 'DEFAULT_RESPONSE_DETAIL', kind: 'SOFT_STYLE_PREFERENCE', evidenceType: 'EXPLICIT_PREFERENCE' }),
    candidate('我做过银行项目'),
    candidate('我会 Java'),
    candidate('我喜欢猫', { kind: 'CONTENT_PREFERENCE', evidenceType: 'EXPLICIT_PREFERENCE' }),
    candidate('我喜欢咖啡', { kind: 'CONTENT_PREFERENCE', evidenceType: 'EXPLICIT_PREFERENCE' }),
  ])
  for (let index = 0; index < 6; index += 1) await feed(harness.service)
  const live = harness.store.retrieve(RULE, 20)
  assert.equal(live.length, 6, 'different slots, un-slotted self facts or coexisting interests were overwritten')
  assert.equal(live.filter((item) => item.memorySlot === 'CURRENT_PRIMARY_RESIDENCE').length, 1)
  assert.equal(live.filter((item) => item.memorySlot === 'DEFAULT_RESPONSE_DETAIL').length, 1)
  assert.equal(live.filter((item) => item.memorySlot === undefined).length, 4)
}

async function testResponseDetailPreferenceSupersession(): Promise<void> {
  const harness = createHarness([
    candidate('以后默认回答简短一点', { slot: 'DEFAULT_RESPONSE_DETAIL', kind: 'SOFT_STYLE_PREFERENCE', evidenceType: 'EXPLICIT_PREFERENCE' }),
    candidate('以后回答详细一点', { slot: 'DEFAULT_RESPONSE_DETAIL', kind: 'SOFT_STYLE_PREFERENCE', evidenceType: 'EXPLICIT_PREFERENCE' }),
  ])
  await feed(harness.service, '以后默认回答简短一点')
  await feed(harness.service, '以后可以详细一点')
  const live = harness.store.retrieve(RULE, 10)
  assert.equal(live.length, 1, 'the old response-detail preference remained active')
  assert.equal(live[0]?.memorySlot, 'DEFAULT_RESPONSE_DETAIL')
  assert.equal(live[0]?.content, '以后回答详细一点')
}

async function testRepeatedAndInferredEvidenceCannotSupersede(): Promise<void> {
  const repeated = createHarness([
    candidate('我现在主要住广州', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
    candidate('我已经搬到深圳住了', {
      slot: 'CURRENT_PRIMARY_RESIDENCE',
      evidenceType: 'REPEATED_BEHAVIOR',
      evidence: ['M1', 'M3'],
    }),
  ])
  await feed(repeated.service)
  await feed(repeated.service)
  const repeatedLive = repeated.store.retrieve(RULE, 20)
  assert.equal(repeatedLive.length, 2, 'REPEATED_BEHAVIOR incorrectly superseded an explicit fact')
  assert.ok(repeatedLive.some((item) => item.memorySlot === 'CURRENT_PRIMARY_RESIDENCE' && item.content === '我现在主要住广州'))
  assert.ok(repeatedLive.some((item) => item.memorySlot === undefined && item.evidenceType === 'REPEATED_BEHAVIOR'))
  const temporalLines = repeated.logs.filter((line) => line.startsWith('[MEMORY_TEMPORAL_UPDATE]'))
  assert.equal(temporalLines.length, 1, 'repeated evidence emitted an extra temporal update')
  assert.ok(temporalLines[0]?.includes('action=INSERT'), 'the only temporal update was not the initial explicit insert')

  const inferred = createHarness([
    candidate('我已经搬到深圳住了', { slot: 'CURRENT_PRIMARY_RESIDENCE', evidenceType: 'INFERRED_PATTERN' }),
  ])
  await feed(inferred.service)
  assert.equal(inferred.store.liveRecordCount, 0, 'INFERRED_PATTERN became durable')
}

async function testConcurrentStaleSlotRepair(): Promise<void> {
  const directory = tempDir()
  const filePath = memoryFileIn(directory)
  const oldA = record({ memoryId: 'old-a', content: '我现在主要住广州', slot: 'CURRENT_PRIMARY_RESIDENCE' })
  const oldB = record({ memoryId: 'old-b', content: '我之前主要住佛山', slot: 'CURRENT_PRIMARY_RESIDENCE' })
  writeFileSync(filePath, `${JSON.stringify({ version: 1, records: [oldA, oldB] })}\n`, 'utf8')
  const store = new MemoryStore({ filePath, log: () => undefined, pathSource: 'TEST_DUPLICATE_SLOTS' })
  assert.equal(store.isEnabled, true)
  const result = store.upsertCurrentSlot(record({ memoryId: 'new-c', content: '我已经搬到深圳住了', slot: 'CURRENT_PRIMARY_RESIDENCE' }))
  assert.deepEqual(result, { status: 'WRITTEN', action: 'SUPERSEDE', replacedCount: 2 })
  const live = store.retrieve(RULE, 20)
  assert.equal(live.length, 1)
  assert.equal(live[0]?.memoryId, 'new-c')
  assert.equal(document(filePath).records.filter((item) => item.isDeleted === false).length, 1)
}

async function testFailedSaveRestoresAllPreviousRecords(): Promise<void> {
  const filePath = memoryFileIn(tempDir())
  const store = new MemoryStore({ filePath, log: () => undefined, pathSource: 'TEST_SAVE_ROLLBACK' })
  const original = record({ memoryId: 'rollback-old', content: '我现在主要住广州', slot: 'CURRENT_PRIMARY_RESIDENCE' })
  assert.equal(store.upsertCurrentSlot(original).status, 'WRITTEN')

  // Block the sibling temporary file after initialization. This forces save()
  // to fail before rename while leaving the prior memory.json untouched.
  mkdirSync(`${filePath}.tmp-${process.pid}`)
  const failed = store.upsertCurrentSlot(record({
    memoryId: 'rollback-new',
    content: '我已经搬到深圳住了',
    slot: 'CURRENT_PRIMARY_RESIDENCE',
  }))
  assert.equal(failed.status, 'FAILED')
  assert.equal(failed.action, 'SUPERSEDE')
  assert.equal(failed.replacedCount, 0)
  assert.equal(store.recordCount, 1, 'failed save left the new record in memory')
  const live = store.retrieve(RULE, 20)
  assert.equal(live.length, 1, 'failed save retired the old record')
  assert.equal(live[0]?.memoryId, 'rollback-old')
  const persisted = document(filePath).records
  assert.equal(persisted.length, 1, 'failed save changed the persisted record set')
  assert.equal(persisted[0]?.memoryId, 'rollback-old')
}

async function testLegacyRecordWithoutSlotCoexistsWithNewSlot(): Promise<void> {
  const filePath = memoryFileIn(tempDir())
  const legacy = record({ memoryId: 'legacy-no-slot', content: '我住广州' })
  delete (legacy as Partial<MemoryRecord>).evidenceType
  delete (legacy as Partial<MemoryRecord>).confidence
  delete (legacy as Partial<MemoryRecord>).evidenceCount
  delete (legacy as Partial<MemoryRecord>).firstEvidenceAt
  delete (legacy as Partial<MemoryRecord>).lastEvidenceAt
  writeFileSync(filePath, `${JSON.stringify({ version: 1, records: [legacy] })}\n`, 'utf8')
  const harness = createHarness([
    candidate('我现在主要住深圳', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
  ], { storeFilePath: filePath })
  assert.equal(harness.store.isEnabled, true, 'legacy schema-v1 record failed to load')
  assert.equal(harness.store.retrieve(RULE, 10).length, 1)

  await feed(harness.service, '我现在主要住深圳')
  const workingSet = await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: REQUESTER,
    requesterRole: 'MEMBER',
    question: '我的居住信息',
  })
  assert.deepEqual(new Set(workingSet.map((item) => item.content)), new Set(['我住广州', '我现在主要住深圳']))

  const persisted = document(filePath).records
  const legacyAfterWrite = persisted.find((item) => item.memoryId === 'legacy-no-slot')
  const currentAfterWrite = persisted.find((item) => item.memorySlot === 'CURRENT_PRIMARY_RESIDENCE')
  assert.equal(legacyAfterWrite?.isDeleted, false, 'writing a slot deleted the legacy no-slot record')
  assert.equal(legacyAfterWrite?.memorySlot, undefined, 'legacy record was migrated by guessing a slot')
  assert.equal(currentAfterWrite?.isDeleted, false, 'the new current slot record is not live')
}

async function testSlotKindMismatchDropsOnlySlotAndUsesAppendPath(): Promise<void> {
  const harness = createHarness([
    candidate('我现在主要住广州', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
    candidate('以后回答简短一点', { slot: 'CURRENT_PRIMARY_RESIDENCE', kind: 'SOFT_STYLE_PREFERENCE', evidenceType: 'EXPLICIT_PREFERENCE' }),
    candidate('以后少用 emoji', { slot: 'DEFAULT_EMOJI_USAGE', kind: 'SOFT_STYLE_PREFERENCE', evidenceType: 'EXPLICIT_PREFERENCE' }),
    candidate('我做 Java 后端', { slot: 'DEFAULT_EMOJI_USAGE', kind: 'SELF_FACT' }),
  ])
  for (const text of ['我现在主要住广州', '以后回答简短一点', '以后少用 emoji', '我做 Java 后端']) {
    await feed(harness.service, text)
  }

  const live = harness.store.retrieve(RULE, 20)
  assert.equal(live.length, 4, 'an incompatible slot-kind pair discarded a valid candidate')
  assert.ok(live.some((item) => item.content === '我现在主要住广州' && item.memorySlot === 'CURRENT_PRIMARY_RESIDENCE'))
  assert.ok(live.some((item) => item.content === '以后回答简短一点' && item.memorySlot === undefined))
  assert.ok(live.some((item) => item.content === '以后少用 emoji' && item.memorySlot === 'DEFAULT_EMOJI_USAGE'))
  assert.ok(live.some((item) => item.content === '我做 Java 后端' && item.memorySlot === undefined))
  assert.equal(harness.logs.filter((line) => line.startsWith('[MEMORY_TEMPORAL_UPDATE]')).length, 2)
}

async function testMultiValueFactsAndConditionalPreferencesStayUnslotted(): Promise<void> {
  const harness = createHarness([
    candidateBatch([
      { content: '我做 Java 后端', slot: 'CURRENT_JOB_ROLE' },
      { content: '我也做 AI Agent 开发', slot: 'CURRENT_JOB_ROLE' },
    ]),
    candidateBatch([
      { content: '我在 A 公司上班', slot: 'CURRENT_EMPLOYER' },
      { content: '我也给 B 公司长期做项目', slot: 'CURRENT_EMPLOYER' },
    ]),
    candidateBatch([
      { content: '我目前在职', slot: 'CURRENT_JOB_STATUS' },
      { content: '我也在看新的工作机会', slot: 'CURRENT_JOB_STATUS' },
    ]),
    candidate('技术问题详细一点，闲聊简短点', { kind: 'SOFT_STYLE_PREFERENCE', evidenceType: 'EXPLICIT_PREFERENCE' }),
    candidate('技术问题正式一点，平时聊天随意点', { kind: 'SOFT_STYLE_PREFERENCE', evidenceType: 'EXPLICIT_PREFERENCE' }),
    candidate('我现在广州深圳两边住'),
  ])
  const inputs = [
    '我做 Java 后端，我也做 AI Agent 开发',
    '我在 A 公司上班，我也给 B 公司长期做项目',
    '我目前在职，我也在看新的工作机会',
    '技术问题详细一点，闲聊简短点',
    '技术问题正式一点，平时聊天随意点',
    '我现在广州深圳两边住',
  ]
  for (const text of inputs) await feed(harness.service, text)

  const live = harness.store.retrieve(RULE, 30)
  assert.equal(live.length, 9, 'a legal multi-value fact was lost or overwritten')
  assert.ok(live.every((item) => item.memorySlot === undefined), 'multi-value/conditional facts were given a temporal slot')
  for (const expected of [
    '我做 Java 后端', '我也做 AI Agent 开发',
    '我在 A 公司上班', '我也给 B 公司长期做项目',
    '我目前在职', '我也在看新的工作机会',
    '技术问题详细一点，闲聊简短点', '技术问题正式一点，平时聊天随意点',
    '我现在广州深圳两边住',
  ]) {
    assert.ok(live.some((item) => item.content === expected), `durable candidate missing: ${expected}`)
  }
  assert.equal(harness.logs.filter((line) => line.startsWith('[MEMORY_TEMPORAL_UPDATE]')).length, 0)
}

async function testActualRetrieveForChatExcludesSupersededValue(): Promise<void> {
  const harness = createHarness([
    candidate('我现在主要住广州', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
    candidate('我现在主要住深圳', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
  ])
  await feed(harness.service, '我现在主要住广州')
  await feed(harness.service, '我现在主要住深圳')

  const workingSet = await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: REQUESTER,
    requesterRole: 'MEMBER',
    question: '我的居住信息',
  })
  assert.ok(workingSet.some((item) => item.content === '我现在主要住深圳'))
  assert.equal(workingSet.some((item) => item.content === '我现在主要住广州'), false)
}

async function testCrossRequesterIsolationForTemporalSlots(): Promise<void> {
  const harness = createHarness([
    candidate('Requester A 主要住广州', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
    candidate('Requester B 主要住深圳', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
  ])
  await feed(harness.service, 'Requester A 主要住广州', { requesterId: 'requester-A' })
  await feed(harness.service, 'Requester B 主要住深圳', { requesterId: 'requester-B' })

  const requesterA = await harness.service.retrieveForChat({
    conversationType: 'GROUP', conversationId: ROOM, requesterId: 'requester-A', requesterRole: 'MEMBER', question: '居住地',
  })
  const requesterB = await harness.service.retrieveForChat({
    conversationType: 'GROUP', conversationId: ROOM, requesterId: 'requester-B', requesterRole: 'MEMBER', question: '居住地',
  })
  assert.deepEqual(requesterA.map((item) => item.content), ['Requester A 主要住广州'])
  assert.deepEqual(requesterB.map((item) => item.content), ['Requester B 主要住深圳'])
  assert.equal(harness.store.liveRecordCount, 2, 'one requester superseded the other requester slot')
}

async function testCrossGroupMemberIsolationForTemporalSlots(): Promise<void> {
  const harness = createHarness([
    candidate('Group A 主要住广州', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
    candidate('Group B 主要住深圳', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
  ])
  await feed(harness.service, 'Group A 主要住广州', { conversationId: 'group-A@chatroom' })
  await feed(harness.service, 'Group B 主要住深圳', { conversationId: 'group-B@chatroom' })

  const groupA = await harness.service.retrieveForChat({
    conversationType: 'GROUP', conversationId: 'group-A@chatroom', requesterId: REQUESTER, requesterRole: 'MEMBER', question: '居住地',
  })
  const groupB = await harness.service.retrieveForChat({
    conversationType: 'GROUP', conversationId: 'group-B@chatroom', requesterId: REQUESTER, requesterRole: 'MEMBER', question: '居住地',
  })
  assert.deepEqual(groupA.map((item) => item.content), ['Group A 主要住广州'])
  assert.deepEqual(groupB.map((item) => item.content), ['Group B 主要住深圳'])
  assert.equal(harness.store.liveRecordCount, 2, 'one group superseded the other group member slot')
}

async function testExtractorPromptDefinesNarrowSlotSemantics(): Promise<void> {
  let systemPrompt = ''
  const extractor = new MemoryExtractor(async (system) => {
    systemPrompt = system
    return '[]'
  })
  await extractor.extract('GROUP', [{ speakerLabel: 'MEMBER_1', role: 'MEMBER', content: 'synthetic prompt check' }])
  assert.ok(systemPrompt.includes('CURRENT_PRIMARY_RESIDENCE|DEFAULT_RESPONSE_DETAIL|DEFAULT_RESPONSE_TONE|DEFAULT_EMOJI_USAGE'))
  assert.ok(systemPrompt.includes('工作角色、雇主、求职/就业状态不是单值 slot'))
  assert.ok(systemPrompt.includes('条件化偏好'))
  assert.ok(systemPrompt.includes('广州和深圳两边住等并存住所'))
}

async function testAddressAndOwnerMutationsKeepTheirExistingStorePaths(): Promise<void> {
  const store = new MemoryStore({ filePath: memoryFileIn(tempDir()), log: () => undefined, pathSource: 'TEST_EXISTING_PATHS' })
  const addressOne = record({
    memoryId: 'address-one',
    content: '妈妈',
    kind: 'ADDRESS_PREFERENCE',
    origin: 'EXPLICIT_SELF_ADDRESS',
    evidenceType: 'EXPLICIT_SELF_ADDRESS',
  })
  assert.equal(store.upsertAddressPreference(addressOne), 'WRITTEN')
  const addressTwo = { ...addressOne, memoryId: 'address-two', content: '小王', contentHash: '', updatedAt: addressOne.updatedAt + 1 }
  assert.equal(store.upsertAddressPreference(addressTwo), 'WRITTEN')
  const addressLive = store.retrieve(RULE, 10)
  assert.equal(addressLive.length, 1)
  assert.equal(addressLive[0]?.content, '小王')
  assert.equal(addressLive[0]?.memorySlot, undefined)

  const owner = record({
    memoryId: 'owner-explicit-add',
    content: '我喜欢文学',
    scopeType: 'OWNER',
    scopeId: 'owner-temporal-test',
    origin: 'EXPLICIT_OWNER',
    evidenceType: 'EXPLICIT_OWNER_COMMAND',
  })
  assert.equal(store.add(owner), 'WRITTEN', 'explicit OWNER ADD stopped using MemoryStore.add')
  assert.equal(store.update(owner.memoryId, '我喜欢古典文学', owner.updatedAt + 2), true, 'explicit OWNER UPDATE stopped working')
  assert.equal(store.retrieve([{ scopeType: 'OWNER', scopeId: owner.scopeId, visibility: 'SHARED' }], 10)[0]?.content, '我喜欢古典文学')
  assert.equal(store.delete(owner.memoryId, owner.updatedAt + 3), true, 'explicit OWNER DELETE stopped working')
  assert.equal(store.retrieve([{ scopeType: 'OWNER', scopeId: owner.scopeId, visibility: 'SHARED' }], 10).length, 0)
}

async function testTemporalDiagnosticContainsOnlyEnumsAndCounts(): Promise<void> {
  const persistentLog = new PersistentRuntimeLog({ fileBaseName: 'temporal-memory-test', directory: tempDir() })
  try {
    const sink = new PersistentRuntimeLogSink(persistentLog, 'agent-memory')
    const harness = createHarness([
      candidate('我现在主要住广州', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
      candidate('我现在主要住深圳', { slot: 'CURRENT_PRIMARY_RESIDENCE' }),
    ], { sink })
    await feed(harness.service, '我现在主要住广州')
    await feed(harness.service, '我现在主要住深圳')

    const stdoutLines = harness.logs.filter((line) => line.startsWith('[MEMORY_TEMPORAL_UPDATE]'))
    assert.equal(stdoutLines.length, 2)
    assert.match(stdoutLines[1]!, /^\[MEMORY_TEMPORAL_UPDATE\] slot=CURRENT_PRIMARY_RESIDENCE action=SUPERSEDE replacedCount=1 result=PASS$/u)

    persistentLog.flush()
    const durableLines = readFileSync(persistentLog.filePath, 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line.includes('|MEMORY_TEMPORAL_UPDATE|'))
    assert.equal(durableLines.length, 2, 'supersession was not written through PersistentRuntimeLogSink')
    for (const line of [...stdoutLines, ...durableLines]) {
      for (const privateValue of ['广州', '深圳', REQUESTER, ROOM, SCOPE_ID, 'temporal-memory-1', 'temporal-memory-2']) {
        assert.equal(line.includes(privateValue), false, `temporal diagnostic leaked ${privateValue}`)
      }
      for (const forbiddenField of ['content=', 'requesterId=', 'senderId=', 'scopeId=', 'conversationId=', 'memoryId=', 'displayName=']) {
        assert.equal(line.includes(forbiddenField), false, `temporal diagnostic included ${forbiddenField}`)
      }
    }
    assert.deepEqual(
      durableLines[1]!.split('|').slice(5).map((field) => field.slice(0, field.indexOf('='))),
      ['slot', 'action', 'replacedCount', 'result'],
      'persistent event carried fields outside the safe temporal diagnostic contract',
    )
  } finally {
    persistentLog.dispose()
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => void | Promise<void>]> = [
    ['closed-slot-parsing-and-unknown-fallback', testClosedSlotParsingAndUnknownFallback],
    ['residence-supersession-and-same-value-skip', testResidenceSupersessionAndSameValueSkip],
    ['unknown-slot-does-not-supersede', testUnknownSlotDoesNotSupersedeButCandidatePersists],
    ['different-slots-and-unslotted-facts-coexist', testDifferentSlotsAndUnslottedFactsCoexist],
    ['response-detail-preference-supersession', testResponseDetailPreferenceSupersession],
    ['repeated-and-inferred-evidence-cannot-supersede', testRepeatedAndInferredEvidenceCannotSupersede],
    ['concurrent-stale-slot-repair', testConcurrentStaleSlotRepair],
    ['failed-save-restores-previous-records', testFailedSaveRestoresAllPreviousRecords],
    ['legacy-record-and-new-slot-coexist', testLegacyRecordWithoutSlotCoexistsWithNewSlot],
    ['slot-kind-mismatch-drops-only-slot', testSlotKindMismatchDropsOnlySlotAndUsesAppendPath],
    ['multi-value-facts-and-conditional-preferences-stay-unslotted', testMultiValueFactsAndConditionalPreferencesStayUnslotted],
    ['retrieve-for-chat-excludes-superseded-value', testActualRetrieveForChatExcludesSupersededValue],
    ['cross-requester-temporal-isolation', testCrossRequesterIsolationForTemporalSlots],
    ['cross-group-member-temporal-isolation', testCrossGroupMemberIsolationForTemporalSlots],
    ['extractor-prompt-defines-narrow-slot-semantics', testExtractorPromptDefinesNarrowSlotSemantics],
    ['address-and-owner-mutations-keep-existing-paths', testAddressAndOwnerMutationsKeepTheirExistingStorePaths],
    ['temporal-diagnostic-is-private', testTemporalDiagnosticContainsOnlyEnumsAndCounts],
  ]
  let failures = 0
  try {
    for (const [name, run] of cases) {
      try {
        await run()
        console.log(`[MEMORY_TEMPORAL_CASE] name=${name} result=PASS`)
      } catch (error) {
        failures += 1
        console.error(`[MEMORY_TEMPORAL_CASE] name=${name} result=FAIL error=${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    cleanup()
  }
  console.log(`[MEMORY_TEMPORAL_TEST_SUMMARY] cases=${cases.length} failures=${failures}`)
  if (failures > 0) process.exitCode = 1
}

void main()
