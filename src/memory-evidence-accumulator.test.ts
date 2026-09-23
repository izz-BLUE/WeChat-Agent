/**
 * MEMORY EVIDENCE FOUNDATION P1 — cross-batch evidence accumulator tests.
 *
 * Matrix:
 *   A. first REPEATED_BEHAVIOR contribution pools (count=1) and never writes.
 *   B. second contribution reaches the threshold and writes with the
 *      runtime-maintained accumulated count.
 *   C/D. different requesters and different personal scopes never merge.
 *   E. entries idle beyond the sliding TTL expire (EXPIRED) and the pool
 *      restarts from zero.
 *   F. forged references (M999 / M0 / duplicate M1) are rejected by the gate
 *      before the pool and by the pool's own defense-in-depth validation.
 *   G. the pool is never persisted: a restarted service starts from zero and
 *      memory.json carries no accumulator fields.
 *
 * All fixtures use synthetic ids and synthetic facts; no raw production data.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryEvidenceAccumulator,
  normalizeEvidenceKeyContent,
  REPEATED_EVIDENCE_TTL_MS,
} from './memory-evidence-accumulator.js'
import { REPEATED_EVIDENCE_ADMISSION_THRESHOLD } from './memory-evidence.js'
import { MemoryExtractor } from './memory-extractor.js'
import { MemoryService, memberScopeId } from './memory-service.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'

const ROOM = 'room-acc@chatroom'
const REQUESTER = 'requester-acc-a'
const CAT_PREFERENCE = '我喜欢猫'

const REPEATED_FIXTURE = `[{"scope":"MEMBER","kind":"SOFT_STYLE_PREFERENCE","content":"${CAT_PREFERENCE}","evidenceType":"REPEATED_BEHAVIOR","evidence":["M1"]}]`

// --------------------------------------------------------------- test harness

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-acc-'))
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

function steppingClock(start = 1_700_000_000_000): () => number {
  let value = start
  return () => {
    value += 1000
    return value
  }
}

function sequentialIds(): () => string {
  let counter = 0
  return () => `acc-${(++counter).toString().padStart(4, '0')}`
}

/** Reconstructs the deterministic pool key the service builds (contract pin). */
function expectedKey(scopeType: string, scopeId: string, content: string): string {
  return `${scopeType}:${scopeId}:CURRENT_REQUESTER:SOFT_STYLE_PREFERENCE:${normalizeEvidenceKeyContent(content)}`
}

interface Harness {
  filePath: string
  store: MemoryStore
  service: MemoryService
  accumulator: MemoryEvidenceAccumulator
  logs: string[]
}

interface HarnessOptions {
  extractorResponses?: string[]
  accumulator?: MemoryEvidenceAccumulator
}

function createHarness(options: HarnessOptions = {}): Harness {
  const directory = tempDir()
  const filePath = memoryFileIn(directory)
  const logs: string[] = []
  const clock = steppingClock()
  const accumulator = options.accumulator ?? new MemoryEvidenceAccumulator({ now: clock })
  const responses = options.extractorResponses ?? ['[]']

  const store = new MemoryStore({ filePath, log: () => undefined, pathSource: 'TEST' })
  let accumulatorCallCount = 0
  const extractor = new MemoryExtractor(async () => {
    const index = Math.min(accumulatorCallCount, responses.length - 1)
    accumulatorCallCount += 1
    return responses[index] ?? '[]'
  })
  const service = new MemoryService({
    store,
    extractor,
    mutate: async () => '{"operation":"NONE"}',
    now: clock,
    idFactory: sequentialIds(),
    log: (line) => logs.push(line),
    enableTimer: false,
    accumulator,
  })
  return { filePath, store, service, accumulator, logs }
}

let feedRun = 0

interface FeedOptions {
  requesterId?: string
  role?: 'OWNER' | 'MEMBER'
  text?: string
}

/** Feeds one 3-message GROUP batch that triggers a chat-threshold flush. */
async function feed(service: MemoryService, options: FeedOptions = {}): Promise<void> {
  feedRun += 1
  for (let index = 0; index < 3; index += 1) {
    service.observeHumanMessage({
      messageId: `acc-feed-${feedRun}-${index}`,
      conversationType: 'GROUP',
      conversationId: ROOM,
      requesterId: options.requesterId ?? REQUESTER,
      requesterRole: options.role ?? 'MEMBER',
      speakerLabel: 'MEMBER_1',
      text: options.text ?? '普通聊天消息',
      timestamp: 1_757_000_000_000 + index,
      chatTriggered: true,
    })
  }
  await service.flushAll()
}

function accumulatorLines(logs: readonly string[]): string[] {
  return logs.filter((line) => line.startsWith('[MEMORY_EVIDENCE_ACCUMULATOR]'))
}

function persistedDocument(filePath: string): { version: number; records: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(filePath, 'utf8')) as { version: number; records: Array<Record<string, unknown>> }
}

// ------------------------------------------------------------ key normalization

function testNormalizeEvidenceKey(): void {
  // The task-mandated collision: hedged restatements share one pool slot.
  assert.equal(normalizeEvidenceKeyContent('我喜欢猫'), normalizeEvidenceKeyContent('我挺喜欢猫的'))
  assert.equal(normalizeEvidenceKeyContent('喜欢猫！'), normalizeEvidenceKeyContent('我喜欢猫'))
  // Negation is a content difference, never a filler.
  assert.notEqual(normalizeEvidenceKeyContent('我不喜欢猫'), normalizeEvidenceKeyContent('我喜欢猫'))
  assert.notEqual(normalizeEvidenceKeyContent('喜欢狗'), normalizeEvidenceKeyContent('喜欢猫'))
  // The component can never be empty (otherwise every hedge-only key merged).
  assert.equal(normalizeEvidenceKeyContent('的'), '的')
  assert.ok(normalizeEvidenceKeyContent('嗯！！！').length > 0)
}

// ------------------------------------------------------------- unit-level rules

function testAccumulatorUnitRules(): void {
  const accumulator = new MemoryEvidenceAccumulator({ now: steppingClock() })

  // REPEATED_BEHAVIOR only.
  const wrongType = accumulator.addEvidence({
    candidateKey: 'k',
    evidenceType: 'EXPLICIT_PREFERENCE',
    evidenceRefs: ['M1'],
    scopeId: 's',
  })
  assert.equal(wrongType.outcome, 'REJECTED')
  assert.equal(wrongType.outcome === 'REJECTED' ? wrongType.reason : '', 'EVIDENCE_TYPE_NOT_ALLOWED')

  // Defense-in-depth reference validation: empty, malformed, duplicate.
  for (const refs of [[], ['M0'], ['M1', 'M1'], ['x'], ['M1', 1]]) {
    const rejected = accumulator.addEvidence({
      candidateKey: 'k',
      evidenceType: 'REPEATED_BEHAVIOR',
      evidenceRefs: refs as readonly unknown[] as readonly string[],
      scopeId: 's',
    })
    assert.equal(rejected.outcome, 'REJECTED', `refs ${JSON.stringify(refs)} must be rejected`)
    assert.equal(rejected.outcome === 'REJECTED' ? rejected.reason : '', 'EVIDENCE_REFS_INVALID')
  }
  assert.equal(accumulator.size, 0, 'a rejected contribution must not create a pool entry')

  // Range validation is the gate's job: the pool checks format/distinct only.
  const rangeAccepted = accumulator.addEvidence({
    candidateKey: 'k',
    evidenceType: 'REPEATED_BEHAVIOR',
    evidenceRefs: ['M999'],
    scopeId: 's',
  })
  assert.equal(rangeAccepted.outcome, 'ACCEPTED')

  // Count accumulates across contributions; refs carry the latest batch only.
  const first = accumulator.getAccumulatedEvidence({ candidateKey: 'k' })!
  assert.equal(first.evidenceCount, 1)
  const second = accumulator.addEvidence({
    candidateKey: 'k',
    evidenceType: 'REPEATED_BEHAVIOR',
    evidenceRefs: ['M2', 'M5'],
    scopeId: 's',
  })
  assert.equal(second.outcome, 'ACCEPTED')
  const entry = accumulator.getAccumulatedEvidence({ candidateKey: 'k' })!
  assert.equal(entry.evidenceCount, 3, 'the pool must sum per-batch distinct references')
  assert.deepEqual(entry.evidenceRefs, ['M2', 'M5'], 'entry refs carry the latest batch, not the union')
  assert.ok(entry.firstSeenAt <= entry.lastSeenAt)
  assert.equal(entry.evidenceType, 'REPEATED_BEHAVIOR')
}

function testAccumulatorTtlUnit(): void {
  let now = 1_700_000_000_000
  const accumulator = new MemoryEvidenceAccumulator({
    now: () => now,
    ttlMs: REPEATED_EVIDENCE_TTL_MS,
  })
  accumulator.addEvidence({
    candidateKey: 'k',
    evidenceType: 'REPEATED_BEHAVIOR',
    evidenceRefs: ['M1'],
    scopeId: 's',
  })
  now += REPEATED_EVIDENCE_TTL_MS - 1
  assert.equal(accumulator.clearExpired(), 0, 'an entry inside its TTL must survive')
  assert.equal(accumulator.size, 1)

  // "超过 TTL" is strictly beyond: at exactly the TTL the entry is still alive.
  now += 2
  assert.equal(accumulator.clearExpired(), 1, 'an entry beyond its TTL must purge')
  assert.equal(accumulator.size, 0)

  // A contribution after expiry starts a fresh entry and reports EXPIRED inputs.
  const afterExpiry = accumulator.addEvidence({
    candidateKey: 'k',
    evidenceType: 'REPEATED_BEHAVIOR',
    evidenceRefs: ['M1'],
    scopeId: 's',
  })
  assert.equal(afterExpiry.outcome, 'ACCEPTED')
  assert.equal(afterExpiry.outcome === 'ACCEPTED' ? afterExpiry.expiredPrior : true, false,
    'no prior entry survived the purge, so this is a fresh start (expiredPrior only reports a dropped LIVE predecessor)')

  accumulator.reset()
  assert.equal(accumulator.size, 0)
}

function testAccumulatorExpiryRefresh(): void {
  let now = 1_700_000_000_000
  const accumulator = new MemoryEvidenceAccumulator({ now: () => now, ttlMs: 1_000 })
  const first = accumulator.addEvidence({
    candidateKey: 'k',
    evidenceType: 'REPEATED_BEHAVIOR',
    evidenceRefs: ['M1'],
    scopeId: 's',
  })
  assert.equal(first.outcome, 'ACCEPTED')
  const firstEntry = first.outcome === 'ACCEPTED' ? first.entry : undefined
  now += 600
  accumulator.addEvidence({
    candidateKey: 'k',
    evidenceType: 'REPEATED_BEHAVIOR',
    evidenceRefs: ['M2'],
    scopeId: 's',
  })
  const entry = accumulator.getAccumulatedEvidence({ candidateKey: 'k' })!
  assert.equal(entry.evidenceCount, 2, 'a contribution inside the TTL accumulates')
  assert.equal(entry.firstSeenAt, firstEntry?.firstSeenAt, 'firstSeenAt is the pool birth time')
  assert.equal(entry.lastSeenAt, now, 'lastSeenAt slides with each contribution')
  now += 2_000
  const stale = accumulator.addEvidence({
    candidateKey: 'k',
    evidenceType: 'REPEATED_BEHAVIOR',
    evidenceRefs: ['M1'],
    scopeId: 's',
  })
  assert.equal(stale.outcome, 'ACCEPTED')
  assert.equal(stale.outcome === 'ACCEPTED' ? stale.expiredPrior : false, true,
    'a contribution against an idle-beyond-TTL entry must report EXPIRED')
  assert.equal(accumulator.getAccumulatedEvidence({ candidateKey: 'k' })?.evidenceCount, 1,
    'the expired pool must restart from the fresh contribution')
}

// ------------------------------------------------------- integration matrix A–G

/** A+B. First contribution pools and waits; the second reaches the threshold and writes. */
async function testFirstWaitsSecondWrites(): Promise<void> {
  const harness = createHarness({ extractorResponses: [REPEATED_FIXTURE, REPEATED_FIXTURE] })

  // A.
  await feed(harness.service, { text: CAT_PREFERENCE })
  assert.equal(harness.service.recordCount, 0, 'a single pooled contribution must not write memory')
  const pooled = harness.accumulator.getAccumulatedEvidence({
    candidateKey: expectedKey('MEMBER', memberScopeId(ROOM, REQUESTER), CAT_PREFERENCE),
  })
  assert.ok(pooled, 'the contribution did not create a pool entry')
  assert.equal(pooled?.evidenceCount, 1)
  assert.equal(harness.accumulator.size, 1)
  assert.ok(
    accumulatorLines(harness.logs).some((line) => line.includes('result=WAITING') && line.includes('count=1')),
    'the WAITING decision was not diagnosed',
  )

  // B.
  await feed(harness.service, { text: CAT_PREFERENCE })
  assert.equal(harness.service.recordCount, 1, 'the second contribution did not write memory')
  const record = harness.store.retrieve([{ scopeType: 'MEMBER', scopeId: memberScopeId(ROOM, REQUESTER), visibility: 'SHARED' }], 10)[0]!
  assert.equal(record.content, CAT_PREFERENCE)
  assert.equal(record.evidenceType, 'REPEATED_BEHAVIOR')
  assert.equal(record.confidence, 0.75, 'the accumulated write lost the REPEATED_BEHAVIOR confidence')
  assert.equal(record.evidenceCount, 2, 'the durable record must carry the accumulated count')
  assert.ok(record.firstEvidenceAt! < record.lastEvidenceAt!, 'the record lost its cross-batch provenance')
  assert.ok(
    accumulatorLines(harness.logs).some((line) => line.includes('result=PASS') && line.includes('count=2')),
    'the threshold PASS was not diagnosed',
  )
  assert.ok(
    harness.logs.some((line) => line.startsWith('[MEMORY_EVIDENCE]') && line.includes('result=ADMITTED')),
    'the accumulated write did not emit the evidence ADMITTED line',
  )
}

/** C. Different requesters never merge, even with identical content. */
async function testRequesterIsolation(): Promise<void> {
  const harness = createHarness({ extractorResponses: [REPEATED_FIXTURE, REPEATED_FIXTURE] })
  await feed(harness.service, { requesterId: 'sig-a', text: CAT_PREFERENCE })
  await feed(harness.service, { requesterId: 'sig-b', text: CAT_PREFERENCE })

  assert.equal(harness.service.recordCount, 0, 'cross-requester evidence merged into a write')
  assert.equal(harness.accumulator.size, 2, 'the pool merged two requesters into one entry')
  const a = harness.accumulator.getAccumulatedEvidence({ candidateKey: expectedKey('MEMBER', memberScopeId(ROOM, 'sig-a'), CAT_PREFERENCE) })
  const b = harness.accumulator.getAccumulatedEvidence({ candidateKey: expectedKey('MEMBER', memberScopeId(ROOM, 'sig-b'), CAT_PREFERENCE) })
  assert.equal(a?.evidenceCount, 1)
  assert.equal(b?.evidenceCount, 1)
}

/** D. OWNER and MEMBER personal scopes never merge. */
async function testScopeIsolation(): Promise<void> {
  // A requester's role is a stable runtime fact (the slot binds it), so scope
  // isolation means different users in different personal scopes.
  const harness = createHarness({ extractorResponses: [REPEATED_FIXTURE, REPEATED_FIXTURE] })
  await feed(harness.service, { requesterId: 'sig-owner', role: 'OWNER', text: CAT_PREFERENCE })
  await feed(harness.service, { requesterId: 'sig-member', role: 'MEMBER', text: CAT_PREFERENCE })

  assert.equal(harness.service.recordCount, 0, 'cross-scope evidence merged into a write')
  assert.equal(harness.accumulator.size, 2, 'the pool merged OWNER and MEMBER scopes')
  const owner = harness.accumulator.getAccumulatedEvidence({ candidateKey: expectedKey('OWNER', 'sig-owner', CAT_PREFERENCE) })
  const member = harness.accumulator.getAccumulatedEvidence({ candidateKey: expectedKey('MEMBER', memberScopeId(ROOM, 'sig-member'), CAT_PREFERENCE) })
  assert.equal(owner?.evidenceCount, 1)
  assert.equal(member?.evidenceCount, 1)
}

/** E. A pool entry idle beyond the 7-day TTL expires and accumulation restarts. */
async function testTtlExpiryIntegration(): Promise<void> {
  let poolNow = 1_700_000_000_000
  const accumulator = new MemoryEvidenceAccumulator({ now: () => poolNow })
  const harness = createHarness({ extractorResponses: [REPEATED_FIXTURE, REPEATED_FIXTURE, REPEATED_FIXTURE], accumulator })

  await feed(harness.service, { text: CAT_PREFERENCE })
  assert.equal(harness.accumulator.getAccumulatedEvidence({ candidateKey: expectedKey('MEMBER', memberScopeId(ROOM, REQUESTER), CAT_PREFERENCE) })?.evidenceCount, 1)
  assert.equal(harness.service.recordCount, 0)

  poolNow += REPEATED_EVIDENCE_TTL_MS + 1
  await feed(harness.service, { text: CAT_PREFERENCE })
  assert.ok(
    accumulatorLines(harness.logs).some((line) => line.includes('result=EXPIRED')),
    'the expired pool was not diagnosed',
  )
  assert.equal(harness.accumulator.getAccumulatedEvidence({ candidateKey: expectedKey('MEMBER', memberScopeId(ROOM, REQUESTER), CAT_PREFERENCE) })?.evidenceCount, 1,
    'the expired pool must restart from the fresh contribution')
  assert.equal(harness.service.recordCount, 0, 'the post-expiry single contribution wrote memory')

  await feed(harness.service, { text: CAT_PREFERENCE })
  assert.equal(harness.service.recordCount, 1, 'post-expiry accumulation did not reach the threshold')
  const record = harness.store.retrieve([{ scopeType: 'MEMBER', scopeId: memberScopeId(ROOM, REQUESTER), visibility: 'SHARED' }], 10)[0]!
  assert.equal(record.evidenceCount, 2)
  assert.equal(record.evidenceType, 'REPEATED_BEHAVIOR')
}

/** F. Forged references are rejected by the gate before the pool ever grows. */
async function testForgedReferencesRejected(): Promise<void> {
  for (const evidence of ['["M999"]', '["M0"]', '["M1","M1"]']) {
    const fixture = `[{"scope":"MEMBER","kind":"SOFT_STYLE_PREFERENCE","content":"${CAT_PREFERENCE}","evidenceType":"REPEATED_BEHAVIOR","evidence":${evidence}}]`
    const harness = createHarness({ extractorResponses: [fixture, fixture, fixture], accumulator: new MemoryEvidenceAccumulator({ now: steppingClock() }) })
    await feed(harness.service, { text: CAT_PREFERENCE })
    assert.equal(harness.service.recordCount, 0, `forged evidence ${evidence} wrote memory`)
    assert.equal(harness.accumulator.size, 0, `forged evidence ${evidence} reached the pool`)
    assert.ok(
      harness.logs.some((line) => line.startsWith('[MEMORY_EVIDENCE]') && line.includes('reason=EVIDENCE_INVALID')),
      `forged evidence ${evidence} was not diagnosed as EVIDENCE_INVALID`,
    )
  }
}

/** G. The pool is in-memory only: a restarted service starts from zero. */
async function testAccumulatorNeverPersists(): Promise<void> {
  const harness = createHarness({ extractorResponses: [REPEATED_FIXTURE, REPEATED_FIXTURE] })
  await feed(harness.service, { text: CAT_PREFERENCE })
  assert.equal(harness.service.recordCount, 0)

  // A "restart": a brand-new service over the same store, with its own pool.
  const restartedLogs: string[] = []
  const restarted = new MemoryService({
    store: harness.store,
    extractor: new MemoryExtractor(async () => REPEATED_FIXTURE),
    mutate: async () => '{"operation":"NONE"}',
    now: steppingClock(),
    idFactory: sequentialIds(),
    log: (line) => restartedLogs.push(line),
    enableTimer: false,
  })
  await feed(restarted, { text: CAT_PREFERENCE })
  assert.equal(harness.store.liveRecordCount, 0,
    'the restarted service must NOT inherit the pre-restart pool (accepted design loss)')
  assert.ok(
    accumulatorLines(restartedLogs).some((line) => line.includes('result=WAITING') && line.includes('count=1')),
    'the restarted pool did not start from zero',
  )

  // Two fresh contributions after the restart reach the threshold and write —
  // which finally puts a record on disk, proving the pool left no trace.
  await feed(restarted, { text: CAT_PREFERENCE })
  assert.equal(harness.store.liveRecordCount, 1)
  if (existsSync(harness.filePath)) {
    const document = persistedDocument(harness.filePath)
    assert.equal(document.version, 1)
    const serialized = JSON.stringify(document)
    // record.scopeId is a legitimate durable schema field; the pool-only fields
    // are candidateKey / firstSeenAt / lastSeenAt and must never appear.
    for (const forbidden of ['candidateKey', 'firstSeenAt', 'lastSeenAt']) {
      assert.ok(!serialized.includes(forbidden), `the pool field ${forbidden} leaked into memory.json`)
    }
    const record = document.records[0]!
    assert.equal(record.evidenceCount, 2)
    assert.equal(record.evidenceType, 'REPEATED_BEHAVIOR')
  } else {
    assert.fail('the post-restart write did not produce memory.json')
  }
}

/** The accumulator diagnostics carry no content, ids or scope keys. */
async function testAccumulatorDiagnosticsPrivacy(): Promise<void> {
  const harness = createHarness({ extractorResponses: [REPEATED_FIXTURE, REPEATED_FIXTURE] })
  await feed(harness.service, { text: CAT_PREFERENCE })
  await feed(harness.service, { text: CAT_PREFERENCE })
  const lines = accumulatorLines(harness.logs)
  assert.ok(lines.length >= 2)
  for (const line of lines) {
    for (const forbidden of [CAT_PREFERENCE, REQUESTER, ROOM, 'sig-a', 'chatroom', '喜欢猫', 'requester-acc']) {
      assert.ok(!line.includes(forbidden), `the accumulator diagnostic leaked raw data (${forbidden}): ${line}`)
    }
  }
}

/** The pool threshold is the shared constant and stays at two for phase 1. */
function testThresholdContract(): void {
  assert.equal(REPEATED_EVIDENCE_ADMISSION_THRESHOLD, 2)
  assert.equal(REPEATED_EVIDENCE_TTL_MS, 7 * 24 * 60 * 60 * 1000)
}

// ---------------------------------------------------------------------- runner

async function main(): Promise<void> {
  const cases: Array<[string, () => void | Promise<void>]> = [
    ['normalize-evidence-key', testNormalizeEvidenceKey],
    ['accumulator-unit-rules', testAccumulatorUnitRules],
    ['accumulator-ttl-unit', testAccumulatorTtlUnit],
    ['accumulator-expiry-refresh', testAccumulatorExpiryRefresh],
    ['threshold-contract', testThresholdContract],
    ['first-waits-second-writes', testFirstWaitsSecondWrites],
    ['requester-isolation', testRequesterIsolation],
    ['scope-isolation', testScopeIsolation],
    ['ttl-expiry-integration', testTtlExpiryIntegration],
    ['forged-references-rejected', testForgedReferencesRejected],
    ['accumulator-never-persists', testAccumulatorNeverPersists],
    ['accumulator-diagnostics-privacy', testAccumulatorDiagnosticsPrivacy],
  ]
  let failures = 0
  try {
    for (const [name, run] of cases) {
      try {
        await run()
        console.log(`[MEMORY_EVIDENCE_ACCUMULATOR_CASE] name=${name} result=PASS`)
      } catch (error) {
        failures += 1
        console.error(`[MEMORY_EVIDENCE_ACCUMULATOR_CASE] name=${name} result=FAIL error=${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    cleanup()
  }
  console.log(`[MEMORY_EVIDENCE_ACCUMULATOR_TEST_SUMMARY] cases=${cases.length} failures=${failures}`)
  if (failures > 0) {
    process.exitCode = 1
  }
}

void main()
