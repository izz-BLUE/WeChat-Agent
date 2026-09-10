/**
 * Regression coverage for the real explicit/automatic memory write path.
 *
 * The provider is scripted, but the cases exercise the same
 * MemoryService -> validation -> MemoryStore path used by production. Raw
 * requester identities are intentionally placed in structured provider output
 * to prove that only the current requester's narrow self form is normalized.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryExtractor } from './memory-extractor.js'
import { MemoryService } from './memory-service.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'
import type { MemoryRecord } from './memory-models.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const ROOM = 'memory-regression-room@chatroom'
const OWNER = 'wxid_memory_regression_owner'
const MEMBER = 'wxid_memory_regression_member'
const OTHER = 'wxid_memory_regression_other'
const FACT = '辞老师'

const temporaryDirectories: string[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-memory-regression-'))
  temporaryDirectories.push(directory)
  return directory
}

function sequentialIds(): () => string {
  let counter = 0
  return () => `regression-${++counter}`
}

interface Harness {
  directory: string
  filePath: string
  store: MemoryStore
  service: MemoryService
  logs: string[]
  mutationPrompts: string[]
  setMutation(response: string): void
  setExtraction(response: string): void
}

function createHarness(): Harness {
  const directory = tempDirectory()
  const filePath = memoryFileIn(directory)
  const logs: string[] = []
  const mutationPrompts: string[] = []
  let mutationResponse = '{"operation":"NONE"}'
  let extractionResponse = '[]'

  const store = new MemoryStore({
    filePath,
    log: (line) => logs.push(line),
    pathSource: 'TEST',
  })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => extractionResponse),
    mutate: async (_system, user) => {
      mutationPrompts.push(user)
      return mutationResponse
    },
    now: () => 1_757_000_000_000,
    idFactory: sequentialIds(),
    log: (line) => logs.push(line),
  })

  return {
    directory,
    filePath,
    store,
    service,
    logs,
    mutationPrompts,
    setMutation: (response) => { mutationResponse = response },
    setExtraction: (response) => { extractionResponse = response },
  }
}

function addMutation(content: string, target: string | null = null): string {
  return JSON.stringify({ operation: 'ADD', target, content, scope: 'OWNER' })
}

function deleteMutation(target = 'M1'): string {
  return JSON.stringify({ operation: 'DELETE', target, content: null, scope: 'OWNER' })
}

async function explicit(
  harness: Harness,
  requesterId: string,
  question: string,
  requesterRole: 'OWNER' | 'MEMBER' = 'OWNER',
): Promise<{ reply: string; handled: boolean }> {
  const result = await harness.service.tryHandleExplicit({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId,
    requesterRole,
    question,
    // The runtime facts a real GROUP request carries: a persistent memory side
    // effect requires a trusted bot mention token (see `bot-mention-span.test.ts`).
    mentionState: 'MENTIONED',
    botMentionSpanTrust: 'VALID',
    botMentionSpanCount: 1,
  })
  return result
}

function personalRecords(harness: Harness, scopeType: 'OWNER' | 'MEMBER', scopeId: string): MemoryRecord[] {
  return harness.store.retrieve([{ scopeType, scopeId, visibility: 'SHARED' }], 10)
}

async function automaticMemberRemember(harness: Harness, requesterId: string): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    harness.service.observeHumanMessage({
      messageId: `regression-member-${index}`,
      conversationType: 'GROUP',
      conversationId: ROOM,
      requesterId,
      requesterRole: 'MEMBER',
      speakerLabel: 'MEMBER_1',
      text: `我叫${FACT}`,
      timestamp: 1_757_000_000_000 + index,
      chatTriggered: true,
    })
  }
  await harness.service.flushAll()
}

/** Case 1. OWNER personal content is canonicalized and raw-free. */
async function testOwnerRememberWritesSafeContent(): Promise<void> {
  const harness = createHarness()
  harness.setMutation(addMutation(`${OWNER} 的代号是${FACT}`))

  const result = await explicit(harness, OWNER, `记住我叫${FACT}`)
  assert(result.handled && result.reply === '记住了。', `OWNER remember failed: ${JSON.stringify(result)}`)

  assert(!harness.mutationPrompts[0]?.includes(OWNER), 'explicit mutation prompt exposed the raw requester identity')
  const duplicate = await explicit(harness, OWNER, '记住我叫' + FACT)
  assert(duplicate.reply === '已经记得了。', 'duplicate memory did not use duplicate-safe reply semantics')

  const records = personalRecords(harness, 'OWNER', OWNER)
  assert(records.length === 1, `OWNER wrote ${records.length} records`)
  assert(records[0]?.content === `我叫${FACT}`, `OWNER canonical content is ${records[0]?.content}`)
  assert(!records[0]!.content.includes(OWNER), 'OWNER raw identity reached persisted content')

  const stored = JSON.parse(readFileSync(harness.filePath, 'utf8')) as { records: MemoryRecord[] }
  assert(stored.records.every((record) => !record.content.includes(OWNER)), 'OWNER raw identity reached the JSON store')
}

/** Case 6. A current raw identity outside the narrow self form still fails closed. */
async function testCurrentRequesterRawIdentityCannotRemain(): Promise<void> {
  const harness = createHarness()
  harness.setMutation(addMutation('这是' + OWNER))
  const result = await explicit(harness, OWNER, '记住我叫' + FACT)
  assert(result.reply === '这条记忆没有保存成功。', 'unexpected current-identity rejection reply: ' + result.reply)
  assert(harness.service.recordCount === 0, 'current raw identity was persisted outside the self form')
  assert(harness.logs.some((line) => line.includes('reason=RAW_IDENTITY_IN_CONTENT')), 'current raw identity was not rejected')
}

/** Case 2. MEMBER automatic extraction uses the same safe personal boundary. */
async function testMemberRememberWritesSafeContent(): Promise<void> {
  const harness = createHarness()
  harness.setExtraction(`[{'scope':'MEMBER','content':'${MEMBER} 的名字是${FACT}'}]`.replaceAll("'", '"'))

  await automaticMemberRemember(harness, MEMBER)

  const records = personalRecords(harness, 'MEMBER', MEMBER)
  assert(records.length === 1, `MEMBER wrote ${records.length} records`)
  assert(records[0]?.content === `我叫${FACT}`, `MEMBER canonical content is ${records[0]?.content}`)
  assert(!records[0]!.content.includes(MEMBER), 'MEMBER raw identity reached persisted content')

  const retrieved = await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: MEMBER,
    requesterRole: 'MEMBER',
    question: '我叫什么',
  })
  assert(retrieved.length === 1 && retrieved[0]?.content === `我叫${FACT}`, 'MEMBER self fact was not readable')
}

/** Cases 3 and 4. Forget removes the fact, then both remember phrasings work. */
async function testReRememberAfterForget(question: string, content: string, label: string): Promise<void> {
  const harness = createHarness()
  harness.setMutation(addMutation(`我的代号是${FACT}`))
  const first = await explicit(harness, OWNER, `记住我的代号是${FACT}`)
  assert(first.reply === '记住了。', `${label}: initial write failed`)

  harness.setMutation(deleteMutation())
  const forgotten = await explicit(harness, OWNER, `忘记我的代号是${FACT}`)
  assert(forgotten.reply === '忘掉了。', `${label}: forget failed: ${forgotten.reply}`)
  const afterForget = await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: OWNER,
    requesterRole: 'OWNER',
    question: '我的代号是什么',
  })
  assert(afterForget.length === 0, `${label}: forgotten fact remained readable`)

  harness.setMutation(addMutation(content))
  const remembered = await explicit(harness, OWNER, question)
  assert(remembered.reply === '记住了。', `${label}: re-remember failed: ${JSON.stringify(remembered)}`)
  const records = personalRecords(harness, 'OWNER', OWNER)
  assert(records.length === 1, `${label}: expected one live record, got ${records.length}`)
  assert(records[0]?.content === `我叫${FACT}`, `${label}: unsafe or incompatible content ${records[0]?.content}`)
  const reread = await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: OWNER,
    requesterRole: 'OWNER',
    question: '我的代号是什么',
  })
  assert(reread.length === 1, `${label}: re-remembered fact was not readable`)
}

/** Case 5. The safe re-remembered record survives a fresh MemoryStore. */
async function testRestartKeepsReRememberedFact(): Promise<void> {
  const harness = createHarness()
  harness.setMutation(addMutation(`${OWNER} 是${FACT}`))
  const written = await explicit(harness, OWNER, `记住我是${FACT}`)
  assert(written.reply === '记住了。', `restart setup write failed: ${written.reply}`)
  harness.service.close()

  const restartedStore = new MemoryStore({ filePath: harness.filePath, log: (line) => harness.logs.push(line), pathSource: 'TEST_RESTART' })
  const restarted = new MemoryService({
    store: restartedStore,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => '{"operation":"NONE"}',
    now: () => 1_757_000_000_001,
    idFactory: sequentialIds(),
    log: (line) => harness.logs.push(line),
  })
  const retrieved = await restarted.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: OWNER,
    requesterRole: 'OWNER',
    question: '我叫什么',
  })
  assert(retrieved.length === 1 && retrieved[0]?.content === `我叫${FACT}`, 'restarted store lost the fact')
  const persisted = JSON.parse(readFileSync(harness.filePath, 'utf8')) as { records: MemoryRecord[] }
  assert(persisted.records.every((record) => !record.content.includes(OWNER)), 'restart store content includes the raw identity')
  restarted.close()
}

/** Case 7. A different/unknown raw identity is still rejected. */
async function testOtherRawIdentityFailsClosed(): Promise<void> {
  const harness = createHarness()
  harness.setMutation(addMutation(`${OTHER} 的代号是${FACT}`))
  const result = await explicit(harness, OWNER, `记住我叫${FACT}`)
  assert(result.reply === '这条记忆没有保存成功。', `unexpected fail-closed reply: ${result.reply}`)
  assert(harness.service.recordCount === 0, 'other raw identity was persisted')
  assert(harness.logs.some((line) => line.includes('reason=RAW_IDENTITY_IN_CONTENT')), 'raw identity guard did not reject unknown identity')
}

/** Case 8. A real store FAILED status must drive a failure reply. */
async function testFailedPersistenceDoesNotLookSuccessful(): Promise<void> {
  const harness = createHarness()
  harness.setMutation(addMutation(`我叫${FACT}`))
  rmSync(harness.filePath, { force: true })
  mkdirSync(harness.filePath)

  const result = await explicit(harness, OWNER, `记住我叫${FACT}`)
  assert(result.reply === '这条记忆没有保存成功。', `FAILED persistence returned ${result.reply}`)
  assert(harness.logs.some((line) => line.includes('[MEMORY_WRITE]') && line.includes('result=FAILED')), 'FAILED write was not reported')
}

/** Case 9. The existing three self-identity questions remain readable. */
async function testSelfIdentityRetrievalQuestions(): Promise<void> {
  const harness = createHarness()
  harness.setMutation(addMutation(`${OWNER} 的名字是${FACT}`))
  const result = await explicit(harness, OWNER, `记住我叫${FACT}`)
  assert(result.reply === '记住了。', 'self-identity retrieval setup failed')

  for (const question of ['我的代号是什么', '我叫什么', '怎么称呼我']) {
    const retrieved = await harness.service.retrieveForChat({
      conversationType: 'GROUP',
      conversationId: ROOM,
      requesterId: OWNER,
      requesterRole: 'OWNER',
      question,
    })
    assert(retrieved.length === 1, `self-identity query did not retrieve: ${question}`)
  }
}

/** Case 10. Personal memory remains requester-isolated. */
async function testRequesterIsolation(): Promise<void> {
  const harness = createHarness()
  harness.setMutation(addMutation(`${OWNER} 是${FACT}`))
  const result = await explicit(harness, OWNER, `记住我叫${FACT}`)
  assert(result.reply === '记住了。', 'isolation setup failed')

  const other = await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: MEMBER,
    requesterRole: 'MEMBER',
    question: '我叫什么',
  })
  assert(other.length === 0, 'requester B read requester A personal memory')
}

async function main(): Promise<void> {
  let failures = 0
  const cases: Array<[string, () => Promise<void>]> = [
    ['owner-safe-write', testOwnerRememberWritesSafeContent],
    ['current-identity-never-persists', testCurrentRequesterRawIdentityCannotRemain],
    ['member-safe-write', testMemberRememberWritesSafeContent],
    ['re-remember-after-forget-is', () => testReRememberAfterForget(`记住我是${FACT}`, `${OWNER} 的代号是${FACT}`, 'is')],
    ['re-remember-after-forget-叫', () => testReRememberAfterForget(`记住我叫${FACT}`, `${OWNER} 的名字是${FACT}`, '叫')],
    ['restart-safe-write', testRestartKeepsReRememberedFact],
    ['unknown-identity-fail-closed', testOtherRawIdentityFailsClosed],
    ['failed-persistence-reply', testFailedPersistenceDoesNotLookSuccessful],
    ['self-identity-retrieval', testSelfIdentityRetrievalQuestions],
    ['requester-isolation', testRequesterIsolation],
  ]

  for (const [name, run] of cases) {
    try {
      await run()
      console.log(`[MEMORY_REMEMBER_CASE] name=${name} result=PASS`)
    } catch (error) {
      failures += 1
      console.error(`[MEMORY_REMEMBER_CASE] name=${name} result=FAIL error=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  for (const directory of temporaryDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Test cleanup must never hide the case result.
    }
  }

  console.log(`[MEMORY_REMEMBER_SUMMARY] cases=${cases.length} failures=${failures}`)
  if (failures > 0) {
    process.exitCode = 1
  }
}

void main()
