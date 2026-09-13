/**
 * Deterministic requester-local ADDRESS_PREFERENCE fast-path regression tests.
 *
 * These cases exercise parser, safety, MemoryService, MemoryStore, production
 * ingress ordering, restart retrieval and the existing presentation boundary.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatService, buildUserPrompt } from './chat.js'
import { MENTION_SEPARATOR } from './canonical-user-text.js'
import { deriveMemberInteractionProfile } from './member-interaction-profile.js'
import { MemoryExtractor } from './memory-extractor.js'
import { MemoryService } from './memory-service.js'
import { MemoryStore } from './memory-store.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import { YEYE_REPLY_SIGNATURE } from './chat-renderer.js'
import {
  parseSelfAddressPreference,
  SELF_ADDRESS_PREFERENCE_REJECT_REPLY,
} from './self-address-preference.js'
import type { ExplicitMemoryRequest } from './memory-service.js'
import type { AgentRequest } from './agent-adapter.js'

function check(condition: unknown, message: string): asserts condition {
  assert.equal(Boolean(condition), true, message)
}

const ROOM = 'self-address-preference@chatroom'
const MEMBER_A = 'requester-a'
const MEMBER_B = 'requester-b'

const TRUSTED_FRAMING = {
  mentionState: 'MENTIONED' as const,
  botMentionSpanTrust: 'VALID' as const,
  botMentionSpanCount: 1,
  userContentSpanTrust: 'VALID' as const,
}

interface Harness {
  directory: string
  filePath: string
  service: MemoryService
  store: MemoryStore
  mutateCalls: number
  extractorCalls: number
  dispose(): void
}

function createHarness(): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-self-address-'))
  const filePath = join(directory, 'memory.json')
  let mutateCalls = 0
  let extractorCalls = 0
  let now = 1_700_000_000_000
  const store = new MemoryStore({ filePath, log: () => undefined, pathSource: 'TEST' })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => {
      extractorCalls += 1
      return '[]'
    }),
    mutate: async () => {
      mutateCalls += 1
      return '{"operation":"NONE"}'
    },
    now: () => {
      now += 1_000
      return now
    },
    idFactory: (() => {
      let id = 0
      return () => `self-address-${++id}`
    })(),
    log: () => undefined,
    enableTimer: false,
  })
  return {
    directory,
    filePath,
    service,
    store,
    get mutateCalls() { return mutateCalls },
    get extractorCalls() { return extractorCalls },
    dispose: () => {
      service.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

function request(
  requesterId: string,
  requesterRole: 'OWNER' | 'MEMBER',
  question: string,
  overrides: Partial<ExplicitMemoryRequest> = {},
): ExplicitMemoryRequest {
  return {
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId,
    requesterRole,
    question,
    ...TRUSTED_FRAMING,
    ...overrides,
  }
}

function readPersonal(store: MemoryStore, scopeType: 'OWNER' | 'MEMBER' | 'GROUP', scopeId: string) {
  return store.retrieve([{ scopeType, scopeId, visibility: 'SHARED' }], 20)
}

async function testParserAndSafetyBoundary(): Promise<void> {
  const accepted: Array<[string, string]> = [
    ['以后叫我公主', '公主'],
    ['以后喊我饭团', '饭团'],
    ['以后称呼我狗蛋。', '狗蛋'],
    ['你可以叫我老王', '老王'],
    ['你叫我宝宝就行', '宝宝'],
    ['叫我女王就行', '女王'],
  ]
  for (const [text, nickname] of accepted) {
    assert.deepEqual(parseSelfAddressPreference(text), { outcome: 'MATCH', nickname })
  }

  for (const text of [
    '他叫公主',
    '你觉得公主这个称呼怎么样',
    '公主这个角色怎么样',
    '以后叫张三公主',
    '张三让我叫他公主',
    '大家都叫我公主',
    '把这个群叫公主',
    '以后你叫公主',
  ]) {
    assert.deepEqual(parseSelfAddressPreference(text), { outcome: 'MISS' }, text)
  }

  for (const text of [
    '以后叫我',
    '叫我！！！',
    '以后叫我公主\n同学',
    '以后叫我https://example.com',
    '以后叫我@小王',
    `以后叫我${'一'.repeat(17)}`,
    '以后叫我！！！',
  ]) {
    const parsed = parseSelfAddressPreference(text)
    check(parsed.outcome === 'REJECT', `malformed address phrase was not rejected: ${text}`)
  }

  for (const nickname of ['老婆', '老公', '宝宝', '主人', '女王', '公主', '饭团', '老王']) {
    assert.deepEqual(parseSelfAddressPreference(`以后叫我${nickname}`), { outcome: 'MATCH', nickname })
  }
  for (const text of ['以后叫我鸡巴', '以后叫我性交', '以后叫我色情服务']) {
    const parsed = parseSelfAddressPreference(text)
    assert.deepEqual(parsed, { outcome: 'REJECT', reason: 'EXPLICIT_SEXUAL_CONTENT' })
  }
}

async function testMemberAndOwnerWriteWithoutLLM(): Promise<void> {
  for (const [role, scopeType] of [['MEMBER', 'MEMBER'], ['OWNER', 'OWNER']] as const) {
    const harness = createHarness()
    try {
      const result = harness.service.tryHandleSelfAddressPreference(
        request(role === 'MEMBER' ? MEMBER_A : 'owner-requester', role, '以后叫我公主'),
      )
      assert.deepEqual(result, { handled: true, reply: '好，以后叫你公主。' })
      const scopeId = role === 'MEMBER' ? MEMBER_A : 'owner-requester'
      const records = readPersonal(harness.store, scopeType, scopeId)
      check(records.length === 1, `${role} did not write exactly one personal record`)
      check(records[0]?.content === '公主', `${role} stored the whole sentence instead of nickname`)
      check(records[0]?.kind === 'ADDRESS_PREFERENCE', `${role} kind is not ADDRESS_PREFERENCE`)
      check(records[0]?.subject === 'CURRENT_REQUESTER', `${role} subject is not CURRENT_REQUESTER`)
      check(records[0]?.origin === 'EXPLICIT_SELF_ADDRESS', `${role} origin is not fast-path explicit`)
      check(harness.mutateCalls === 0, `${role} fast path invoked mutation LLM`)
      check(harness.extractorCalls === 0, `${role} fast path invoked automatic extractor`)
    } finally {
      harness.dispose()
    }
  }
}

async function testUpsertIsolationAndRetrieval(): Promise<void> {
  const harness = createHarness()
  try {
    const firstA = harness.service.tryHandleSelfAddressPreference(request(MEMBER_A, 'MEMBER', '以后叫我公主'))
    const firstB = harness.service.tryHandleSelfAddressPreference(request(MEMBER_B, 'MEMBER', '以后叫我老板'))
    const secondA = harness.service.tryHandleSelfAddressPreference(request(MEMBER_A, 'MEMBER', '以后叫我女王'))
    assert.equal(firstA.reply, '好，以后叫你公主。')
    assert.equal(firstB.reply, '好，以后叫你老板。')
    assert.equal(secondA.reply, '好，以后叫你女王。')

    const recordsA = readPersonal(harness.store, 'MEMBER', MEMBER_A)
    const recordsB = readPersonal(harness.store, 'MEMBER', MEMBER_B)
    check(recordsA.length === 1 && recordsA[0]?.content === '女王', 'A address preference was not upserted')
    check(recordsB.length === 1 && recordsB[0]?.content === '老板', 'B address preference changed or was lost')
    check(readPersonal(harness.store, 'GROUP', ROOM).length === 0, 'address preference escalated to GROUP')

    const retrievedA = await harness.service.retrieveForChat({
      conversationType: 'GROUP',
      conversationId: ROOM,
      requesterId: MEMBER_A,
      requesterRole: 'MEMBER',
      question: '我是谁',
    })
    const retrievedB = await harness.service.retrieveForChat({
      conversationType: 'GROUP',
      conversationId: ROOM,
      requesterId: MEMBER_B,
      requesterRole: 'MEMBER',
      question: '我是谁',
    })
    check(retrievedA.length === 1 && retrievedA[0]?.content === '女王', 'A could not retrieve its address preference')
    check(retrievedB.length === 1 && retrievedB[0]?.content === '老板', 'B could not retrieve its address preference')
    check(harness.store.recordCount === 2, 'requester-local upsert did not leave one live value per requester')

    const profile = deriveMemberInteractionProfile({
      authorizedPersonalMemory: retrievedA,
      recentRequesterActiveContext: [],
    })
    assert.equal(profile.addressFrequency, 'NORMAL')
    const prompt = buildUserPrompt([], {
      senderId: 'sender-a',
      senderName: 'MEMBER_1',
      text: '我是谁',
      timestamp: 1,
    }, {
      botDisplayName: '椰椰',
      mention: 'MENTIONED',
      requesterRole: 'MEMBER',
      ownerConfigured: false,
      memory: retrievedA,
    })
    check(prompt.includes('当前请求者的称呼偏好：女王'), 'final prompt did not label the bare address preference')
    check(!prompt.includes('老板'), 'B address preference leaked into A final prompt')
  } finally {
    harness.dispose()
  }
}

async function testRejectsAndPreservesOtherMemoryBoundaries(): Promise<void> {
  const harness = createHarness()
  try {
    for (const text of [
      '以后叫张三公主',
      '把 B 的称呼改成公主',
      '以后这个群叫公主',
      '以后你叫公主',
    ]) {
      const result = harness.service.tryHandleSelfAddressPreference(request(MEMBER_A, 'MEMBER', text))
      assert.deepEqual(result, { handled: false, reply: '' }, text)
    }

    const noMention = harness.service.tryHandleSelfAddressPreference(request(
      MEMBER_A,
      'MEMBER',
      '以后叫我公主',
      {
        mentionState: 'NOT_MENTIONED',
        botMentionSpanTrust: 'VALID',
        botMentionSpanCount: 0,
      },
    ))
    assert.deepEqual(noMention, { handled: false, reply: '' })
    const direct = harness.service.tryHandleSelfAddressPreference({
      ...request(MEMBER_A, 'MEMBER', '以后叫我公主'),
      conversationType: 'DIRECT',
    })
    assert.deepEqual(direct, { handled: false, reply: '' })

    const unsafe = harness.service.tryHandleSelfAddressPreference(request(MEMBER_A, 'MEMBER', '以后叫我鸡巴'))
    assert.deepEqual(unsafe, { handled: true, reply: SELF_ADDRESS_PREFERENCE_REJECT_REPLY })
    const malformed = harness.service.tryHandleSelfAddressPreference(request(MEMBER_A, 'MEMBER', '以后叫我'))
    assert.deepEqual(malformed, { handled: true, reply: SELF_ADDRESS_PREFERENCE_REJECT_REPLY })
    check(harness.store.recordCount === 0, 'rejected address input wrote a memory')

    const ownerOnly = await harness.service.tryHandleExplicit(request(
      MEMBER_A,
      'MEMBER',
      '记住我叫公主',
    ))
    assert.deepEqual(ownerOnly, { handled: false, reply: '' })
    check(harness.mutateCalls === 0, 'member explicit memory still reached the owner-only mutation provider')

    const address = harness.service.tryHandleSelfAddressPreference(request(MEMBER_A, 'MEMBER', '以后叫我主人'))
    assert.deepEqual(address, { handled: true, reply: '好，以后叫你主人。' })
    const record = readPersonal(harness.store, 'MEMBER', MEMBER_A)[0]
    check(record?.kind === 'ADDRESS_PREFERENCE' && record.subject === 'CURRENT_REQUESTER', '主人 changed Assistant identity semantics')
    check(readPersonal(harness.store, 'GROUP', ROOM).length === 0, 'self address path wrote GROUP memory')
  } finally {
    harness.dispose()
  }
}

async function testPersistenceFailureIsTruthful(): Promise<void> {
  const harness = createHarness()
  try {
    rmSync(harness.filePath, { force: true })
    mkdirSync(harness.filePath)
    const result = harness.service.tryHandleSelfAddressPreference(request(MEMBER_A, 'MEMBER', '以后叫我公主'))
    assert.deepEqual(result, { handled: true, reply: '这条记忆没有保存成功。' })
    check(harness.store.recordCount === 0, 'failed persistence left a live in-memory preference')
  } finally {
    harness.dispose()
  }
}

async function testRestartAndProductionFastPath(): Promise<void> {
  const harness = createHarness()
  try {
    const written = harness.service.tryHandleSelfAddressPreference(request(MEMBER_A, 'MEMBER', '以后叫我饭团'))
    assert.equal(written.reply, '好，以后叫你饭团。')
    harness.service.close()

    const restartedStore = new MemoryStore({ filePath: harness.filePath, log: () => undefined, pathSource: 'TEST_RESTART' })
    const restarted = new MemoryService({
      store: restartedStore,
      extractor: new MemoryExtractor(async () => '[]'),
      mutate: async () => '{"operation":"NONE"}',
      log: () => undefined,
      enableTimer: false,
    })
    const retrieved = await restarted.retrieveForChat({
      conversationType: 'GROUP',
      conversationId: ROOM,
      requesterId: MEMBER_A,
      requesterRole: 'MEMBER',
      question: '怎么称呼我',
    })
    check(retrieved.length === 1 && retrieved[0]?.content === '饭团', 'restart retrieval lost address preference')
    const persisted = JSON.parse(readFileSync(harness.filePath, 'utf8')) as { records: Array<{ scopeType: string; scopeId: string; content: string }> }
    check(persisted.records.some((record) => record.scopeType === 'MEMBER' && record.scopeId === MEMBER_A && record.content === '饭团'), 'address preference was not persisted in MEMBER scope')
    restarted.close()

    const productionHarness = createHarness()
    try {
      const agent = new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'test-key', 'test-model'), {
        memory: productionHarness.service,
      })
      const rawText = `@椰椰${MENTION_SEPARATOR}以后叫我公主`
      const botMentionLength = `@椰椰${MENTION_SEPARATOR}`.length
      const result = await agent.complete({
        conversationKey: ROOM,
        messageId: 'production-self-address-1',
        conversationType: 'GROUP',
        conversationId: ROOM,
        senderId: 'sender-a',
        requesterId: MEMBER_A,
        requesterSource: 'WIRE_REQUESTER',
        requesterRole: 'MEMBER',
        ownerConfigured: false,
        ownerDisplayName: null,
        publicDisplayName: '测试成员',
        senderName: '测试成员',
        text: '以后叫我公主',
        rawText,
        timestamp: 1,
        mentionState: 'MENTIONED',
        botMentionSpans: {
          trust: 'VALID',
          spans: [{ start: 0, length: botMentionLength }],
        },
        userContentSpan: {
          trust: 'VALID',
          span: { start: 0, length: rawText.length },
        },
        metadata: { rawMessageType: 1 },
      } satisfies AgentRequest)
      assert.equal(result, `好，以后叫你公主。${YEYE_REPLY_SIGNATURE}`)
      check(productionHarness.mutateCalls === 0, 'production fast path invoked the explicit mutation LLM')
      check(productionHarness.extractorCalls === 0, 'production fast path invoked the automatic extractor')
      check(readPersonal(productionHarness.store, 'MEMBER', MEMBER_A).length === 1, 'production fast path did not persist')
    } finally {
      productionHarness.dispose()
    }
  } finally {
    harness.dispose()
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ['parser-and-safety-boundary', testParserAndSafetyBoundary],
    ['member-and-owner-write-without-llm', testMemberAndOwnerWriteWithoutLLM],
    ['upsert-isolation-and-retrieval', testUpsertIsolationAndRetrieval],
    ['other-memory-boundaries', testRejectsAndPreservesOtherMemoryBoundaries],
    ['persistence-failure-truthfulness', testPersistenceFailureIsTruthful],
    ['restart-and-production-fast-path', testRestartAndProductionFastPath],
  ]
  let failures = 0
  for (const [name, run] of cases) {
    try {
      await run()
      console.log(`[SELF_ADDRESS_PREFERENCE_CASE] name=${name} result=PASS`)
    } catch (error) {
      failures += 1
      console.error(`[SELF_ADDRESS_PREFERENCE_CASE] name=${name} result=FAIL error=${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`[SELF_ADDRESS_PREFERENCE_TEST_SUMMARY] cases=${cases.length} failures=${failures}`)
  if (failures > 0) process.exitCode = 1
}

void main()
