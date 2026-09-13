/**
 * Self-identity retrieval and authorization-role grounding regressions.
 *
 * These cases use the production MemoryService retrieval seam and the production
 * prompt construction seam. Authorization is kept in the AgentRequest/MemoryService
 * contract, while the final-answer prompt receives only identity-safe speaker labels
 * and grounded memory facts.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSystemPrompt,
  buildUserPrompt,
  type ChatRequestContext,
} from './chat.js'
import type { GroupMessage } from './context.js'
import { toAgentRequest } from './agent-adapter.js'
import { isCurrentSelfIdentityQuery, evaluateMemoryRelevance } from './memory-relevance.js'
import { MemoryExtractor } from './memory-extractor.js'
import { MemoryService } from './memory-service.js'
import type { MemoryRecord, MemoryScopeType } from './memory-models.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'
import { normalizeRawHookMessage, type RawHookMessage } from './message-contract.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import { YEYE_REPLY_SIGNATURE } from './chat-renderer.js'
import { guardFinalAnswer } from './answer-guard.js'
import { isInternalSpeakerLabel } from './speaker-labels.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const ROOM = 'self-identity-role-room@chatroom'
const OWNER = 'owner-self-identity'
const MEMBER = 'member-self-identity'
const OTHER = 'wxid_other-self-identity'
const FACT = '辞老师'

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-agent-self-identity-role-'))
  temporaryDirectories.push(directory)
  return directory
}

function cleanup(): void {
  for (const directory of temporaryDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Test cleanup must never hide the assertion result.
    }
  }
}

function record(scopeType: MemoryScopeType, scopeId: string, content = `我叫${FACT}`): MemoryRecord {
  return {
    memoryId: `${scopeType.toLowerCase()}-identity`,
    scopeType,
    scopeId,
    content,
    contentHash: '',
    visibility: 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: ROOM,
    sourceSenderId: scopeId,
    createdAt: 1,
    updatedAt: 1,
    isDeleted: false,
  }
}

interface Harness {
  store: MemoryStore
  service: MemoryService
}

function createHarness(options: {
  scopeType?: MemoryScopeType
  scopeId?: string
  content?: string
  mutate?: (system: string, user: string) => Promise<string>
} = {}): Harness {
  const directory = tempDir()
  const store = new MemoryStore({
    filePath: memoryFileIn(directory),
    pathSource: 'TEST',
  })
  if (options.scopeType && options.scopeId) {
    assert(store.add(record(options.scopeType, options.scopeId, options.content)) === 'WRITTEN', 'fixture memory was not written')
  }
  return {
    store,
    service: new MemoryService({
      store,
      extractor: new MemoryExtractor(async () => '[]'),
      mutate: options.mutate ?? (async () => '{"operation":"NONE"}'),
      idFactory: () => `generated-${Date.now()}`,
    }),
  }
}

async function retrieve(harness: Harness, requesterId: string, requesterRole: 'OWNER' | 'MEMBER', question: string) {
  return harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId,
    requesterRole,
    question,
  })
}

function groupRaw(overrides: Partial<RawHookMessage> = {}): RawHookMessage {
  const signature = overrides.signature ?? OWNER
  return {
    msgId: `self-identity-${signature}`,
    type: 1,
    timestamp: 1_757_000_000_000,
    from: ROOM,
    wxid: 'shared-account-wxid',
    content: '我是谁',
    signature,
    senderName: 'transport-name',
    isMentioned: true,
    conversationType: 'GROUP',
    conversationId: ROOM,
    senderId: signature,
    requesterId: signature,
    requesterSource: 'Signature',
    requesterRole: 'MEMBER',
    ownerConfigured: true,
    ...overrides,
  }
}

function ownerRaw(overrides: Partial<RawHookMessage> = {}): RawHookMessage {
  return groupRaw({ requesterRole: 'OWNER', ownerConfigured: true, ...overrides })
}

function requestFrom(raw: RawHookMessage) {
  const normalized = normalizeRawHookMessage(raw)
  assert(normalized.status === 'VALID', `fixture message was not valid: ${normalized.status}`)
  return toAgentRequest(normalized.message)
}

class CapturingChatService {
  public readonly calls: Array<{
    context: GroupMessage[]
    question: GroupMessage
    request: ChatRequestContext
    prompt: string
  }> = []

  public async reply(
    context: GroupMessage[],
    question: GroupMessage,
    request: ChatRequestContext,
  ): Promise<string> {
    const prompt = buildUserPrompt(context, question, request)
    this.calls.push({ context, question, request, prompt })
    return request.memory?.[0]?.content ?? '我还不知道你希望我怎么称呼你。'
  }
}

async function testSelfIdentityQueryMatrix(): Promise<void> {
  const harness = createHarness({ scopeType: 'OWNER', scopeId: OWNER })
  const queries = [
    '我的代号是什么',
    '我叫什么',
    '怎么称呼我',
    '叫我什么',
    '我是谁',
    '我是谁？',
    '你知道我是谁吗',
    '我是谁呀',
    '我是谁呀？',
    '我是谁啊',
    '我是谁啊？',
    '我是谁呢',
    '我是谁呢？',
    '我是谁嘛',
    '我是谁嘛？',
    '我叫什么呀',
    '我叫什么啊',
    '我叫什么呢',
    '我的代号是什么呀',
    '我的代号是什么啊',
    '我的代号是什么呢',
    '怎么称呼我呀',
    '怎么称呼我啊',
    '怎么称呼我呢',
    '叫我什么呀',
    '叫我什么啊',
    '叫我什么呢',
  ]
  for (const question of queries) {
    assert(isCurrentSelfIdentityQuery(question), `detector missed positive self-identity query: ${question}`)
    const items = await retrieve(harness, OWNER, 'OWNER', question)
    assert(items.length === 1, `self-identity memory was not selected for: ${question}`)
    assert(items[0]?.content === `我叫${FACT}`, `wrong self-identity content for: ${question}`)
  }
}

async function testParticleNormalizationAfterRestart(): Promise<void> {
  const directory = tempDir()
  const filePath = memoryFileIn(directory)
  const firstStore = new MemoryStore({ filePath, pathSource: 'TEST' })
  assert(firstStore.add(record('OWNER', OWNER)) === 'WRITTEN', 'restart fixture memory was not written')

  // A new store/service pair models the runtime after Agent restart while keeping
  // the same durable memory file.
  const restartedStore = new MemoryStore({ filePath, pathSource: 'TEST' })
  const restartedService = new MemoryService({
    store: restartedStore,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => '{"operation":"NONE"}',
    idFactory: () => `generated-${Date.now()}`,
  })
  const queries = [
    '我是谁',
    '我是谁呀',
    '我是谁啊？',
    '我是谁呢',
    '我的代号是什么呀',
    '我叫什么啊',
    '怎么称呼我呢',
  ]

  for (const question of queries) {
    const items = await restartedService.retrieveForChat({
      conversationType: 'GROUP',
      conversationId: ROOM,
      requesterId: OWNER,
      requesterRole: 'OWNER',
      question,
    })
    assert(items.length >= 1, `restart self-identity recall missed: ${question}`)
    assert(items[0]?.content === `我叫${FACT}`, `restart recall returned wrong content: ${question}`)
  }
}

/**
 * A query that merely CONTAINS a self-reference is not a self-identity question.
 *
 * The verdict is the deterministic rule's, not retrieval's: under the
 * contextual working set an authorized record is provided for every question, so
 * "the record was not retrieved" is no longer a valid way to express "the
 * identity bridge did not fire". The bridge is asserted where it lives.
 */
async function testNegativeQueriesStayOrdinaryRetrieval(): Promise<void> {
  const harness = createHarness({ scopeType: 'OWNER', scopeId: OWNER })
  for (const question of [
    '我的项目是什么',
    '我的项目是什么呀',
    '我的服务器怎么了',
    '我的服务器怎么了呀',
    '我今天吃什么',
    '我今天吃什么呀',
    '我应该怎么部署呀',
    '我是谁负责的接口',
    '我是谁的负责人',
    '我是谁派来处理这个项目的',
    '我是谁说服务器挂了',
  ]) {
    assert(!isCurrentSelfIdentityQuery(question), `negative query triggered self-identity detector: ${question}`)
    const effective = evaluateMemoryRelevance(question, record('OWNER', OWNER), {
      requesterId: OWNER,
      personalScopeType: 'OWNER',
    })
    assert(effective.reason !== 'SELF_IDENTITY_ATTRIBUTE_BRIDGE', `negative query received identity boost: ${question}`)

    // The record IS provided — authorization, not relevance, decides that — and
    // it is still one item, so nothing about the working set changed the scope.
    const items = await retrieve(harness, OWNER, 'OWNER', question)
    assert(items.length === 1, `the authorized identity fact was not provided for: ${question}`)
    assert(items[0]?.content === `我叫${FACT}`, `the provided record lost its content for: ${question}`)
  }
}

async function testRequesterIsolation(): Promise<void> {
  const harness = createHarness({ scopeType: 'MEMBER', scopeId: OWNER })
  const items = await retrieve(harness, MEMBER, 'MEMBER', '我是谁？')
  assert(items.length === 0, 'requester B read requester A personal identity memory')
}

async function testOwnerMemoryWinsOverAuthorizationRole(): Promise<void> {
  const harness = createHarness({ scopeType: 'OWNER', scopeId: OWNER })
  const chat = new CapturingChatService()
  const agent = new ProductionChatAgent(chat as never, { memory: harness.service })
  const reply = await agent.complete(requestFrom(ownerRaw({
    content: '我是谁？',
    ownerDisplayName: '配置展示名',
    msgId: 'owner-grounded-identity',
  })))
  const call = chat.calls[0]
  assert(call !== undefined, 'owner identity query did not reach the answer service')
  assert(reply === `我叫${FACT}${YEYE_REPLY_SIGNATURE}`, 'owner identity answer was not based on personal memory')
  assert(!reply.includes('主人') && !reply.includes('群主') && !reply.includes('管理员'), 'owner role became a natural-language identity')
  assert(!call.prompt.includes('CurrentRequesterRole=OWNER'), 'raw authorization role reached the final-answer prompt')
  assert(call.prompt.includes('OWNER_CONFIGURED=true'), 'trusted owner configuration fact was not provided to the final-answer prompt')
  assert(call.prompt.includes('OWNER_DISPLAY_NAME=配置展示名'), 'trusted owner display name was not provided to the final-answer prompt')
  assert(call.question.senderName === 'SPEAKER_1', `owner did not receive a neutral speaker label: ${call.question.senderName}`)
  assert(call.prompt.includes('SELF_IDENTITY_QUERY=true'), 'identity grounding fact was not provided')
  assert(call.prompt.includes('RETRIEVED_MEMORY_COUNT=1'), 'retrieved memory count was not provided')
}

async function testOwnerWithoutMemoryIsUnknown(): Promise<void> {
  const harness = createHarness()
  const chat = new CapturingChatService()
  const agent = new ProductionChatAgent(chat as never)
  const reply = await agent.complete(requestFrom(ownerRaw({
    content: '我是谁？',
    ownerDisplayName: '配置展示名',
    msgId: 'owner-unknown-identity',
  })))
  const call = chat.calls[0]
  assert(call !== undefined, 'owner unknown identity query did not reach the answer service')
  assert(reply.includes('不知道'), `missing personal identity memory did not produce UNKNOWN: ${reply}`)
  assert(!reply.includes('主人') && !reply.includes('群主') && !reply.includes('管理员'), 'OWNER fallback leaked as a social identity')
  assert(call.prompt.includes('OWNER_CONFIGURED=true'), 'trusted owner configuration fact was not provided to the final-answer prompt')
  assert(call.prompt.includes('OWNER_DISPLAY_NAME=配置展示名'), 'trusted owner display name was not provided to the final-answer prompt')
  assert(call.prompt.includes('SELF_IDENTITY_QUERY=true'), 'unknown identity query was not marked')
  assert(call.prompt.includes('RETRIEVED_MEMORY_COUNT=0'), 'unknown identity prompt did not state memory absence')
}

async function testAuthorizationRoleStillControlsOwnerOnlyCapability(): Promise<void> {
  let calls = 0
  const harness = createHarness({
    mutate: async () => {
      calls += 1
      return '{"operation":"ADD","content":"我叫辞老师","scope":"OWNER"}'
    },
  })
  assert(harness.service.isExplicitMemoryIntent('OWNER', '记住我叫辞老师'), 'OWNER lost explicit-memory capability')
  assert(!harness.service.isExplicitMemoryIntent('MEMBER', '记住我叫辞老师'), 'MEMBER gained owner-only explicit-memory capability')

  const ownerResult = await harness.service.tryHandleExplicit({
    conversationType: 'GROUP', conversationId: ROOM, requesterId: OWNER, requesterRole: 'OWNER', question: '记住我叫辞老师',
    mentionState: 'MENTIONED', botMentionSpanTrust: 'VALID', botMentionSpanCount: 1, userContentSpanTrust: 'VALID',
  })
  assert(ownerResult.handled && ownerResult.reply === '记住了。', 'OWNER explicit memory capability stopped working')
  assert(calls === 1 && harness.store.liveRecordCount === 1, 'OWNER memory write did not persist')

  const memberResult = await harness.service.tryHandleExplicit({
    conversationType: 'GROUP', conversationId: ROOM, requesterId: MEMBER, requesterRole: 'MEMBER', question: '记住我叫辞老师',
    mentionState: 'MENTIONED', botMentionSpanTrust: 'VALID', botMentionSpanCount: 1, userContentSpanTrust: 'VALID',
  })
  assert(!memberResult.handled && calls === 1, 'MEMBER changed the owner-only memory path')
}

async function testNeutralSpeakerLabelStillHasAnswerGuardCoverage(): Promise<void> {
  assert(isInternalSpeakerLabel('SPEAKER_1'), 'neutral owner speaker label is not recognized as internal')
  const guarded = guardFinalAnswer('你是SPEAKER_1。', {
    currentSpeakerLabel: 'SPEAKER_1',
    speakerLabels: ['SPEAKER_1'],
  })
  assert(guarded.outcome === 'REWRITTEN', 'neutral internal speaker label was not guarded')
  assert(!guarded.text.includes('SPEAKER_1'), 'neutral speaker label survived the final-answer guard')
}

async function testUngroundedRoleIdentityGuardIsContextual(): Promise<void> {
  const blocked = guardFinalAnswer('你是我的主人，也是这个群的管理员。', {
    selfIdentityQuery: true,
    retrievedPersonalMemoryCount: 0,
  })
  assert(blocked.outcome === 'BLOCKED', 'an ungrounded social-role identity claim was accepted')
  assert(blocked.regenerable, 'an ungrounded role claim was not offered a safe regeneration path')
  assert(blocked.detections.some((entry) => entry.kind === 'UNGROUNDED_IDENTITY_CLAIM'), 'the contextual identity guard did not report its safe reason')

  const quoted = guardFinalAnswer('“主人”这个词通常表示一种称呼。', {
    selfIdentityQuery: false,
    retrievedPersonalMemoryCount: 0,
  })
  assert(quoted.outcome === 'CLEAN', 'the identity guard over-blocked an ordinary quoted-language answer')
}

async function testRawIdentityWriteRegressionRemainsFailClosed(): Promise<void> {
  let calls = 0
  const harness = createHarness({
    mutate: async () => {
      calls += 1
      return `{"operation":"ADD","content":"${OTHER} 的代号是${FACT}","scope":"OWNER"}`
    },
  })
  const result = await harness.service.tryHandleExplicit({
    conversationType: 'GROUP', conversationId: ROOM, requesterId: OWNER, requesterRole: 'OWNER', question: '记住我是谁',
    mentionState: 'MENTIONED', botMentionSpanTrust: 'VALID', botMentionSpanCount: 1, userContentSpanTrust: 'VALID',
  })
  assert(result.handled && calls === 1, 'raw identity regression fixture did not reach mutation')
  assert(harness.store.liveRecordCount === 0, 'raw identity candidate bypassed fail-closed validation')
  assert(!result.reply.includes('记住了'), 'raw identity rejection used success semantics')
}

const cases: Array<[string, () => Promise<void>]> = [
  ['self-identity-query-matrix', testSelfIdentityQueryMatrix],
  ['particle-normalization-after-restart', testParticleNormalizationAfterRestart],
  ['negative-queries-stay-ordinary-retrieval', testNegativeQueriesStayOrdinaryRetrieval],
  ['requester-isolation', testRequesterIsolation],
  ['owner-memory-wins-over-authorization-role', testOwnerMemoryWinsOverAuthorizationRole],
  ['owner-without-memory-is-unknown', testOwnerWithoutMemoryIsUnknown],
  ['owner-only-capability-preserved', testAuthorizationRoleStillControlsOwnerOnlyCapability],
  ['neutral-label-answer-guard', testNeutralSpeakerLabelStillHasAnswerGuardCoverage],
  ['ungrounded-role-identity-guard-is-contextual', testUngroundedRoleIdentityGuardIsContextual],
  ['raw-identity-write-regression-remains-fail-closed', testRawIdentityWriteRegressionRemainsFailClosed],
]

let failures = 0
for (const [name, run] of cases) {
  try {
    await run()
    console.log(`[SELF_IDENTITY_ROLE_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(`[SELF_IDENTITY_ROLE_CASE] name=${name} result=FAIL message=${error instanceof Error ? error.message : String(error)}`)
  }
}

cleanup()
console.log(`[SELF_IDENTITY_ROLE_TEST_SUMMARY] cases=${cases.length} failures=${failures}`)
if (failures > 0) {
  process.exitCode = 1
}
