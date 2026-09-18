/**
 * MEMORY EVIDENCE / CONFIDENCE FOUNDATION — phase 1 regression matrix.
 *
 * Covers the legacy v1 compatibility contract (a memory.json written before
 * evidence metadata must load, serve retrieval and feed the member interaction
 * profile unchanged), the automatic durable write gate (evidence class and
 * batch-reference validation, the four automatic evidence classes, the
 * INFERRED_PATTERN and REPEATED_BEHAVIOR rules), the runtime-owned confidence
 * table, the explicit owner command and self-address evidence paths, and the
 * `[MEMORY_EVIDENCE]` diagnostics privacy contract.
 *
 * All fixtures use synthetic ids and synthetic facts; no raw production data.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveMemberInteractionProfile } from './member-interaction-profile.js'
import { MemoryExtractor } from './memory-extractor.js'
import {
  admitAutomaticEvidence,
  deriveMemoryEvidenceConfidence,
  evidenceTypeOf,
  memoryConfidenceBand,
  upgradedExplicitEvidence,
} from './memory-evidence.js'
import {
  MEMORY_AUTO_FLUSH_BATCH_SIZE,
  MemoryService,
  type ExplicitMemoryRequest,
} from './memory-service.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'
import { MemoryText, type MemoryInputMessage } from './memory-models.js'

const ROOM = 'room-evidence@chatroom'
const REQUESTER = 'requester-evidence-a'
const FACT = 'A 的代号是 Alpha'

const TRUSTED_FRAMING = {
  mentionState: 'MENTIONED' as const,
  botMentionSpanTrust: 'VALID' as const,
  botMentionSpanCount: 1,
  userContentSpanTrust: 'VALID' as const,
}

// --------------------------------------------------------------- test harness

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-memory-evidence-'))
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

interface Harness {
  directory: string
  filePath: string
  store: MemoryStore
  service: MemoryService
  logs: string[]
  extractorInputs: string[]
}

interface HarnessOptions {
  extractorResponses?: string[]
  mutateResponse?: string
}

function createHarness(options: HarnessOptions = {}): Harness {
  const directory = tempDir()
  const filePath = memoryFileIn(directory)
  const logs: string[] = []
  const extractorInputs: string[] = []
  const responses = options.extractorResponses ?? ['[]']

  const store = new MemoryStore({ filePath, log: () => undefined, pathSource: 'TEST' })
  const extractor = new MemoryExtractor(async (_system, user) => {
    extractorInputs.push(user)
    const index = Math.min(extractorInputs.length - 1, responses.length - 1)
    return responses[index] ?? '[]'
  })
  const service = new MemoryService({
    store,
    extractor,
    mutate: async () => options.mutateResponse ?? '{"operation":"NONE"}',
    now: steppingClock(),
    idFactory: sequentialIds(),
    log: (line) => logs.push(line),
    enableTimer: false,
  })
  return { directory, filePath, store, service, logs, extractorInputs }
}

function sequentialIds(): () => string {
  let counter = 0
  return () => `evidence-${(++counter).toString().padStart(4, '0')}`
}

function steppingClock(start = 1_700_000_000_000): () => number {
  let value = start
  return () => {
    value += 1000
    return value
  }
}

let feedRun = 0

/** Feeds `count` admitted GROUP messages so a flush runs with a real batch. */
async function feed(service: MemoryService, count: number, text = '普通聊天消息'): Promise<void> {
  feedRun += 1
  for (let index = 0; index < count; index += 1) {
    service.observeHumanMessage({
      messageId: `evidence-feed-${feedRun}-${index}`,
      conversationType: 'GROUP',
      conversationId: ROOM,
      requesterId: REQUESTER,
      requesterRole: 'MEMBER',
      speakerLabel: 'MEMBER_1',
      text,
      timestamp: 1_757_000_000_000 + index,
      chatTriggered: index === count - 1,
    })
  }
  await service.flushAll()
}

function explicitRequest(question: string, overrides: Partial<ExplicitMemoryRequest> = {}): ExplicitMemoryRequest {
  return {
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: REQUESTER,
    requesterRole: 'OWNER',
    question,
    ...TRUSTED_FRAMING,
    ...overrides,
  }
}

function evidenceLines(logs: readonly string[]): string[] {
  return logs.filter((line) => line.startsWith('[MEMORY_EVIDENCE]'))
}

function persistedDocument(filePath: string): { version: number; records: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(filePath, 'utf8')) as { version: number; records: Array<Record<string, unknown>> }
}

// ------------------------------------------------------------ unit-level rules

function testConfidenceTableAndBands(): void {
  assert.equal(deriveMemoryEvidenceConfidence('EXPLICIT_OWNER_COMMAND'), 1)
  assert.equal(deriveMemoryEvidenceConfidence('EXPLICIT_SELF_ADDRESS'), 1)
  assert.equal(deriveMemoryEvidenceConfidence('EXPLICIT_SELF_STATEMENT'), 0.95)
  assert.equal(deriveMemoryEvidenceConfidence('EXPLICIT_PREFERENCE'), 0.95)
  assert.equal(deriveMemoryEvidenceConfidence('REPEATED_BEHAVIOR'), 0.75)
  assert.equal(deriveMemoryEvidenceConfidence('INFERRED_PATTERN'), 0.4)
  assert.equal(deriveMemoryEvidenceConfidence('LEGACY_UNKNOWN'), null)

  assert.equal(memoryConfidenceBand(1), 'HIGH')
  assert.equal(memoryConfidenceBand(0.95), 'HIGH')
  assert.equal(memoryConfidenceBand(0.9), 'HIGH')
  assert.equal(memoryConfidenceBand(0.75), 'MEDIUM')
  assert.equal(memoryConfidenceBand(0.6), 'MEDIUM')
  assert.equal(memoryConfidenceBand(0.4), 'LOW')
  assert.equal(memoryConfidenceBand(0), 'LOW')
  assert.equal(memoryConfidenceBand(undefined), 'LEGACY')
  assert.equal(memoryConfidenceBand(null), 'LEGACY')
  assert.equal(memoryConfidenceBand(Number.NaN), 'LEGACY')

  assert.equal(evidenceTypeOf({}), 'LEGACY_UNKNOWN')
  assert.equal(evidenceTypeOf({ evidenceType: 'EXPLICIT_PREFERENCE' }), 'EXPLICIT_PREFERENCE')
}

function testUpgradedExplicitEvidenceRule(): void {
  const now = 1_700_000_000_000
  const fresh = upgradedExplicitEvidence(undefined, 'EXPLICIT_OWNER_COMMAND', now)
  assert.deepEqual(fresh, {
    evidenceType: 'EXPLICIT_OWNER_COMMAND',
    confidence: 1,
    evidenceCount: 1,
    firstEvidenceAt: now,
    lastEvidenceAt: now,
  })

  const upgraded = upgradedExplicitEvidence(
    { evidenceCount: 2, firstEvidenceAt: now - 5000 },
    'EXPLICIT_SELF_ADDRESS',
    now,
  )
  assert.deepEqual(upgraded, {
    evidenceType: 'EXPLICIT_SELF_ADDRESS',
    confidence: 1,
    evidenceCount: 3,
    firstEvidenceAt: now - 5000,
    lastEvidenceAt: now,
  })

  const fromLegacy = upgradedExplicitEvidence({}, 'EXPLICIT_SELF_ADDRESS', now)
  assert.equal(fromLegacy.evidenceCount, 1)
  assert.equal(fromLegacy.firstEvidenceAt, now)
}

function testGateUnitRules(): void {
  const now = 1_700_000_000_000
  // Provider-supplied confidence and extra fields are never part of the gate.
  const admitted = admitAutomaticEvidence({
    declaredEvidenceType: 'EXPLICIT_SELF_STATEMENT',
    declaredEvidenceRefs: ['M1'],
    batchSize: 3,
    now,
  })
  assert.equal(admitted.outcome, 'ADMIT')
  if (admitted.outcome === 'ADMIT') {
    assert.equal(admitted.metadata.confidence, 0.95)
    assert.equal(admitted.metadata.evidenceCount, 1)
    assert.equal(admitted.metadata.firstEvidenceAt, now)
    assert.equal(admitted.metadata.lastEvidenceAt, now)
  }

  const typeNotAllowed = admitAutomaticEvidence({
    declaredEvidenceType: 'EXPLICIT_OWNER_COMMAND',
    declaredEvidenceRefs: ['M1'],
    batchSize: 3,
    now,
  })
  assert.equal(typeNotAllowed.outcome, 'SKIP')
  assert.equal(typeNotAllowed.outcome === 'SKIP' ? typeNotAllowed.reason : '', 'EVIDENCE_TYPE_NOT_ALLOWED')

  const missingType = admitAutomaticEvidence({
    declaredEvidenceType: undefined,
    declaredEvidenceRefs: ['M1'],
    batchSize: 3,
    now,
  })
  assert.equal(missingType.outcome === 'SKIP' ? missingType.reason : '', 'EVIDENCE_TYPE_NOT_ALLOWED')

  const repeatedAdmitted = admitAutomaticEvidence({
    declaredEvidenceType: 'REPEATED_BEHAVIOR',
    declaredEvidenceRefs: ['M1', 'M3'],
    batchSize: 3,
    now,
  })
  assert.equal(repeatedAdmitted.outcome, 'ADMIT')
  if (repeatedAdmitted.outcome === 'ADMIT') {
    assert.equal(repeatedAdmitted.metadata.confidence, 0.75)
    assert.equal(repeatedAdmitted.metadata.evidenceCount, 2)
  }
}

// ------------------------------------------------- A/B/V-legacy compatibility

/** A. + B. A pre-evidence memory.json (version 1, no evidence fields) loads and serves. */
async function testLegacyV1FixtureLoadsAndServes(): Promise<void> {
  const directory = tempDir()
  const filePath = memoryFileIn(directory)
  const legacyRecords = [
    {
      // Fully legacy v02 shape: no kind, no subject, no evidence.
      memoryId: 'legacy-self-fact',
      scopeType: 'MEMBER',
      scopeId: 'member-legacy-a',
      content: '我叫小明',
      contentHash: MemoryText.hash(MemoryText.normalize('我叫小明')),
      visibility: 'SHARED',
      origin: 'AUTOMATIC',
      sourceConversationType: 'GROUP',
      sourceConversationId: 'room-legacy@chatroom',
      sourceSenderId: 'member-legacy-a',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      isDeleted: false,
    },
    {
      // Current-producer shape before this phase: kind/subject present, no evidence.
      memoryId: 'legacy-style-preference',
      scopeType: 'MEMBER',
      scopeId: 'member-legacy-a',
      kind: 'SOFT_STYLE_PREFERENCE',
      subject: 'CURRENT_REQUESTER',
      content: '回答尽量简短一点',
      contentHash: MemoryText.hash(MemoryText.normalize('回答尽量简短一点')),
      visibility: 'SHARED',
      origin: 'AUTOMATIC',
      sourceConversationType: 'GROUP',
      sourceConversationId: 'room-legacy@chatroom',
      sourceSenderId: 'member-legacy-a',
      createdAt: 1_700_000_000_001,
      updatedAt: 1_700_000_000_001,
      isDeleted: false,
    },
  ]
  writeFileSync(filePath, `${JSON.stringify({ version: 1, records: legacyRecords })}\n`, 'utf8')

  const store = new MemoryStore({ filePath, log: () => undefined, pathSource: 'TEST_LEGACY' })
  assert.equal(store.isEnabled, true, 'a legacy v1 memory.json must not disable the store')
  assert.equal(store.disabledReason, 'NOT_INITIALIZED')
  assert.equal(store.liveRecordCount, 2, 'legacy records were dropped on load')

  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => '{"operation":"NONE"}',
    log: () => undefined,
    enableTimer: false,
  })
  const retrieved = await service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: 'room-legacy@chatroom',
    requesterId: 'member-legacy-a',
    requesterRole: 'MEMBER',
    question: '我叫什么',
  })
  assert.equal(retrieved.length, 2, 'legacy records did not serve retrieval')
  assert.ok(retrieved.some((item) => item.content === '我叫小明'), 'the legacy self fact was not readable')
  assert.ok(retrieved.some((item) => item.content === '回答尽量简短一点'), 'the legacy preference was not readable')

  // V (legacy half): the member interaction profile still consumes the old preference.
  const profile = deriveMemberInteractionProfile({
    authorizedPersonalMemory: retrieved.filter((item) => item.scope === 'PERSONAL'),
    recentRequesterActiveContext: [],
  })
  assert.equal(profile.responseDepth, 'SHORT', 'the member profile lost the legacy preference')

  // New writes keep the file at schema version 1 and leave legacy records intact.
  const status = store.add({
    memoryId: 'new-evidence-record',
    scopeType: 'MEMBER',
    scopeId: 'member-legacy-a',
    content: '新证据记忆',
    contentHash: '',
    visibility: 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: 'room-legacy@chatroom',
    sourceSenderId: 'member-legacy-a',
    createdAt: 1_700_000_000_002,
    updatedAt: 1_700_000_000_002,
    isDeleted: false,
    evidenceType: 'EXPLICIT_SELF_STATEMENT',
    confidence: 0.95,
    evidenceCount: 1,
    firstEvidenceAt: 1_700_000_000_002,
    lastEvidenceAt: 1_700_000_000_002,
  })
  assert.equal(status, 'WRITTEN', 'a new write into a legacy store failed')

  const document = persistedDocument(filePath)
  assert.equal(document.version, 1, 'the file schema version moved without a migration')
  const legacyOnDisk = document.records.filter((record) => String(record.memoryId).startsWith('legacy-'))
  assert.equal(legacyOnDisk.length, 2, 'a legacy record was lost or rewritten on save')
  for (const record of legacyOnDisk) {
    assert.equal(record.evidenceType, undefined, 'a legacy record grew evidence metadata on disk')
  }
  const newOnDisk = document.records.find((record) => record.memoryId === 'new-evidence-record')
  assert.equal(newOnDisk?.evidenceType, 'EXPLICIT_SELF_STATEMENT', 'the new record lost its evidence metadata')

  const reloaded = new MemoryStore({ filePath, log: () => undefined, pathSource: 'TEST_LEGACY_RELOAD' })
  assert.equal(reloaded.isEnabled, true, 'the store could not reload a mixed legacy + evidence file')
  assert.equal(reloaded.liveRecordCount, 3)
}

// ---------------------------------------------- C–L: automatic write gate

/** C. EXPLICIT_SELF_STATEMENT + M1 → written with runtime-derived evidence. */
async function testAutomaticSelfStatementWritten(): Promise<void> {
  const harness = createHarness({
    extractorResponses: [`[{"scope":"MEMBER","content":"${FACT}","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":["M1"],"confidence":0.93}]`],
  })
  await feed(harness.service, 3)

  const records = harness.store.retrieve([{ scopeType: 'MEMBER', scopeId: REQUESTER, visibility: 'SHARED' }], 10)
  assert.equal(records.length, 1, 'the explicit self statement was not written')
  const record = records[0]!
  assert.equal(record.evidenceType, 'EXPLICIT_SELF_STATEMENT')
  // K folded in: the provider's confidence field is ignored; runtime remains authoritative.
  assert.equal(record.confidence, 0.95)
  assert.equal(record.evidenceCount, 1)
  assert.equal(typeof record.firstEvidenceAt, 'number')
  assert.equal(typeof record.lastEvidenceAt, 'number')
  assert.ok(record.firstEvidenceAt! <= record.lastEvidenceAt!)

  const document = persistedDocument(harness.filePath)
  assert.equal(document.version, 1)
  assert.equal(document.records[0]?.evidenceCount, 1)
  // Batch-local references never persist: no M-refs, no raw evidence payload.
  assert.equal('evidenceRefs' in document.records[0]!, false, 'batch-local references leaked into memory.json')
  assert.equal('evidence' in document.records[0]!, false, 'a raw evidence payload leaked into memory.json')
}

/** D. EXPLICIT_PREFERENCE + M1 → written. */
async function testAutomaticPreferenceWritten(): Promise<void> {
  const harness = createHarness({
    extractorResponses: ['[{"scope":"MEMBER","kind":"SOFT_STYLE_PREFERENCE","content":"以后回答我简短一点","evidenceType":"EXPLICIT_PREFERENCE","evidence":["M1"]}]'],
  })
  await feed(harness.service, 3)

  const records = harness.store.retrieve([{ scopeType: 'MEMBER', scopeId: REQUESTER, visibility: 'SHARED' }], 10)
  assert.equal(records.length, 1, 'the explicit preference was not written')
  assert.equal(records[0]?.evidenceType, 'EXPLICIT_PREFERENCE')
  assert.equal(records[0]?.confidence, 0.95)
  assert.equal(records[0]?.kind, 'SOFT_STYLE_PREFERENCE')

  // V (new half): the member profile consumes the new high-confidence preference.
  const retrieved = await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: REQUESTER,
    requesterRole: 'MEMBER',
    question: '怎么回答我',
  })
  const profile = deriveMemberInteractionProfile({
    authorizedPersonalMemory: retrieved.filter((item) => item.scope === 'PERSONAL'),
    recentRequesterActiveContext: [],
  })
  assert.equal(profile.responseDepth, 'SHORT', 'the member profile lost the new preference')
}

/** E. INFERRED_PATTERN → skipped INFERRED_PATTERN_NOT_DURABLE, nothing durable. */
async function testInferredPatternNeverDurable(): Promise<void> {
  const harness = createHarness({
    extractorResponses: [`[{"scope":"MEMBER","content":"他喜欢热闹","evidenceType":"INFERRED_PATTERN","evidence":["M1"]}]`],
  })
  await feed(harness.service, 3)

  assert.equal(harness.service.recordCount, 0, 'an inferred pattern became a durable memory')
  // Nothing was admitted, so the store never wrote a file (the store only
  // creates memory.json on its first durable save).
  if (existsSync(harness.filePath)) {
    const document = persistedDocument(harness.filePath)
    assert.equal(document.records.length, 0, 'a skipped candidate reached memory.json')
  }
  assert.ok(
    evidenceLines(harness.logs).some((line) => line.includes('result=SKIPPED') && line.includes('reason=INFERRED_PATTERN_NOT_DURABLE')),
    'the inferred-pattern skip was not diagnosed',
  )
}

/** F/G. REPEATED_BEHAVIOR needs two distinct in-batch references. */
async function testRepeatedBehaviorAdmission(): Promise<void> {
  const single = createHarness({
    extractorResponses: [`[{"scope":"MEMBER","kind":"SOFT_STYLE_PREFERENCE","content":"他偏好简短","evidenceType":"REPEATED_BEHAVIOR","evidence":["M1"]}]`],
  })
  await feed(single.service, 3)
  assert.equal(single.service.recordCount, 0, 'a single-reference repeated behavior was written')
  assert.ok(
    evidenceLines(single.logs).some((line) => line.includes('reason=INSUFFICIENT_EVIDENCE')),
    'the insufficient-evidence skip was not diagnosed',
  )

  const repeated = createHarness({
    extractorResponses: [`[{"scope":"MEMBER","kind":"SOFT_STYLE_PREFERENCE","content":"他偏好简短","evidenceType":"REPEATED_BEHAVIOR","evidence":["M1","M3"]}]`],
  })
  await feed(repeated.service, 3)
  const records = repeated.store.retrieve([{ scopeType: 'MEMBER', scopeId: REQUESTER, visibility: 'SHARED' }], 10)
  assert.equal(records.length, 1, 'the two-reference repeated behavior was not written')
  assert.equal(records[0]?.evidenceCount, 2)
  assert.equal(records[0]?.confidence, 0.75)
}

/** H/I/J. Reference validation: empty, out-of-range and duplicate refs are rejected. */
async function testEvidenceReferenceValidation(): Promise<void> {
  const cases: Array<{ evidence: string; reason: string }> = [
    { evidence: '[]', reason: 'EVIDENCE_MISSING' },
    { evidence: '["M999"]', reason: 'EVIDENCE_INVALID' },
    { evidence: '["M0"]', reason: 'EVIDENCE_INVALID' },
    { evidence: '["M1","M1"]', reason: 'EVIDENCE_INVALID' },
    { evidence: '"M1"', reason: 'EVIDENCE_MISSING' },
  ]
  for (const testCase of cases) {
    const harness = createHarness({
      extractorResponses: [`[{"scope":"MEMBER","content":"${FACT}","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":${testCase.evidence}}]`],
    })
    await feed(harness.service, 3)
    assert.equal(harness.service.recordCount, 0, `evidence ${testCase.evidence} was durably written`)
    assert.ok(
      evidenceLines(harness.logs).some((line) => line.includes(`reason=${testCase.reason}`)),
      `evidence ${testCase.evidence} was not diagnosed as ${testCase.reason}: ${evidenceLines(harness.logs).join(' | ')}`,
    )
  }
}

/** L. A provider may never claim a runtime-owned evidence class. */
async function testProviderCannotClaimRuntimeOwnedEvidenceClasses(): Promise<void> {
  for (const evidenceType of ['EXPLICIT_OWNER_COMMAND', 'EXPLICIT_SELF_ADDRESS', 'LEGACY_UNKNOWN']) {
    const harness = createHarness({
      extractorResponses: [`[{"scope":"MEMBER","content":"${FACT}","evidenceType":"${evidenceType}","evidence":["M1"]}]`],
    })
    await feed(harness.service, 3)
    assert.equal(harness.service.recordCount, 0, `provider-claimed ${evidenceType} was durably written`)
    assert.ok(
      evidenceLines(harness.logs).some((line) => line.includes('reason=EVIDENCE_TYPE_NOT_ALLOWED')),
      `provider-claimed ${evidenceType} was not rejected as EVIDENCE_TYPE_NOT_ALLOWED`,
    )
  }

  // A missing evidence class is equally not allowed — fail closed.
  const harness = createHarness({
    extractorResponses: [`[{"scope":"MEMBER","content":"${FACT}","evidence":["M1"]}]`],
  })
  await feed(harness.service, 3)
  assert.equal(harness.service.recordCount, 0, 'an unclassified candidate was durably written')
  assert.ok(evidenceLines(harness.logs).some((line) => line.includes('reason=EVIDENCE_TYPE_NOT_ALLOWED')))
}

/** Q/R/S. The evidence gate runs AFTER the existing policy, so old rejections keep their reasons. */
async function testEvidenceGateRunsAfterExistingPolicy(): Promise<void> {
  const cases: Array<{ candidate: string; reason: string }> = [
    // Q. automatic GROUP scope protection.
    { candidate: '[{"scope":"GROUP","subject":"GROUP","kind":"SELF_FACT","content":"这个群周五聚餐"}]', reason: 'AUTOMATIC_GROUP_SCOPE_NOT_WRITABLE' },
    // R. OTHER_MEMBER rejection.
    { candidate: '[{"scope":"MEMBER","subject":"OTHER_MEMBER","kind":"SELF_FACT","content":"张三不吃香菜"}]', reason: 'THIRD_PARTY_ASSERTION_NOT_WRITABLE' },
    // S. raw identity protection.
    { candidate: `[{"scope":"MEMBER","content":"wxid_raw 的代号是 Secret","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":["M1"]}]`, reason: 'RAW_IDENTITY_IN_CONTENT' },
  ]
  for (const testCase of cases) {
    const harness = createHarness({ extractorResponses: [testCase.candidate] })
    await feed(harness.service, 3)
    assert.equal(harness.service.recordCount, 0, `candidate was written: ${testCase.candidate}`)
    assert.ok(
      harness.logs.some((line) => line.includes(`reason=${testCase.reason}`)),
      `expected reason=${testCase.reason} for ${testCase.candidate}`,
    )
  }
}

/** P. Duplicate-content behavior is unchanged (store dedupe still SKIPPED). */
async function testDuplicateBehaviorUnchanged(): Promise<void> {
  const harness = createHarness({
    extractorResponses: [
      `[{"scope":"MEMBER","content":"${FACT}","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":["M1"]}]`,
      `[{"scope":"MEMBER","content":"${FACT}","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":["M1"]}]`,
    ],
  })
  await feed(harness.service, 3, '第一轮聊天')
  await feed(harness.service, 3, '第二轮聊天')
  assert.equal(harness.service.recordCount, 1, 'duplicate content wrote a second record')
  assert.ok(
    harness.logs.some((line) => line.startsWith('[MEMORY_WRITE]') && line.includes('result=SKIPPED')),
    'the duplicate write was not reported as SKIPPED',
  )
  // The skipped duplicate emitted no ADMITTED evidence line: nothing was applied.
  const admitted = evidenceLines(harness.logs).filter((line) => line.includes('result=ADMITTED'))
  assert.equal(admitted.length, 1, 'the duplicate wrote a second evidence admission')
}

// ------------------------------------------------- M/N/O: runtime-owned paths

/** M. Explicit OWNER ADD → EXPLICIT_OWNER_COMMAND, confidence 1, one evidence item. */
async function testExplicitOwnerAddEvidence(): Promise<void> {
  const harness = createHarness({
    mutateResponse: '{"operation":"ADD","target":null,"content":"我的代号是 Boss","scope":"OWNER"}',
  })
  const result = await harness.service.tryHandleExplicit(explicitRequest('记住我的代号是 Boss'))
  assert.equal(result.reply, '记住了。')

  const records = harness.store.retrieve([{ scopeType: 'OWNER', scopeId: REQUESTER, visibility: 'SHARED' }], 10)
  assert.equal(records.length, 1)
  const record = records[0]!
  assert.equal(record.origin, 'EXPLICIT_OWNER')
  assert.equal(record.evidenceType, 'EXPLICIT_OWNER_COMMAND')
  assert.equal(record.confidence, 1)
  assert.equal(record.evidenceCount, 1)
  assert.equal(record.firstEvidenceAt, record.lastEvidenceAt)
  assert.ok(
    evidenceLines(harness.logs).some((line) =>
      line.includes('origin=EXPLICIT_OWNER') && line.includes('confidenceBand=HIGH') && line.includes('result=ADMITTED')),
    'the owner ADD evidence was not diagnosed as admitted',
  )
}

/** N. Explicit OWNER UPDATE upgrades evidence and keeps the original first-evidence time. */
async function testExplicitOwnerUpdateEvidence(): Promise<void> {
  const harness = createHarness({
    mutateResponse: '{"operation":"ADD","target":null,"content":"我的代号是 Boss","scope":"OWNER"}',
  })
  await harness.service.tryHandleExplicit(explicitRequest('记住我的代号是 Boss'))
  const first = harness.store.retrieve([{ scopeType: 'OWNER', scopeId: REQUESTER, visibility: 'SHARED' }], 10)[0]!
  const firstEvidenceAt = first.firstEvidenceAt!

  harness.logs.length = 0
  // A later turn with a later clock performs the real update on the same store.
  const updater = new MemoryService({
    store: harness.store,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => '{"operation":"UPDATE","target":"M1","content":"我的代号是 Boss v2","kind":"SELF_FACT"}',
    now: steppingClock(1_700_000_100_000),
    idFactory: sequentialIds(),
    log: (line) => harness.logs.push(line),
    enableTimer: false,
  })
  const result = await updater.tryHandleExplicit(explicitRequest('修改记忆：把我的代号改成 Boss v2'))
  assert.equal(result.reply, '改好了。')

  const updated = harness.store.retrieve([{ scopeType: 'OWNER', scopeId: REQUESTER, visibility: 'SHARED' }], 10)[0]!
  assert.equal(updated.evidenceType, 'EXPLICIT_OWNER_COMMAND')
  assert.equal(updated.confidence, 1)
  assert.equal(updated.evidenceCount, 2, 'the update did not count as one more evidence item')
  assert.equal(updated.firstEvidenceAt, firstEvidenceAt, 'the update reset the original first-evidence time')
  assert.ok(updated.lastEvidenceAt! > updated.firstEvidenceAt!, 'the update did not advance lastEvidenceAt')
  assert.ok(
    evidenceLines(harness.logs).some((line) => line.includes('origin=EXPLICIT_OWNER') && line.includes('result=ADMITTED')),
    'the owner UPDATE evidence was not diagnosed',
  )
}

/** N (legacy half). Updating a pre-evidence record starts authoritative evidence fresh. */
async function testExplicitOwnerUpdateOnLegacyRecord(): Promise<void> {
  const harness = createHarness({
    mutateResponse: '{"operation":"UPDATE","target":"M1","content":"我的代号是 Boss v2","kind":"SELF_FACT"}',
  })
  harness.store.add({
    memoryId: 'legacy-owner-record',
    scopeType: 'OWNER',
    scopeId: REQUESTER,
    content: '我的代号是 Boss',
    contentHash: '',
    visibility: 'SHARED',
    origin: 'EXPLICIT_OWNER',
    sourceConversationType: 'GROUP',
    sourceConversationId: ROOM,
    sourceSenderId: REQUESTER,
    createdAt: 1,
    updatedAt: 1,
    isDeleted: false,
  })

  const result = await harness.service.tryHandleExplicit(explicitRequest('修改记忆：把我的代号改成 Boss v2'))
  assert.equal(result.reply, '改好了。')
  const updated = harness.store.retrieve([{ scopeType: 'OWNER', scopeId: REQUESTER, visibility: 'SHARED' }], 10)[0]!
  assert.equal(updated.evidenceType, 'EXPLICIT_OWNER_COMMAND')
  assert.equal(updated.confidence, 1)
  assert.equal(updated.evidenceCount, 1, 'a legacy record did not start at one evidence item')
  assert.ok(Number.isFinite(updated.firstEvidenceAt!) && Number.isFinite(updated.lastEvidenceAt!))
}

/** O. Self-address fast path writes authoritative EXPLICIT_SELF_ADDRESS evidence. */
async function testSelfAddressEvidence(): Promise<void> {
  const harness = createHarness()
  const base: ExplicitMemoryRequest = {
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: REQUESTER,
    requesterRole: 'MEMBER',
    question: '以后叫我静宝',
    ...TRUSTED_FRAMING,
  }

  const first = harness.service.tryHandleSelfAddressPreference(base)
  assert.deepEqual(first, { handled: true, reply: '好，以后叫你静宝。' })
  const written = harness.store.retrieve([{ scopeType: 'MEMBER', scopeId: REQUESTER, visibility: 'SHARED' }], 10)[0]!
  assert.equal(written.evidenceType, 'EXPLICIT_SELF_ADDRESS')
  assert.equal(written.confidence, 1)
  assert.equal(written.evidenceCount, 1)
  const firstEvidenceAt = written.firstEvidenceAt!

  // Repeating the same nickname stays SKIPPED and never downgrades the record.
  const repeat = harness.service.tryHandleSelfAddressPreference(base)
  assert.deepEqual(repeat, { handled: true, reply: '好，以后叫你静宝。' })
  const unchanged = harness.store.retrieve([{ scopeType: 'MEMBER', scopeId: REQUESTER, visibility: 'SHARED' }], 10)[0]!
  assert.equal(unchanged.evidenceCount, 1, 'a repeated nickname changed the stored evidence count')
  assert.equal(unchanged.firstEvidenceAt, firstEvidenceAt)

  // Updating the nickname keeps authoritative explicit evidence.
  const update = harness.service.tryHandleSelfAddressPreference({
    ...base,
    question: '以后叫我梨宝',
  })
  assert.deepEqual(update, { handled: true, reply: '好，以后叫你梨宝。' })
  const upgraded = harness.store.retrieve([{ scopeType: 'MEMBER', scopeId: REQUESTER, visibility: 'SHARED' }], 10)[0]!
  assert.equal(upgraded.content, '梨宝')
  assert.equal(upgraded.evidenceType, 'EXPLICIT_SELF_ADDRESS', 'the nickname update downgraded the evidence')
  assert.equal(upgraded.confidence, 1)
  assert.equal(upgraded.evidenceCount, 2, 'the nickname update did not count as evidence')
  assert.equal(upgraded.firstEvidenceAt, firstEvidenceAt, 'the nickname update reset firstEvidenceAt')
  assert.ok(
    evidenceLines(harness.logs).some((line) => line.includes('origin=EXPLICIT_SELF_ADDRESS') && line.includes('result=ADMITTED')),
    'the self-address evidence was not diagnosed',
  )
}

// ------------------------------------------------------- U/W: read side + logs

/** U. Confidence does not participate in retrieval ordering. */
async function testRetrievalOrderUnchangedByConfidence(): Promise<void> {
  const harness = createHarness()
  // Older record with maximum confidence; newer legacy record without evidence.
  harness.store.add({
    memoryId: 'high-confidence-old',
    scopeType: 'MEMBER',
    scopeId: REQUESTER,
    content: '我的代号是 Alpha',
    contentHash: '',
    visibility: 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: ROOM,
    sourceSenderId: REQUESTER,
    createdAt: 100,
    updatedAt: 100,
    isDeleted: false,
    evidenceType: 'EXPLICIT_OWNER_COMMAND',
    confidence: 1,
    evidenceCount: 1,
    firstEvidenceAt: 100,
    lastEvidenceAt: 100,
  })
  harness.store.add({
    memoryId: 'legacy-new',
    scopeType: 'MEMBER',
    scopeId: REQUESTER,
    content: '我的代号是 Beta',
    contentHash: '',
    visibility: 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: ROOM,
    sourceSenderId: REQUESTER,
    createdAt: 200,
    updatedAt: 200,
    isDeleted: false,
  })

  const items = await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: REQUESTER,
    requesterRole: 'MEMBER',
    question: '今天天气怎么样',
  })
  assert.equal(items.length, 2, 'retrieval visibility changed with evidence metadata')
  assert.equal(items[0]?.content, '我的代号是 Beta', 'confidence changed the recency-first retrieval order')
  assert.equal(items[1]?.content, '我的代号是 Alpha')
}

/** W. `[MEMORY_EVIDENCE]` diagnostics carry no content, ids or exact decimals. */
async function testEvidenceDiagnosticsCarryNoRawData(): Promise<void> {
  const harness = createHarness({
    extractorResponses: [
      `[{"scope":"MEMBER","content":"${FACT}","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":["M1"]}]`,
      `[{"scope":"MEMBER","content":"他喜欢热闹","evidenceType":"INFERRED_PATTERN","evidence":["M1"]}]`,
    ],
    mutateResponse: '{"operation":"ADD","target":null,"content":"我的代号是 Boss","scope":"OWNER"}',
  })
  await feed(harness.service, 3)
  const add = await harness.service.tryHandleExplicit(explicitRequest('记住我的代号是 Boss'))
  assert.equal(add.reply, '记住了。')
  const address = harness.service.tryHandleSelfAddressPreference({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: REQUESTER,
    requesterRole: 'MEMBER',
    question: '以后叫我静宝',
    ...TRUSTED_FRAMING,
  })
  assert.equal(address.handled, true)

  const lines = evidenceLines(harness.logs)
  assert.ok(lines.length >= 3, `expected evidence diagnostics, got: ${lines.join(' | ')}`)
  for (const line of lines) {
    for (const forbidden of [FACT, '他喜欢热闹', '静宝', REQUESTER, ROOM, 'requester', 'chatroom', '代号是 Boss']) {
      assert.ok(!line.includes(forbidden), `the evidence diagnostic leaked raw data (${forbidden}): ${line}`)
    }
    assert.ok(!/[0-9]+\.[0-9]+/.test(line.replace(/M\d+/gu, '')), `the evidence diagnostic printed an exact decimal: ${line}`)
  }
  assert.ok(lines.some((line) => line.includes('origin=AUTOMATIC') && line.includes('confidenceBand=HIGH') && line.includes('result=ADMITTED')))
  assert.ok(lines.some((line) => line.includes('origin=EXPLICIT_OWNER') && line.includes('result=ADMITTED')))
  assert.ok(lines.some((line) => line.includes('origin=EXPLICIT_SELF_ADDRESS') && line.includes('result=ADMITTED')))
}

// ---------------------------------------------------------- extractor transport

/** Extractor: batch numbering, evidence transport, and closed-set behavior. */
async function testExtractorEvidenceTransport(): Promise<void> {
  const extractorInputs: string[] = []
  const responses = [
    '[{"scope":"MEMBER","content":"占位","evidenceType":"EXPLICIT_PREFERENCE","evidence":["M1"]}]',
    '[{"scope":"MEMBER","content":"事实一","evidenceType":"EXPLICIT_PREFERENCE","evidence":["M1","M2"]}]',
    '[{"scope":"MEMBER","content":"事实二","evidenceType":"explicit_self_statement","evidence":["M1"]}]',
    '[{"scope":"MEMBER","content":"事实三","evidenceType":"EXPLICIT_OWNER_COMMAND","evidence":["M1"]}]',
    '[{"scope":"MEMBER","content":"事实四","evidenceType":"EXPLICIT_PREFERENCE","evidence":"M1"}]',
    '[{"scope":"MEMBER","content":"事实五"}]',
  ]
  const extractor = new MemoryExtractor(async (_system, user) => {
    extractorInputs.push(user)
    return responses[extractorInputs.length - 1] ?? '[]'
  })

  const messages: MemoryInputMessage[] = [
    { speakerLabel: 'MEMBER_1', role: 'MEMBER', content: '第一条消息' },
    { speakerLabel: 'MEMBER_1', role: 'MEMBER', content: '第二条消息' },
  ]

  await extractor.extract('GROUP', messages)
  assert.ok(extractorInputs[0]?.includes('[M1 | MEMBER_1 | MEMBER]'), 'the extractor input lost the M1 batch number')
  assert.ok(extractorInputs[0]?.includes('[M2 | MEMBER_1 | MEMBER]'), 'the extractor input lost the M2 batch number')
  assert.ok(!extractorInputs[0]?.includes('[M3'), 'the extractor input numbered more messages than the batch holds')

  // Lowercase evidence classes normalize; runtime-owned classes and malformed
  // evidence stay unclassified for the runtime gate to reject observably.
  const automatic: Awaited<ReturnType<MemoryExtractor['extract']>> = []
  for (let call = 1; call <= 5; call += 1) {
    automatic.push(...await extractor.extract('GROUP', messages))
  }
  assert.equal(automatic.length, 5, 'one schema-valid candidate was dropped by the extractor')
  assert.equal(automatic[0]?.evidenceType, 'EXPLICIT_PREFERENCE')
  assert.deepEqual(automatic[0]?.evidenceRefs, ['M1', 'M2'])
  assert.equal(automatic[1]?.evidenceType, 'EXPLICIT_SELF_STATEMENT')
  assert.equal(automatic[2]?.evidenceType, undefined, 'a runtime-owned evidence class passed through the extractor')
  assert.equal(automatic[3]?.evidenceType, 'EXPLICIT_PREFERENCE')
  assert.equal(automatic[3]?.evidenceRefs, undefined, 'a non-array evidence field passed through the extractor')
  assert.equal(automatic[4]?.evidenceType, undefined)
  assert.equal(automatic[4]?.evidenceRefs, undefined)
}

/** The service flush keeps one extractor batch per flush at the batch threshold. */
async function testBatchSizeMatchesReferences(): Promise<void> {
  const harness = createHarness({
    extractorResponses: [`[{"scope":"MEMBER","content":"${FACT}","evidenceType":"REPEATED_BEHAVIOR","evidence":["M1","M${MEMORY_AUTO_FLUSH_BATCH_SIZE}"]}]`],
  })
  await feed(harness.service, MEMORY_AUTO_FLUSH_BATCH_SIZE)
  const records = harness.store.retrieve([{ scopeType: 'MEMBER', scopeId: REQUESTER, visibility: 'SHARED' }], 10)
  assert.equal(records.length, 1, 'a reference at the batch boundary was wrongly rejected')
  assert.equal(records[0]?.evidenceCount, 2)
}

// ------------------------------------------------------------- store hardening

/** Invalid or partial evidence metadata in the file is corruption, same as any other field. */
function testStoreRejectsInvalidEvidenceFields(): void {
  const base = {
    memoryId: 'record-1',
    scopeType: 'MEMBER',
    scopeId: 'member-store-a',
    content: '存储校验记忆',
    contentHash: MemoryText.hash(MemoryText.normalize('存储校验记忆')),
    visibility: 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: 'room-store@chatroom',
    sourceSenderId: 'member-store-a',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    isDeleted: false,
  }
  const validEvidence = {
    evidenceType: 'EXPLICIT_SELF_STATEMENT',
    confidence: 0.95,
    evidenceCount: 1,
    firstEvidenceAt: 1_700_000_000_000,
    lastEvidenceAt: 1_700_000_000_000,
  }

  const loads = (record: Record<string, unknown>): boolean => {
    const directory = tempDir()
    const filePath = memoryFileIn(directory)
    writeFileSync(filePath, `${JSON.stringify({ version: 1, records: [record] })}\n`, 'utf8')
    const store = new MemoryStore({ filePath, log: () => undefined, pathSource: 'TEST_STORE' })
    return store.isEnabled
  }

  assert.equal(loads({ ...base }), true, 'a legacy record without evidence fields must load')
  assert.equal(loads({ ...base, ...validEvidence }), true, 'a complete valid evidence set must load')
  assert.equal(loads({ ...base, ...validEvidence, confidence: 1.5 }), false, 'confidence outside [0,1] must corrupt the store')
  assert.equal(loads({ ...base, ...validEvidence, confidence: -0.1 }), false, 'negative confidence must corrupt the store')
  assert.equal(loads({ ...base, ...validEvidence, evidenceType: 'MADE_UP_TYPE' }), false, 'an unknown evidence type must corrupt the store')
  assert.equal(loads({ ...base, ...validEvidence, evidenceCount: 0 }), false, 'a non-positive evidence count must corrupt the store')
  assert.equal(
    loads({ ...base, ...validEvidence, firstEvidenceAt: 1_700_000_000_002, lastEvidenceAt: 1_700_000_000_001 }),
    false,
    'firstEvidenceAt after lastEvidenceAt must corrupt the store',
  )
  assert.equal(
    loads({ ...base, evidenceType: 'EXPLICIT_SELF_STATEMENT' }),
    false,
    'a partial evidence set must corrupt the store',
  )
  assert.equal(
    loads({ ...base, confidence: 0.95, evidenceCount: 1, firstEvidenceAt: 1, lastEvidenceAt: 1 }),
    false,
    'confidence without an evidence type must corrupt the store',
  )

  const directory = tempDir()
  const filePath = memoryFileIn(directory)
  writeFileSync(filePath, `${JSON.stringify({ version: 1, records: [{ ...base, ...validEvidence }] })}\n`, 'utf8')
  const store = new MemoryStore({ filePath, log: () => undefined, pathSource: 'TEST_STORE_VALID' })
  const loaded = store.retrieve([{ scopeType: 'MEMBER', scopeId: 'member-store-a', visibility: 'SHARED' }], 10)[0]
  assert.equal(loaded?.evidenceType, 'EXPLICIT_SELF_STATEMENT')
  assert.equal(loaded?.confidence, 0.95)
  assert.equal(loaded?.evidenceCount, 1)
}

// ---------------------------------------------------------------------- runner

async function main(): Promise<void> {
  const cases: Array<[string, () => void | Promise<void>]> = [
    ['confidence-table-and-bands', testConfidenceTableAndBands],
    ['upgraded-explicit-evidence-rule', testUpgradedExplicitEvidenceRule],
    ['gate-unit-rules', testGateUnitRules],
    ['legacy-v1-fixture-loads-and-serves', testLegacyV1FixtureLoadsAndServes],
    ['automatic-self-statement-written', testAutomaticSelfStatementWritten],
    ['automatic-preference-written', testAutomaticPreferenceWritten],
    ['inferred-pattern-never-durable', testInferredPatternNeverDurable],
    ['repeated-behavior-admission', testRepeatedBehaviorAdmission],
    ['evidence-reference-validation', testEvidenceReferenceValidation],
    ['provider-cannot-claim-runtime-owned-classes', testProviderCannotClaimRuntimeOwnedEvidenceClasses],
    ['evidence-gate-runs-after-existing-policy', testEvidenceGateRunsAfterExistingPolicy],
    ['duplicate-behavior-unchanged', testDuplicateBehaviorUnchanged],
    ['explicit-owner-add-evidence', testExplicitOwnerAddEvidence],
    ['explicit-owner-update-evidence', testExplicitOwnerUpdateEvidence],
    ['explicit-owner-update-on-legacy-record', testExplicitOwnerUpdateOnLegacyRecord],
    ['self-address-evidence', testSelfAddressEvidence],
    ['retrieval-order-unchanged-by-confidence', testRetrievalOrderUnchangedByConfidence],
    ['evidence-diagnostics-carry-no-raw-data', testEvidenceDiagnosticsCarryNoRawData],
    ['extractor-evidence-transport', testExtractorEvidenceTransport],
    ['batch-size-matches-references', testBatchSizeMatchesReferences],
    ['store-rejects-invalid-evidence-fields', testStoreRejectsInvalidEvidenceFields],
  ]
  let failures = 0
  try {
    for (const [name, run] of cases) {
      try {
        await run()
        console.log(`[MEMORY_EVIDENCE_CASE] name=${name} result=PASS`)
      } catch (error) {
        failures += 1
        console.error(`[MEMORY_EVIDENCE_CASE] name=${name} result=FAIL error=${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    cleanup()
  }
  console.log(`[MEMORY_EVIDENCE_TEST_SUMMARY] cases=${cases.length} failures=${failures}`)
  if (failures > 0) {
    process.exitCode = 1
  }
}

void main()
