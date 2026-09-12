/**
 * Requester-local preference boundary tests.
 *
 * These cases exercise the real automatic extractor/write/read path. A
 * CURRENT_REQUESTER preference is personal even when an extractor returns the
 * wrong GROUP scope; a legitimate subject=GROUP memory remains shared.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystemPrompt, ChatService, type ChatRequestContext } from './chat.js'
import { MemoryExtractor } from './memory-extractor.js'
import { MemoryService } from './memory-service.js'
import { MemoryStore } from './memory-store.js'
import type { MemoryKind, MemorySubject } from './assistant-identity.js'
import type { MemoryOrigin, MemoryRecord, MemoryScopeType } from './memory-models.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const roomId = 'room-preference@chatroom'
const localPreferenceKinds: readonly MemoryKind[] = [
  'ADDRESS_PREFERENCE',
  'CONTENT_PREFERENCE',
  'SOFT_STYLE_PREFERENCE',
]

interface Harness {
  service: MemoryService
  store: MemoryStore
  extractorPrompts: string[]
  dispose(): void
}

function createHarness(extractorResponse: string): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-requester-preference-'))
  const extractorPrompts: string[] = []
  let id = 0
  const store = new MemoryStore({
    filePath: join(directory, 'memory.json'),
    log: () => undefined,
    pathSource: 'TEST',
  })
  const extractor = new MemoryExtractor(async (system) => {
    extractorPrompts.push(system)
    return extractorResponse
  })
  const service = new MemoryService({
    store,
    extractor,
    mutate: async () => '{"operation":"NONE"}',
    now: (() => {
      let now = 1_700_000_000_000
      return () => {
        now += 1_000
        return now
      }
    })(),
    idFactory: () => `preference-${++id}`,
    log: () => undefined,
    enableTimer: false,
  })
  return {
    service,
    store,
    extractorPrompts,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  }
}

async function feedThree(
  service: MemoryService,
  requesterId: string,
  requesterRole: 'OWNER' | 'MEMBER',
): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    service.observeHumanMessage({
      messageId: `${requesterId}-message-${index}`,
      conversationType: 'GROUP',
      conversationId: roomId,
      requesterId,
      requesterRole,
      speakerLabel: requesterRole === 'OWNER' ? 'OWNER' : 'MEMBER_1',
      text: `记住我的回答偏好 ${index}`,
      timestamp: 1_757_000_000_000 + index,
      chatTriggered: true,
    })
  }
  await service.flushAll()
}

function read(
  service: MemoryService,
  requesterId: string,
  requesterRole: 'OWNER' | 'MEMBER',
  question = '回答偏好和群规则',
) {
  return service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: roomId,
    requesterId,
    requesterRole,
    question,
  })
}

function record(
  memoryId: string,
  scopeType: MemoryScopeType,
  scopeId: string,
  content: string,
  kind: MemoryKind,
  subject: MemorySubject,
  origin: MemoryOrigin = scopeType === 'GROUP' ? 'EXPLICIT_OWNER' : 'AUTOMATIC',
): MemoryRecord {
  return {
    memoryId,
    scopeType,
    scopeId,
    content,
    contentHash: '',
    visibility: 'SHARED',
    origin,
    sourceConversationType: 'GROUP',
    sourceConversationId: roomId,
    sourceSenderId: 'sig-a',
    createdAt: 1,
    updatedAt: 1,
    isDeleted: false,
    kind,
    subject,
  }
}

async function testAutomaticPreferencesNormalizeToRequesterScope(): Promise<void> {
  const extractorResponse = JSON.stringify(localPreferenceKinds.map((kind) => ({
    scope: 'GROUP',
    subject: 'CURRENT_REQUESTER',
    kind,
    content: kind === 'ADDRESS_PREFERENCE'
      ? '以后叫我老王'
      : kind === 'CONTENT_PREFERENCE'
        ? '我不喜欢剧透'
        : '以后回答我短一点',
  })))

  for (const role of ['OWNER', 'MEMBER'] as const) {
    const harness = createHarness(extractorResponse)
    try {
      await feedThree(harness.service, 'sig-a', role)
      assert(
        harness.extractorPrompts[0]?.includes('CURRENT_REQUESTER') === true,
        'the extractor prompt does not state the requester subject contract',
      )

      const personalScope = role === 'OWNER' ? 'OWNER' : 'MEMBER'
      const stored = harness.store.retrieve([
        { scopeType: personalScope, scopeId: 'sig-a', visibility: 'SHARED' },
      ], 10)
      assert(stored.length === 3, `${role} requester preferences were not normalized into personal scope`)
      assert(stored.every((item) => item.subject === 'CURRENT_REQUESTER'), `${role} preference subject changed unexpectedly`)
      assert(stored.every((item) => item.scopeType === personalScope), `${role} preference scope is not requester-local`)

      const owner = await read(harness.service, 'sig-a', role)
      const other = await read(harness.service, 'sig-b', role)
      assert(owner.length === 3, `${role} requester lost one of its three preferences`)
      assert(other.length === 0, `${role} requester preference leaked to another requester`)

      const dirtyGroup = harness.store.retrieve([
        { scopeType: 'GROUP', scopeId: roomId, visibility: 'SHARED' },
      ], 10)
      assert(dirtyGroup.length === 0, `${role} requester preference was stored as GROUP`)
    } finally {
      harness.dispose()
    }
  }
}

async function testHistoricalDirtyPreferencesAreNotReadableButGroupMemoryIs(): Promise<void> {
  const harness = createHarness('[]')
  try {
    for (const [index, kind] of localPreferenceKinds.entries()) {
      const status = harness.store.add(record(
        `dirty-${index}`,
        'GROUP',
        roomId,
        `脏的 requester 偏好 ${index}`,
        kind,
        'CURRENT_REQUESTER',
      ))
      assert(status === 'WRITTEN', `could not seed dirty GROUP preference ${index}: ${status}`)
    }
    const groupStatus = harness.store.add(record(
      'legitimate-group',
      'GROUP',
      roomId,
      '这个群回答都短一点',
      'SOFT_STYLE_PREFERENCE',
      'GROUP',
    ))
    assert(groupStatus === 'WRITTEN', `could not seed legitimate group preference: ${groupStatus}`)

    const fromA = await read(harness.service, 'sig-a', 'MEMBER')
    const fromB = await read(harness.service, 'sig-b', 'MEMBER')
    assert(fromA.length === 1 && fromA[0]?.content === '这个群回答都短一点', 'dirty GROUP preferences reached requester A or hid legal group memory')
    assert(fromB.length === 1 && fromB[0]?.content === '这个群回答都短一点', 'dirty GROUP preferences reached requester B or hid legal group memory')
    assert(harness.store.recordCount === 4, 'read filtering deleted or rewrote stored memory')
  } finally {
    harness.dispose()
  }
}

async function testExplicitPreferenceRoutingKeepsLocalAndGroupPhrasesDistinct(): Promise<void> {
  const mutations = new Map<string, string>([
    ['记住以后回答我短一点', '{"operation":"ADD","target":null,"subject":"CURRENT_REQUESTER","content":"以后回答我短一点","scope":"GROUP","kind":"SOFT_STYLE_PREFERENCE"}'],
    ['记住以后别给我发太长', '{"operation":"ADD","target":null,"subject":"CURRENT_REQUESTER","content":"以后别给我发太长","scope":"GROUP","kind":"SOFT_STYLE_PREFERENCE"}'],
    ['记住以后叫我老王', '{"operation":"ADD","target":null,"subject":"CURRENT_REQUESTER","content":"以后叫我老王","scope":"GROUP","kind":"ADDRESS_PREFERENCE"}'],
    ['记住我不喜欢剧透', '{"operation":"ADD","target":null,"subject":"CURRENT_REQUESTER","content":"我不喜欢剧透","scope":"GROUP","kind":"CONTENT_PREFERENCE"}'],
    ['记住以后这个群回答都短一点', '{"operation":"ADD","target":null,"subject":"GROUP","content":"这个群回答都短一点","scope":"GROUP","kind":"SOFT_STYLE_PREFERENCE"}'],
    ['记住这个群不要剧透', '{"operation":"ADD","target":null,"subject":"GROUP","content":"这个群不要剧透","scope":"GROUP","kind":"CONTENT_PREFERENCE"}'],
  ])
  const harness = createHarness('[]')
  // Replace only the mutation completion for this explicit-routing fixture.
  const service = new MemoryService({
    store: harness.store,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async (_system, user) => {
      const question = user.split('\n\nuserRequest:\n')[1] ?? ''
      return mutations.get(question) ?? '{"operation":"NONE"}'
    },
    now: (() => {
      let now = 1_700_000_000_000
      return () => (now += 1_000)
    })(),
    idFactory: (() => {
      let id = 0
      return () => `explicit-${++id}`
    })(),
    log: () => undefined,
    enableTimer: false,
  })

  try {
    for (const question of mutations.keys()) {
      const result = await service.tryHandleExplicit({
        conversationType: 'GROUP',
        conversationId: roomId,
        requesterId: 'sig-a',
        requesterRole: 'OWNER',
        question,
        mentionState: 'MENTIONED',
        botMentionSpanTrust: 'VALID',
        botMentionSpanCount: 1,
        userContentSpanTrust: 'VALID',
      })
      assert(result.handled === true && result.reply === '记住了。', `explicit preference command was not handled: ${question}`)
    }

    const records = harness.store.retrieve([
      { scopeType: 'OWNER', scopeId: 'sig-a', visibility: 'SHARED' },
      { scopeType: 'GROUP', scopeId: roomId, visibility: 'SHARED' },
    ], 20)
    const personal = records.filter((item) => item.scopeType === 'OWNER')
    const group = records.filter((item) => item.scopeType === 'GROUP')
    assert(personal.length === 4, 'requester-local explicit preferences were not routed to the owner scope')
    assert(personal.every((item) => item.subject === 'CURRENT_REQUESTER'), 'explicit local preference subject changed')
    assert(group.length === 2, 'legitimate explicit group preferences were not preserved')
    assert(group.every((item) => item.subject === 'GROUP'), 'explicit group preference became requester-local')

    const fromB = await read(service, 'sig-b', 'OWNER')
    assert(fromB.length === 2 && fromB.every((item) => item.scope === 'GROUP'), 'explicit requester-local preferences leaked to another requester')
  } finally {
    harness.dispose()
  }
}

function testPromptContractGivesCurrentRequestPrecedenceAndNaturalAvoidance(): void {
  const prompt = buildSystemPrompt('椰椰')
  assert(prompt.includes('[Requester Preference Boundary]'), 'system prompt lacks requester preference boundary')
  assert(prompt.includes('当前消息的明确请求优先于历史偏好'), 'system prompt lacks current-request precedence')
  assert(prompt.includes('不要复述被避开的主题'), 'system prompt lacks natural topic-avoidance guidance')
  assert(prompt.includes('群体约定'), 'system prompt does not distinguish group preference from requester preference')
}

async function testFinalLlmSeesSoftPreferenceAndCurrentRequestTogether(): Promise<void> {
  const calls: Array<{ system: string; user: string }> = []
  const originalFetch = globalThis.fetch
  const answers = [
    '这次我详细解释一下：第一步先看输入，第二步再看注意力如何汇聚。',
    '好，之后会避开这个话题。',
  ]
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> }
    const messages = body.messages ?? []
    calls.push({ system: messages[0]?.content ?? '', user: messages[1]?.content ?? '' })
    const content = answers[Math.min(calls.length - 1, answers.length - 1)] as string
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) }
  }) as unknown as typeof fetch

  const request: ChatRequestContext = {
    botDisplayName: '椰椰',
    mention: 'MENTIONED',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    memory: [{ scope: 'PERSONAL', content: '回答尽量简短', kind: 'SOFT_STYLE_PREFERENCE' }],
    memoryMutationThisTurn: 'NONE',
  }
  try {
    const service = new ChatService('https://provider.invalid/v1', 'test-key', 'test-model')
    const detailed = await service.reply(
      [],
      { senderId: 'opaque-a', senderName: 'MEMBER_1', text: '这次请详细解释 Self-Attention', timestamp: 1 },
      request,
    )
    assert(detailed.includes('第一步') && detailed.includes('第二步'), 'current detailed request was not allowed to override the soft preference')

    const avoided = await service.reply(
      [],
      { senderId: 'opaque-a', senderName: 'MEMBER_1', text: '以后不要在我面前提榴莲', timestamp: 2 },
      request,
    )
    assert(avoided === '好，之后会避开这个话题。', 'topic-avoidance acknowledgement was not natural')
    assert(!avoided.includes('榴莲'), 'topic-avoidance acknowledgement repeated the avoided topic')
    assert(calls.length === 2, 'preference fixture made an unexpected extra provider call')
    assert(calls.every((call) => call.system.includes('[Requester Preference Boundary]')), 'final LLM did not receive the requester preference contract')
    assert(calls[0]?.user.includes('回答尽量简短') && calls[0]?.user.includes('这次请详细解释 Self-Attention'), 'final LLM fixture did not contain both historical preference and current request')
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function main(): Promise<void> {
  await testAutomaticPreferencesNormalizeToRequesterScope()
  await testHistoricalDirtyPreferencesAreNotReadableButGroupMemoryIs()
  await testExplicitPreferenceRoutingKeepsLocalAndGroupPhrasesDistinct()
  testPromptContractGivesCurrentRequestPrecedenceAndNaturalAvoidance()
  await testFinalLlmSeesSoftPreferenceAndCurrentRequestTogether()
  console.log('requester-preference-boundary: ok')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
