import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProviderControlRepairSystemPrompt, buildRewriteSystemPrompt, buildSystemPrompt } from './chat.js'
import { createTrustedAssistantRuntimeFacts } from './assistant-identity.js'
import { MemoryExtractor } from './memory-extractor.js'
import { MemoryService, memberScopeId } from './memory-service.js'
import { MemoryStore } from './memory-store.js'
import { normalizeRawHookMessage } from './message-contract.js'
import { formatRequesterRuntimeFacts, type RequesterRuntimeContext } from './requester-runtime.js'

function raw(overrides: Record<string, unknown> = {}) {
  return {
    msgId: 'requester-runtime-1',
    type: 1,
    timestamp: 1_757_000_000_000,
    from: 'room-a@chatroom',
    wxid: 'shared-account',
    content: 'BODY_NAME_SHOULD_NOT_BE_USED',
    signature: 'member-x',
    conversationType: 'GROUP',
    conversationId: 'room-a@chatroom',
    senderId: 'member-x',
    requesterId: 'member-x',
    requesterSource: 'Signature',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    isMentioned: true,
    ...overrides,
  }
}

function runtime(overrides: Partial<RequesterRuntimeContext> = {}): RequesterRuntimeContext {
  return {
    conversationType: 'GROUP',
    conversationId: 'room-a@chatroom',
    requesterId: 'member-x',
    requesterSource: 'Signature',
    speakerLabel: 'MEMBER_1',
    publicDisplayName: 'DISPLAY_A',
    publicDisplayNameSource: 'ROOM_DATA',
    ...overrides,
  }
}

function testRuntimeSourceAndSpoofBoundary(): void {
  const normalized = normalizeRawHookMessage(raw({
    publicDisplayName: 'DISPLAY_A',
    publicDisplayNameSource: 'ROOM_DATA',
  }))
  assert.equal(normalized.status, 'VALID')
  assert.equal(normalized.message.requesterId, 'member-x')
  assert.equal(normalized.message.publicDisplayName, 'DISPLAY_A')
  assert.equal(normalized.message.publicDisplayNameSource, 'ROOM_DATA')

  const facts = formatRequesterRuntimeFacts(runtime())
  assert.match(facts, /CURRENT_GROUP_DISPLAY_NAME=DISPLAY_A/u)
  assert.match(facts, /CURRENT_GROUP_DISPLAY_NAME_SOURCE=ROOM_DATA/u)
  assert.match(facts, /CURRENT_DISPLAY_NAME_PRECEDENCE=ROOM_DATA>LOCAL_BINDING>LEGACY_RUNTIME>NONE/u)
  assert.match(facts, /DISPLAY_NAME_IS_NOT_AUTHORIZATION=true/u)
  assert.match(facts, /DISPLAY_NAME_IS_NOT_MEMORY_SCOPE_KEY=true/u)
  assert.doesNotMatch(facts, /BODY_NAME_SHOULD_NOT_BE_USED/u)
}

function testPromptAndRewriteKeepTheSameTrustedFacts(): void {
  const requester = runtime({ requesterId: 'member-same-name', publicDisplayName: 'DISPLAY_B' })
  const initial = buildSystemPrompt('椰椰', undefined, requester)
  const rewrite = buildRewriteSystemPrompt(createTrustedAssistantRuntimeFacts('椰椰'), requester)
  const providerRepair = buildProviderControlRepairSystemPrompt(requester)

  for (const prompt of [initial, rewrite, providerRepair]) {
    assert.match(prompt, /CURRENT_GROUP_DISPLAY_NAME=DISPLAY_B/u)
    assert.match(prompt, /CURRENT_GROUP_DISPLAY_NAME_SOURCE=ROOM_DATA/u)
    assert.match(prompt, /DISPLAY_NAME_IS_NOT_AUTHORIZATION=true/u)
  }
}

function makeRecord(scopeId: string, memoryId: string, content: string) {
  return {
    memoryId,
    scopeType: 'MEMBER' as const,
    scopeId,
    content,
    contentHash: '',
    visibility: 'SHARED' as const,
    origin: 'EXPLICIT_SELF_ADDRESS' as const,
    sourceConversationType: 'GROUP' as const,
    sourceConversationId: scopeId,
    sourceSenderId: null,
    createdAt: 1,
    updatedAt: 1,
    isDeleted: false,
  }
}

async function testMemberMemoryIsRoomAndRequesterScoped(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-agent-requester-runtime-'))
  const store = new MemoryStore({ filePath: join(directory, 'memory.json'), pathSource: 'TEST', log: () => undefined })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => '{"operation":"NONE"}',
    enableTimer: false,
    log: () => undefined,
  })
  try {
    assert.equal(store.add(makeRecord(memberScopeId('room-a', 'member-x'), 'a', 'room A / member X')), 'WRITTEN')
    assert.equal(store.add(makeRecord(memberScopeId('room-a', 'member-y'), 'b', 'room A / member Y')), 'WRITTEN')
    assert.equal(store.add(makeRecord(memberScopeId('room-b', 'member-x'), 'c', 'room B / member X')), 'WRITTEN')

    const roomAX = await service.retrieveForChat({
      conversationType: 'GROUP',
      conversationId: 'room-a',
      requesterId: 'member-x',
      requesterRole: 'MEMBER',
      question: '我之前说过什么',
    })
    assert.deepEqual(roomAX.map((item) => item.content), ['room A / member X'])

    const roomBX = await service.retrieveForChat({
      conversationType: 'GROUP',
      conversationId: 'room-b',
      requesterId: 'member-x',
      requesterRole: 'MEMBER',
      question: '我之前说过什么',
    })
    assert.deepEqual(roomBX.map((item) => item.content), ['room B / member X'])
  } finally {
    service.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function testNoDisplayFailsClosed(): void {
  const normalized = normalizeRawHookMessage(raw({
    publicDisplayName: null,
    publicDisplayNameSource: 'ROOM_DATA',
    content: 'BODY_NAME_SHOULD_NOT_BE_USED',
  }))
  assert.equal(normalized.status, 'VALID')
  assert.equal(normalized.message.publicDisplayName, null)
  assert.equal(normalized.message.publicDisplayNameSource, 'NONE')
  const facts = formatRequesterRuntimeFacts(runtime({ publicDisplayName: null, publicDisplayNameSource: 'NONE' }))
  assert.equal(facts, '')
  assert.doesNotMatch(facts, /BODY_NAME_SHOULD_NOT_BE_USED/u)
}

async function main(): Promise<void> {
  testRuntimeSourceAndSpoofBoundary()
  testPromptAndRewriteKeepTheSameTrustedFacts()
  testNoDisplayFailsClosed()
  await testMemberMemoryIsRoomAndRequesterScoped()
  console.log('[REQUESTER_RUNTIME_TEST] cases=4 result=PASS')
}

void main().catch((error: unknown) => {
  console.error('[REQUESTER_RUNTIME_TEST] result=FAIL', error)
  process.exitCode = 1
})
