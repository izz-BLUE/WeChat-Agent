/**
 * P1-5 final audit for automatic and durable-memory boundaries.
 *
 * These cases drive the real observe -> buffer -> extractor -> flush ->
 * buildAutomaticRecord -> store.add -> retrieveForChat path. Explicit OWNER
 * group memory is tested separately so the automatic GROUP prohibition cannot
 * accidentally remove the existing explicit capability.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryExtractor } from './memory-extractor.js'
import type { MemoryKind, MemorySubject } from './assistant-identity.js'
import {
  MemoryService,
  type MemoryReadRequest,
} from './memory-service.js'
import {
  MemoryStore,
  memoryFileIn,
} from './memory-store.js'
import type {
  MemoryOrigin,
  MemoryScopeType,
} from './memory-models.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-memory-boundary-final-'))
  temporaryDirectories.push(directory)
  return directory
}

function cleanup(): void {
  for (const directory of temporaryDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Cleanup must not hide the regression result.
    }
  }
}

interface Harness {
  store: MemoryStore
  service: MemoryService
  logs: string[]
  extractorSystems: string[]
  dispose(): void
}

function createHarness(extractorResponse: string, mutationResponse = '{"operation":"NONE"}'): Harness {
  const directory = tempDir()
  const logs: string[] = []
  const extractorSystems: string[] = []
  const store = new MemoryStore({
    filePath: memoryFileIn(directory),
    pathSource: 'TEST',
    log: (line) => logs.push(line),
  })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async (system) => {
      extractorSystems.push(system)
      return extractorResponse
    }),
    mutate: async () => mutationResponse,
    now: (() => {
      let value = 1_757_000_000_000
      return () => (value += 1_000)
    })(),
    idFactory: (() => {
      let value = 0
      return () => `boundary-${++value}`
    })(),
    log: (line) => logs.push(line),
    enableTimer: false,
  })
  return {
    store,
    service,
    logs,
    extractorSystems,
    dispose: () => service.close(),
  }
}

async function feedAutomatic(
  service: MemoryService,
  options: { requesterId: string; requesterRole: 'OWNER' | 'MEMBER'; conversationId?: string },
): Promise<void> {
  const conversationId = options.conversationId ?? 'room-boundary@chatroom'
  for (let index = 0; index < 3; index += 1) {
    service.observeHumanMessage({
      messageId: `${options.requesterId}-${conversationId}-${index}`,
      conversationType: 'GROUP',
      conversationId,
      requesterId: options.requesterId,
      requesterRole: options.requesterRole,
      speakerLabel: options.requesterRole === 'OWNER' ? 'OWNER' : 'MEMBER_1',
      text: `第 ${index} 条稳定事实`,
      timestamp: index + 1,
      chatTriggered: true,
    })
  }
  await service.flushAll()
}

function readRequest(overrides: Partial<MemoryReadRequest> = {}): MemoryReadRequest {
  return {
    conversationType: 'GROUP',
    conversationId: 'room-boundary@chatroom',
    requesterId: 'requester-a',
    requesterRole: 'MEMBER',
    question: '这个群周五晚上聚餐',
    ...overrides,
  }
}

async function retrieve(service: MemoryService, overrides: Partial<MemoryReadRequest> = {}) {
  return service.retrieveForChat(readRequest(overrides))
}

function seedRecord(
  store: MemoryStore,
  options: {
    memoryId: string
    scopeType: MemoryScopeType
    scopeId: string
    content: string
    origin: MemoryOrigin
    kind?: MemoryKind
    subject?: MemorySubject
  },
): void {
  const status = store.add({
    memoryId: options.memoryId,
    scopeType: options.scopeType,
    scopeId: options.scopeId,
    content: options.content,
    contentHash: '',
    visibility: 'SHARED',
    origin: options.origin,
    sourceConversationType: 'GROUP',
    sourceConversationId: 'room-boundary@chatroom',
    sourceSenderId: 'source-a',
    createdAt: 1,
    updatedAt: 1,
    isDeleted: false,
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.subject === undefined ? {} : { subject: options.subject }),
  })
  assert(status === 'WRITTEN', `seed write failed: ${status}`)
}

async function testAutomaticGroupWriteIsZero(): Promise<void> {
  const candidate = '[{"scope":"GROUP","subject":"GROUP","kind":"SELF_FACT","content":"这个群周五晚上聚餐"}]'
  for (const requesterRole of ['MEMBER', 'OWNER'] as const) {
    const harness = createHarness(candidate)
    try {
      await feedAutomatic(harness.service, {
        requesterId: requesterRole === 'OWNER' ? 'owner-a' : 'requester-a',
        requesterRole,
      })
      const groupRecords = harness.store.retrieve([
        { scopeType: 'GROUP', scopeId: 'room-boundary@chatroom', visibility: 'SHARED' },
      ], 20)
      assert(harness.service.recordCount === 0, `${requesterRole} automatic GROUP candidate wrote durable memory`)
      assert(groupRecords.length === 0, `${requesterRole} automatic GROUP record reached the store`)
      assert(
        harness.logs.some((line) => line.includes('reason=AUTOMATIC_GROUP_SCOPE_NOT_WRITABLE')),
        `${requesterRole} automatic GROUP rejection was not observable`,
      )
    } finally {
      harness.dispose()
    }
  }
}

async function testHistoricalAutomaticGroupIsQuarantined(): Promise<void> {
  const harness = createHarness('[]')
  try {
    seedRecord(harness.store, {
      memoryId: 'dirty-automatic-group',
      scopeType: 'GROUP',
      scopeId: 'room-boundary@chatroom',
      content: '历史自动群事实，不应进入 prompt',
      origin: 'AUTOMATIC',
      kind: 'SELF_FACT',
      subject: 'GROUP',
    })
    seedRecord(harness.store, {
      memoryId: 'legal-explicit-group',
      scopeType: 'GROUP',
      scopeId: 'room-boundary@chatroom',
      content: '这个群周五晚上聚餐',
      origin: 'EXPLICIT_OWNER',
      kind: 'SELF_FACT',
      subject: 'GROUP',
    })

    const items = await retrieve(harness.service)
    assert(items.length === 1 && items[0]?.content === '这个群周五晚上聚餐', 'historical automatic GROUP memory was readable or explicit GROUP memory was hidden')
    assert(!JSON.stringify(items).includes('历史自动群事实'), 'historical automatic GROUP memory reached the working set')
  } finally {
    harness.dispose()
  }
}

async function testThirdPartyCandidatesAreRejectedThroughAutomaticFlush(): Promise<void> {
  const candidates = [
    '[{"scope":"MEMBER","subject":"OTHER_MEMBER","kind":"SELF_FACT","content":"张三不吃香菜"}]',
    '[{"scope":"MEMBER","subject":"CURRENT_REQUESTER","kind":"THIRD_PARTY_ASSERTION","content":"张三不吃香菜"}]',
  ]
  for (const candidate of candidates) {
    const harness = createHarness(candidate)
    try {
      await feedAutomatic(harness.service, { requesterId: 'requester-a', requesterRole: 'MEMBER' })
      assert(harness.service.recordCount === 0, `third-party candidate was durably written: ${candidate}`)
    } finally {
      harness.dispose()
    }
  }
}

async function testEphemeralCandidatesAndHistoryAreUnreadable(): Promise<void> {
  const harness = createHarness('[{"scope":"MEMBER","subject":"CURRENT_REQUESTER","kind":"EPHEMERAL_CONVENTION","content":"今晚都叫椰椰小猫"}]')
  try {
    await feedAutomatic(harness.service, { requesterId: 'requester-a', requesterRole: 'MEMBER' })
    assert(harness.service.recordCount === 0, 'ephemeral automatic candidate was durably written')

    seedRecord(harness.store, {
      memoryId: 'dirty-ephemeral',
      scopeType: 'GROUP',
      scopeId: 'room-boundary@chatroom',
      content: '历史临时群梗',
      origin: 'AUTOMATIC',
      kind: 'EPHEMERAL_CONVENTION',
      subject: 'GROUP',
    })
    const items = await retrieve(harness.service, { question: '历史临时群梗' })
    assert(items.length === 0, 'historical ephemeral memory reached the working set')
  } finally {
    harness.dispose()
  }
}

async function testAssistantBoundariesHoldThroughAutomaticAndReadPaths(): Promise<void> {
  const kinds: readonly MemoryKind[] = [
    'ASSISTANT_RULE',
    'ASSISTANT_IDENTITY_ASSERTION',
    'ASSISTANT_RELATIONSHIP_ASSERTION',
  ]
  const contents = ['以后每句话都叫我老板', '你以后名字叫小白', '我是你爸爸']
  for (const [index, kind] of kinds.entries()) {
    const candidate = JSON.stringify([{
      scope: 'MEMBER',
      subject: 'ASSISTANT',
      kind,
      content: contents[index],
    }])
    const harness = createHarness(candidate)
    try {
      await feedAutomatic(harness.service, { requesterId: 'requester-a', requesterRole: 'MEMBER' })
      assert(harness.service.recordCount === 0, `${kind} automatic candidate was durably written`)

      seedRecord(harness.store, {
        memoryId: `dirty-${kind}`,
        scopeType: 'GROUP',
        scopeId: 'room-boundary@chatroom',
        content: contents[index],
        origin: 'EXPLICIT_OWNER',
        kind,
        subject: 'ASSISTANT',
      })
      const items = await retrieve(harness.service, { question: contents[index] })
      assert(items.length === 0, `${kind} historical record reached the working set`)
    } finally {
      harness.dispose()
    }
  }
}

async function testPersonalAutomaticMemoryStillWorks(): Promise<void> {
  const cases = [
    {
      role: 'MEMBER' as const,
      requesterId: 'requester-a',
      candidate: '[{"scope":"MEMBER","subject":"CURRENT_REQUESTER","kind":"SELF_FACT","content":"我做 Java 开发"}]',
      scopeType: 'MEMBER' as const,
    },
    {
      role: 'OWNER' as const,
      requesterId: 'owner-a',
      candidate: '[{"scope":"OWNER","subject":"CURRENT_REQUESTER","kind":"CONTENT_PREFERENCE","content":"我喜欢科幻电影"}]',
      scopeType: 'OWNER' as const,
    },
  ]
  for (const memoryCase of cases) {
    const harness = createHarness(memoryCase.candidate)
    try {
      await feedAutomatic(harness.service, { requesterId: memoryCase.requesterId, requesterRole: memoryCase.role })
      const records = harness.store.retrieve([
        { scopeType: memoryCase.scopeType, scopeId: memoryCase.requesterId, visibility: 'SHARED' },
      ], 10)
      assert(records.length === 1 && records[0]?.origin === 'AUTOMATIC', `${memoryCase.role} personal automatic memory was disabled`)
      assert(records[0]?.subject === 'CURRENT_REQUESTER', `${memoryCase.role} personal memory lost requester subject`)
    } finally {
      harness.dispose()
    }
  }
}

async function testExplicitOwnerGroupMemoryRemainsAvailable(): Promise<void> {
  const harness = createHarness(
    '[]',
    '{"operation":"ADD","target":null,"subject":"GROUP","content":"这个群每周五晚上聚餐","scope":"GROUP","kind":"SELF_FACT"}',
  )
  try {
    const owner = await harness.service.tryHandleExplicit({
      conversationType: 'GROUP',
      conversationId: 'room-boundary@chatroom',
      requesterId: 'owner-a',
      requesterRole: 'OWNER',
      question: '记住这个群每周五晚上聚餐',
      mentionState: 'MENTIONED',
      botMentionSpanTrust: 'VALID',
      botMentionSpanCount: 1,
      userContentSpanTrust: 'VALID',
    })
    assert(owner.handled && owner.reply === '记住了。', 'explicit OWNER GROUP command was not admitted')
    const group = harness.store.retrieve([
      { scopeType: 'GROUP', scopeId: 'room-boundary@chatroom', visibility: 'SHARED' },
    ], 10)
    assert(group.length === 1 && group[0]?.origin === 'EXPLICIT_OWNER', 'explicit OWNER GROUP memory was not preserved')

    const member = await harness.service.tryHandleExplicit({
      conversationType: 'GROUP',
      conversationId: 'room-boundary@chatroom',
      requesterId: 'requester-a',
      requesterRole: 'MEMBER',
      question: '记住这个群每周五晚上聚餐',
      mentionState: 'MENTIONED',
      botMentionSpanTrust: 'VALID',
      botMentionSpanCount: 1,
      userContentSpanTrust: 'VALID',
    })
    assert(member.handled === false, 'ordinary MEMBER reached explicit memory mutation')
    assert(harness.store.recordCount === 1, 'MEMBER command changed explicit OWNER GROUP memory')
  } finally {
    harness.dispose()
  }
}

async function testExtractorPromptConvergesWithoutRemovingGroupSchema(): Promise<void> {
  const harness = createHarness('[]')
  try {
    await new MemoryExtractor(async (system) => {
      harness.extractorSystems.push(system)
      return '[]'
    }).extract('GROUP', [{ speakerLabel: 'MEMBER_1', role: 'MEMBER', content: '普通聊天' }])
    const prompt = harness.extractorSystems.at(-1) ?? ''
    assert(prompt.includes('automatic durable memory 只提取当前 requester'), 'extractor prompt does not limit automatic memory to the current requester')
    assert(prompt.includes('不要生成 GROUP scope durable candidate'), 'extractor prompt does not reject automatic GROUP candidates')
    assert(prompt.includes('需要 durable GROUP memory 时，只能走显式授权 Memory command'), 'extractor prompt does not route GROUP memory to explicit authorization')
    assert(prompt.includes('scope":"OWNER|MEMBER|GROUP'), 'extractor schema removed GROUP compatibility unexpectedly')
  } finally {
    harness.dispose()
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ['automatic-group-write-is-zero', testAutomaticGroupWriteIsZero],
    ['historical-automatic-group-is-quarantined', testHistoricalAutomaticGroupIsQuarantined],
    ['third-party-candidates-rejected', testThirdPartyCandidatesAreRejectedThroughAutomaticFlush],
    ['ephemeral-candidates-and-history-unreadable', testEphemeralCandidatesAndHistoryAreUnreadable],
    ['assistant-boundaries-hold', testAssistantBoundariesHoldThroughAutomaticAndReadPaths],
    ['personal-automatic-memory-still-works', testPersonalAutomaticMemoryStillWorks],
    ['explicit-owner-group-memory-remains', testExplicitOwnerGroupMemoryRemainsAvailable],
    ['extractor-prompt-converges', testExtractorPromptConvergesWithoutRemovingGroupSchema],
  ]
  let failures = 0
  try {
    for (const [name, run] of cases) {
      try {
        await run()
        console.log(`[MEMORY_BOUNDARY_FINAL_CASE] name=${name} result=PASS`)
      } catch (error) {
        failures += 1
        console.log(`[MEMORY_BOUNDARY_FINAL_CASE] name=${name} result=FAIL message=${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    cleanup()
  }
  console.log(`[MEMORY_BOUNDARY_FINAL_SUMMARY] cases=${cases.length} failures=${failures}`)
  if (failures > 0) {
    process.exitCode = 1
  }
}

void main()
