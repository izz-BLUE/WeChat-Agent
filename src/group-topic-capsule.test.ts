import assert from 'node:assert/strict'
import { ChatService, buildSystemPrompt, buildUserPrompt, type ChatRequestContext } from './chat.js'
import type { GroupMessage } from './context.js'
import { GroupAmbientContext } from './group-ambient-context.js'
import { GroupConversationContextAssembler } from './group-conversation-context.js'
import {
  GroupTopicCapsuleCompactor,
  GroupTopicCapsuleStore,
  topicSourceEventId,
  type GroupTopicCapsuleDraft,
} from './group-topic-capsule.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import type { AgentRequest } from './agent-adapter.js'
import { observeGroupStyle } from './group-style.js'
import { RequesterLocalContext } from './requester-local-context.js'

const GROUP_A = 'topic-group-a@chatroom'
const GROUP_B = 'topic-group-b@chatroom'
const REQUESTER_A = 'topic-requester-a'
const REQUESTER_B = 'topic-requester-b'
const NOW = 1_800_000_000_000

let cases = 0
let failures = 0

function check(name: string, body: () => void | Promise<void>): Promise<void> {
  cases += 1
  return Promise.resolve().then(body).then(
    () => console.log(`[GROUP_TOPIC_CAPSULE_CASE] name=${name} result=PASS`),
    (error) => {
      failures += 1
      console.log(`[GROUP_TOPIC_CAPSULE_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
    },
  )
}

function appendAmbient(
  ambient: GroupAmbientContext,
  group: string,
  id: string,
  text: string,
  timestamp = NOW,
  speakerId = REQUESTER_A,
  speakerType: 'MEMBER' | 'ASSISTANT' = 'MEMBER',
): void {
  ambient.append(group, {
    messageId: id,
    speakerId: speakerType === 'ASSISTANT' ? 'ASSISTANT' : speakerId,
    speakerType,
    text,
    timestamp,
    ...(speakerType === 'ASSISTANT' ? { replyToSpeakerId: speakerId } : {}),
  })
}

function eventsFromUser(user: string): string[] {
  return [...user.matchAll(/sourceEventId=(E[0-9a-f]{16})/gu)].map((match) => match[1] as string)
}

function sourceId(number: number): string {
  return `E${number.toString(16).padStart(16, '0')}`
}

function makeResponseFromInput(user: string, topic = '群聊主题', summary = '群里公开讨论了一个方案并留下后续问题。'): string {
  return JSON.stringify({
    capsules: [{ topic, summary, keywords: ['方案', '后续'], sourceEventIds: eventsFromUser(user) }],
  })
}

function makeFixture(options: { count?: number; recentRawEntries?: number; recentRawMaxChars?: number } = {}) {
  const ambient = new GroupAmbientContext({ now: () => NOW, maxEntries: 40, maxChars: 8_000 })
  const store = new GroupTopicCapsuleStore({ now: () => NOW, maxChars: 2_400, idFactory: (() => { let id = 0; return () => `capsule-${++id}` })() })
  const count = options.count ?? 10
  for (let index = 0; index < count; index += 1) {
    appendAmbient(ambient, GROUP_A, `event-${index}`, `公开群聊消息 ${index}`, NOW + index, index % 2 === 0 ? REQUESTER_A : REQUESTER_B)
  }
  const compactor = new GroupTopicCapsuleCompactor({
    ambient,
    store,
    triggerEventCount: 2,
    triggerCharCount: 10_000,
    recentRawEntries: options.recentRawEntries ?? 2,
    recentRawMaxChars: options.recentRawMaxChars ?? 1_000,
    timeoutMs: 250,
    complete: async (_system, user) => makeResponseFromInput(user),
    now: () => NOW,
  })
  return { ambient, store, compactor }
}

function draft(
  topic: string,
  sourceEventIds: readonly string[],
  speakerTypes: readonly ('MEMBER' | 'ASSISTANT')[] = ['MEMBER'],
  state: { settledPoints?: readonly string[]; openQuestions?: readonly string[] } = {},
): GroupTopicCapsuleDraft {
  return {
    topic,
    summary: `${topic} 的公开摘要`,
    settledPoints: state.settledPoints ?? [],
    openQuestions: state.openQuestions ?? [],
    keywords: ['方案', '讨论'],
    sourceEventIds,
    sourceStartAt: NOW,
    sourceEndAt: NOW + 1,
    speakerTypes,
  }
}

function currentMessage(messageId: string, text: string, senderId = REQUESTER_A): GroupMessage {
  return {
    messageId,
    senderId,
    senderName: 'MEMBER_1',
    publicDisplayName: null,
    text,
    timestamp: NOW,
  }
}

function activeRequest(messageId: string, conversationId = GROUP_A, conversationType: 'GROUP' | 'DIRECT' = 'GROUP'): AgentRequest {
  return {
    conversationKey: `${conversationType.toLowerCase()}:${conversationId}`,
    messageId,
    conversationType,
    conversationId,
    senderId: REQUESTER_A,
    requesterId: REQUESTER_A,
    requesterSource: 'TEST',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    ownerDisplayName: null,
    publicDisplayName: '测试成员',
    senderName: '测试成员',
    text: '刚才 FDE 那件事呢？',
    timestamp: NOW,
    mentionState: 'MENTIONED',
    botMentionSpans: { trust: 'VALID', spans: [] },
    userContentSpan: { trust: 'VALID', span: { start: 0, length: 12 } },
    metadata: { rawMessageType: 1 },
  }
}

function mixedContext(store: GroupTopicCapsuleStore, ambient: GroupAmbientContext, local = new RequesterLocalContext({ now: () => NOW })) {
  return new GroupConversationContextAssembler(local, ambient, {
    topicCapsuleStore: store,
    topicCapsuleMaxSelected: 3,
    topicCapsuleMaxChars: 2_400,
    groupAmbientMaxEntries: 40,
    groupAmbientMaxChars: 8_000,
  })
}

async function main(): Promise<void> {
  await check('store is process-local and isolated by group', () => {
    const store = new GroupTopicCapsuleStore({ now: () => NOW, idFactory: () => 'a' })
    store.addMany(GROUP_A, [draft('A', [sourceId(1)])])
    assert.equal(store.count(GROUP_A), 1)
    assert.equal(store.count(GROUP_B), 0)
    assert.equal(store.select(GROUP_B, 'A').selectedCount, 0)
  })

  await check('Capsule source is GROUP_AMBIENT only', async () => {
    const fixture = makeFixture()
    const result = await fixture.compactor.compactGroup(GROUP_A)
    assert.equal(result.result, 'COMPACTED')
    assert(fixture.store.count(GROUP_A) > 0)
    assert(!fixture.store.entries(GROUP_A)[0]?.summary.includes('requester-local'))
  })

  await check('requester local content never enters compactor input', async () => {
    const fixture = makeFixture()
    const localText = 'REQUESTER_LOCAL_PRIVATE_ONLY'
    const local = new RequesterLocalContext({ now: () => NOW })
    local.append(GROUP_A, REQUESTER_A, { ...currentMessage('local', localText), senderId: REQUESTER_A })
    let input = ''
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 2,
      recentRawEntries: 2,
      recentRawMaxChars: 1_000,
      complete: async (_system, user) => { input = user; return makeResponseFromInput(user) },
      now: () => NOW,
    })
    await compactor.compactGroup(GROUP_A)
    assert(!input.includes(localText))
  })

  await check('passive GROUP traffic never schedules Capsule LLM', async () => {
    const fixture = makeFixture()
    let calls = 0
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 1,
      recentRawEntries: 1,
      complete: async (_system, user) => { calls += 1; return makeResponseFromInput(user) },
      now: () => NOW,
    })
    const agent = new ProductionChatAgent({ reply: async () => '不应调用' } as unknown as ChatService, {
      ambientContext: fixture.ambient,
      topicCapsuleStore: fixture.store,
      topicCapsuleCompactor: compactor,
    })
    for (let index = 0; index < 40; index += 1) {
      agent.observePassiveContext({
        conversationKey: `group:${GROUP_A}`,
        messageId: `passive-${index}`,
        conversationType: 'GROUP',
        conversationId: GROUP_A,
        senderId: REQUESTER_A,
        requesterId: REQUESTER_A,
        text: `passive ${index}`,
        timestamp: NOW + index,
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(calls, 0)
  })

  await check('threshold not reached makes zero compaction calls', async () => {
    const fixture = makeFixture({ count: 3, recentRawEntries: 2 })
    let calls = 0
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 2,
      triggerCharCount: 10_000,
      recentRawEntries: 2,
      complete: async (_system, user) => { calls += 1; return makeResponseFromInput(user) },
      now: () => NOW,
    })
    const result = await compactor.compactGroup(GROUP_A)
    assert.equal(result.reason, 'THRESHOLD_NOT_MET')
    assert.equal(calls, 0)
  })

  await check('threshold schedules one non-blocking background compaction', async () => {
    const fixture = makeFixture()
    let calls = 0
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 2,
      recentRawEntries: 2,
      complete: async (_system, user) => { calls += 1; return makeResponseFromInput(user) },
      now: () => NOW,
    })
    compactor.schedule(GROUP_A)
    assert.equal(calls, 0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(calls, 1)
    assert.equal(fixture.store.count(GROUP_A), 1)
  })

  await check('new Capsule is readable by the next assembler request', async () => {
    const fixture = makeFixture()
    await fixture.compactor.compactGroup(GROUP_A)
    const context = mixedContext(fixture.store, fixture.ambient).assemble({
      groupConversationId: GROUP_A,
      requesterIdentity: REQUESTER_A,
      currentEventId: 'current',
      currentTurn: currentMessage('current', '刚才 FDE 呢？'),
      currentSpeakerLabel: 'MEMBER_1',
    })
    assert.equal(context.topicContext.length, 1)
    assert(context.topicContext[0]?.summary.includes('群里公开讨论'))
  })

  await check('Thread State is returned by the existing single compactor completion', async () => {
    const fixture = makeFixture()
    let calls = 0
    let system = ''
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 2,
      recentRawEntries: 2,
      complete: async (systemPrompt, user) => {
        calls += 1
        system = systemPrompt
        return JSON.stringify({ capsules: [{
          topic: '晚餐安排',
          summary: '群里讨论今晚聚餐',
          settledPoints: ['今晚吃火锅'],
          openQuestions: ['具体地点还没确定'],
          keywords: ['晚餐', '火锅'],
          sourceEventIds: eventsFromUser(user),
        }] })
      },
      now: () => NOW,
    })
    const result = await compactor.compactGroup(GROUP_A)
    const stored = fixture.store.entries(GROUP_A)[0]
    assert.equal(result.result, 'COMPACTED')
    assert.equal(calls, 1)
    assert(system.includes('settledPoints'))
    assert(system.includes('openQuestions'))
    assert.deepEqual(stored?.settledPoints, ['今晚吃火锅'])
    assert.deepEqual(stored?.openQuestions, ['具体地点还没确定'])

    const context = mixedContext(fixture.store, fixture.ambient).assemble({
      groupConversationId: GROUP_A,
      requesterIdentity: REQUESTER_A,
      currentEventId: 'current',
      currentTurn: currentMessage('current', '火锅地点呢？'),
      currentSpeakerLabel: 'MEMBER_1',
    })
    const prompt = buildUserPrompt([], currentMessage('current', '火锅地点呢？'), {
      botDisplayName: '椰椰', mention: 'MENTIONED', requesterRole: 'MEMBER', ownerConfigured: false,
      conversationType: 'GROUP', groupConversationContext: context,
    })
    assert(prompt.includes(`snapshotEndAt=${stored?.sourceEndAt}`))
    assert(prompt.includes('今晚吃火锅'))
    assert(prompt.includes('具体地点还没确定'))
    assert(!prompt.includes(stored?.sourceEventIds[0] ?? 'NO_SOURCE_ID'))
  })

  await check('answered source question is represented as settled and not open', async () => {
    const ambient = new GroupAmbientContext({ now: () => NOW, maxEntries: 10 })
    appendAmbient(ambient, GROUP_A, 'question', '几点集合？', NOW)
    appendAmbient(ambient, GROUP_A, 'answer', '晚上七点集合', NOW + 1)
    appendAmbient(ambient, GROUP_A, 'later', '收到', NOW + 2)
    const store = new GroupTopicCapsuleStore({ now: () => NOW })
    let system = ''
    const compactor = new GroupTopicCapsuleCompactor({
      ambient, store, triggerEventCount: 1, recentRawEntries: 1,
      complete: async (systemPrompt, user) => {
        system = systemPrompt
        return JSON.stringify({ capsules: [{
          topic: '集合时间', summary: '群里确认了集合时间',
          settledPoints: ['集合时间为晚上七点'], openQuestions: [],
          keywords: ['集合', '七点'], sourceEventIds: eventsFromUser(user),
        }] })
      },
      now: () => NOW,
    })
    await compactor.compactGroup(GROUP_A)
    assert(system.includes('后续 source event 已回答的问题不得保留'))
    assert.deepEqual(store.entries(GROUP_A)[0]?.settledPoints, ['集合时间为晚上七点'])
    assert.deepEqual(store.entries(GROUP_A)[0]?.openQuestions, [])
  })

  await check('missing and malformed Thread State fields fail soft per Capsule', async () => {
    const fixture = makeFixture()
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient, store: fixture.store, triggerEventCount: 2, recentRawEntries: 2,
      complete: async (_system, user) => {
        const ids = eventsFromUser(user)
        return JSON.stringify({ capsules: [
          { topic: 'empty state', summary: 'valid capsule', keywords: ['valid'], sourceEventIds: ids.slice(0, 1) },
          { topic: 'bad state', summary: 'also valid', settledPoints: 'not-array', openQuestions: [{ text: 'bad' }, 5], keywords: ['valid'], sourceEventIds: ids.slice(1, 2) },
        ] })
      },
      now: () => NOW,
    })
    const result = await compactor.compactGroup(GROUP_A)
    assert.equal(result.capsulesProduced, 2)
    assert.deepEqual(fixture.store.entries(GROUP_A).map((item) => item.settledPoints), [[], []])
    assert.deepEqual(fixture.store.entries(GROUP_A).map((item) => item.openQuestions), [[], []])
  })

  await check('Thread State arrays trim, deduplicate, and enforce item and count bounds', async () => {
    const fixture = makeFixture()
    const longValue = '长'.repeat(130)
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient, store: fixture.store, triggerEventCount: 2, recentRawEntries: 2,
      complete: async (_system, user) => JSON.stringify({ capsules: [{
        topic: 'bounded', summary: 'valid',
        settledPoints: ['  已确认  ', '已确认', '', longValue, '第三项', '第四项'],
        openQuestions: ['  地点未定  ', '地点未定', '时间未定', '人数未定', '状态未定'],
        keywords: ['valid'], sourceEventIds: eventsFromUser(user),
      }] }),
      now: () => NOW,
    })
    await compactor.compactGroup(GROUP_A)
    const stored = fixture.store.entries(GROUP_A)[0]
    assert.deepEqual(stored?.settledPoints, ['已确认', '长'.repeat(120), '第三项'])
    assert.deepEqual(stored?.openQuestions, ['地点未定', '时间未定', '人数未定'])
    for (const item of [...(stored?.settledPoints ?? []), ...(stored?.openQuestions ?? [])]) assert(item.length <= 120)
  })

  await check('unsafe identity state items are removed without dropping the Capsule', async () => {
    const fixture = makeFixture()
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient, store: fixture.store, triggerEventCount: 2, recentRawEntries: 2,
      complete: async (_system, user) => JSON.stringify({ capsules: [{
        topic: 'public topic', summary: 'valid capsule',
        settledPoints: ['安全结论', 'wxid_secret', 'senderId=secret', 'requesterId=secret', 'MEMBER_1 承诺请客', 'CURRENT_REQUESTER 已确认', 'scopeId=secret'],
        openQuestions: ['地点未定', 'conversationId=secret', 'wxid=secret', 'MEMBER_3 的问题', 'CURRENT_REQUESTER', 'senderId=secret'],
        keywords: ['valid'], sourceEventIds: eventsFromUser(user),
      }] }),
      now: () => NOW,
    })
    const result = await compactor.compactGroup(GROUP_A)
    assert.equal(result.capsulesProduced, 1)
    assert.deepEqual(fixture.store.entries(GROUP_A)[0]?.settledPoints, ['安全结论'])
    assert.deepEqual(fixture.store.entries(GROUP_A)[0]?.openQuestions, ['地点未定'])
  })

  await check('one batch cannot store more than three topics', async () => {
    const fixture = makeFixture()
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 2,
      recentRawEntries: 2,
      complete: async (_system, user) => {
        const ids = eventsFromUser(user)
        return JSON.stringify({ capsules: ids.slice(0, 4).map((id, index) => draft(`topic-${index}`, [id])) })
      },
      now: () => NOW,
    })
    const result = await compactor.compactGroup(GROUP_A)
    assert.equal(result.capsulesProduced, 3)
    assert.equal(fixture.store.count(GROUP_A), 3)
  })

  await check('covered source events are not selected again as raw history', async () => {
    const fixture = makeFixture()
    await fixture.compactor.compactGroup(GROUP_A)
    const selection = fixture.ambient.selectForCompaction(GROUP_A, {
      coveredSourceEventIds: fixture.store.coveredSourceEventIds(GROUP_A),
      recentRawEntries: 2,
      recentRawMaxChars: 1_000,
    })
    assert.equal(selection.coveredDropped, 8)
    assert.equal(selection.events.length, 0)
  })

  await check('in-flight guard prevents duplicate compaction', async () => {
    const fixture = makeFixture()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 2,
      recentRawEntries: 2,
      complete: async (_system, user) => { calls += 1; await gate; return makeResponseFromInput(user) },
      now: () => NOW,
    })
    const first = compactor.compactGroup(GROUP_A)
    const second = await compactor.compactGroup(GROUP_A)
    assert.equal(second.reason, 'IN_FLIGHT')
    release()
    await first
    assert.equal(calls, 1)
  })

  await check('Capsule TTL removes expired summaries', () => {
    let now = NOW
    const store = new GroupTopicCapsuleStore({ now: () => now, ttlMs: 100, idFactory: () => 'ttl' })
    store.addMany(GROUP_A, [draft('expired', [sourceId(2)])])
    now += 101
    assert.equal(store.count(GROUP_A), 0)
  })

  await check('per-group max bound evicts oldest Capsule', () => {
    const store = new GroupTopicCapsuleStore({ now: () => NOW, maxCapsulesPerGroup: 2, idFactory: (() => { let id = 0; return () => `c${++id}` })() })
    store.addMany(GROUP_A, [draft('one', [sourceId(3)])])
    store.addMany(GROUP_A, [draft('two', [sourceId(4)])])
    store.addMany(GROUP_A, [draft('three', [sourceId(5)])])
    assert.equal(store.count(GROUP_A), 2)
    assert(!store.entries(GROUP_A).some((entry) => entry.topic === 'one'))
  })

  await check('current request has priority over Capsule context', () => {
    const fixture = makeFixture({ count: 0 })
    fixture.store.addMany(GROUP_A, [draft('FDE', [sourceId(6)])])
    const current = currentMessage('current', 'CURRENT_CONFLICT')
    const context = mixedContext(fixture.store, fixture.ambient).assemble({
      groupConversationId: GROUP_A,
      requesterIdentity: REQUESTER_A,
      currentEventId: 'current',
      currentTurn: current,
      currentSpeakerLabel: 'MEMBER_1',
    })
    const request: ChatRequestContext = { botDisplayName: '椰椰', mention: 'MENTIONED', requesterRole: 'MEMBER', ownerConfigured: false, conversationType: 'GROUP', groupConversationContext: context }
    const prompt = buildUserPrompt([], current, request)
    assert.equal(prompt.split('CURRENT_CONFLICT').length - 1, 1)
    assert(buildSystemPrompt('椰椰').includes('以当前请求为准'))
  })

  await check('recent ambient has higher priority and remains raw', () => {
    const fixture = makeFixture({ count: 0 })
    appendAmbient(fixture.ambient, GROUP_A, 'recent', 'RECENT_RAW')
    fixture.store.addMany(GROUP_A, [draft('old', [topicSourceEventId(GROUP_A, 'old')])])
    const context = mixedContext(fixture.store, fixture.ambient).assemble({
      groupConversationId: GROUP_A,
      requesterIdentity: REQUESTER_A,
      currentEventId: 'current',
      currentTurn: currentMessage('current', '问题'),
      currentSpeakerLabel: 'MEMBER_1',
    })
    assert(context.recentGroupAmbient.some((line) => line.text === 'RECENT_RAW'))
    assert.equal(context.topicContext.length, 1)
  })

  await check('Chinese lexical retrieval selects the relevant Capsule first', () => {
    const store = new GroupTopicCapsuleStore({ now: () => NOW, idFactory: (() => { let id = 0; return () => `c${++id}` })() })
    store.addMany(GROUP_A, [draft('晚饭', [sourceId(7)]), draft('FDE 面试', [sourceId(8)])])
    const result = store.select(GROUP_A, '之前 FDE 那件事')
    assert.equal(result.capsules[0]?.topic, 'FDE 面试')
  })

  await check('Thread State text participates in the existing lexical relevance score', () => {
    const store = new GroupTopicCapsuleStore({ now: () => NOW, idFactory: (() => { let id = 0; return () => `state-${++id}` })() })
    store.addMany(GROUP_A, [
      draft('周末聚餐', [sourceId(20)], ['MEMBER'], { openQuestions: ['集合时间尚未确定'] }),
      draft('部署方案', [sourceId(21)], ['MEMBER'], { openQuestions: ['服务端口尚未确定'] }),
    ])
    const result = store.select(GROUP_A, '集合时间')
    assert.equal(result.capsules[0]?.topic, '周末聚餐')
    assert.equal(result.selectedByLexical, 1)
  })

  await check('newer ambient overlap with Thread State can mark only the matching snapshot stale', () => {
    const store = new GroupTopicCapsuleStore({ now: () => NOW, idFactory: (() => { let id = 0; return () => `stale-${++id}` })() })
    store.addMany(GROUP_A, [
      draft('周末聚餐', [sourceId(22)], ['MEMBER'], { openQuestions: ['集合时间尚未确定'] }),
      draft('部署端口', [sourceId(23)], ['MEMBER'], { openQuestions: ['服务端口尚未确定'] }),
    ])
    const result = store.select(GROUP_A, '无关查询', {
      recentAmbient: [{ text: '那就晚上七点集合', timestamp: NOW + 10 }],
    })
    const staleByTopic = new Map(result.capsules.map((item) => [item.topic, item.potentiallyStale]))
    assert.equal(staleByTopic.get('周末聚餐'), true)
    assert.equal(staleByTopic.get('部署端口'), false)
  })

  await check('newer same-topic snapshot is ordered first and shown with its historical boundary', () => {
    const ambient = new GroupAmbientContext({ now: () => NOW })
    const store = new GroupTopicCapsuleStore({ now: () => NOW, idFactory: (() => { let id = 0; return () => `snapshot-${++id}` })() })
    store.addMany(GROUP_A, [{ ...draft('聚餐安排', [sourceId(24)], ['MEMBER'], { openQuestions: ['集合时间尚未确定'] }), sourceStartAt: 90, sourceEndAt: 100 }])
    store.addMany(GROUP_A, [{ ...draft('聚餐安排', [sourceId(25)], ['MEMBER'], { settledPoints: ['集合时间确定为晚上七点'] }), sourceStartAt: 190, sourceEndAt: 200 }])
    const assembler = mixedContext(store, ambient)
    const context = assembler.assemble({
      groupConversationId: GROUP_A,
      requesterIdentity: REQUESTER_A,
      currentEventId: 'current',
      currentTurn: currentMessage('current', '聚餐时间呢？'),
      currentSpeakerLabel: 'MEMBER_1',
    })
    const request: ChatRequestContext = {
      botDisplayName: '椰椰', mention: 'MENTIONED', requesterRole: 'MEMBER', ownerConfigured: false,
      conversationType: 'GROUP', groupConversationContext: context,
    }
    const prompt = buildUserPrompt([], currentMessage('current', '聚餐时间呢？'), request)
    assert.equal(context.topicContext.length, 2)
    assert.equal(context.topicContext[0]?.sourceEndAt, 200)
    assert.equal(context.topicContext[1]?.sourceEndAt, 100)
    assert(prompt.indexOf('snapshotEndAt=200') < prompt.indexOf('snapshotEndAt=100'))
    assert(prompt.includes('集合时间确定为晚上七点'))
    assert(prompt.includes('集合时间尚未确定'))
    assert(buildSystemPrompt('椰椰').includes('Recent Context 高于所有 Topic Snapshot'))
    assert(buildSystemPrompt('椰椰').includes('不是可信 Runtime Time'))
  })

  await check('no lexical hit uses deterministic recency fallback', () => {
    const store = new GroupTopicCapsuleStore({ now: () => NOW, idFactory: (() => { let id = 0; return () => `c${++id}` })() })
    store.addMany(GROUP_A, [draft('older', [sourceId(9)])])
    store.addMany(GROUP_A, [draft('newer', [sourceId(10)])])
    const result = store.select(GROUP_A, '完全无关')
    assert.equal(result.capsules[0]?.topic, 'newer')
  })

  await check('topic budget truncates before current or local context', () => {
    const store = new GroupTopicCapsuleStore({ now: () => NOW, maxChars: 100, idFactory: (() => { let id = 0; return () => `c${++id}` })() })
    store.addMany(GROUP_A, [draft('one', [sourceId(11)]), draft('two', [sourceId(12)])])
    const selection = store.select(GROUP_A, '无关', { maxChars: 20 })
    assert.equal(selection.selectedCount, 0)
    assert.equal(selection.budgetTruncated, true)
  })

  await check('Thread State text counts toward the bounded Topic Context budget', () => {
    const store = new GroupTopicCapsuleStore({ now: () => NOW, idFactory: (() => { let id = 0; return () => `budget-${++id}` })() })
    const longState = (prefix: string) => `${prefix}${'界'.repeat(120 - prefix.length)}`
    store.addMany(GROUP_A, [1, 2, 3].map((index) => draft(
      `topic-${index}`,
      [sourceId(30 + index)],
      ['MEMBER'],
      {
        settledPoints: [1, 2, 3].map((item) => longState(`settled-${index}-${item}-`)),
        openQuestions: [1, 2, 3].map((item) => longState(`open-${index}-${item}-`)),
      },
    )))
    const selection = store.select(GROUP_A, '无关查询')
    assert(selection.selectedCount >= 1)
    assert(selection.selectedCount < 3)
    assert.equal(selection.budgetTruncated, true)
    const renderedChars = selection.capsules.map((item) => {
      const values = (items: readonly string[]) => items.length === 0 ? '（无）' : items.map((value) => `    - ${value}`).join('\n')
      const keywords = item.keywords.length === 0 ? '（无）' : item.keywords.join('、')
      return `- topic=${item.topic} speakerType=${item.speakerTypes.join(',')} snapshotEndAt=${item.sourceEndAt} potentiallyStale=${item.potentiallyStale === true}\n  summary=${item.summary}\n  settledPoints:\n${values(item.settledPoints)}\n  openQuestions:\n${values(item.openQuestions)}\n  keywords=${keywords}`.length
    }).reduce((total, chars, index) => total + chars + (index > 0 ? 1 : 0), 0)
    assert(renderedChars <= 2_400)
  })

  await check('provider failure fails open and preserves source coverage', async () => {
    const fixture = makeFixture()
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 2,
      recentRawEntries: 2,
      complete: async () => { throw new Error('provider down') },
      now: () => NOW,
    })
    const result = await compactor.compactGroup(GROUP_A)
    assert.equal(result.result, 'FAILED')
    assert.equal(fixture.store.count(GROUP_A), 0)
    assert.equal(fixture.store.coveredSourceEventIds(GROUP_A).length, 0)
  })

  await check('invalid JSON fails open', async () => {
    const fixture = makeFixture()
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 2,
      recentRawEntries: 2,
      complete: async () => 'not json',
      now: () => NOW,
    })
    const result = await compactor.compactGroup(GROUP_A)
    assert.equal(result.reason, 'EMPTY_RESULT')
    assert.equal(fixture.store.count(GROUP_A), 0)
  })

  await check('empty Capsule result does not write the store', async () => {
    const fixture = makeFixture()
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 2,
      recentRawEntries: 2,
      complete: async () => JSON.stringify({ capsules: [] }),
      now: () => NOW,
    })
    await compactor.compactGroup(GROUP_A)
    assert.equal(fixture.store.count(GROUP_A), 0)
  })

  await check('raw runtime identity is redacted from compactor input', async () => {
    const ambient = new GroupAmbientContext({ now: () => NOW, maxEntries: 10 })
    appendAmbient(ambient, GROUP_A, 'raw-event', 'wxid=raw-member Signature=secret')
    appendAmbient(ambient, GROUP_A, 'recent-event', 'recent')
    const store = new GroupTopicCapsuleStore({ now: () => NOW })
    let input = ''
    const compactor = new GroupTopicCapsuleCompactor({
      ambient,
      store,
      triggerEventCount: 1,
      recentRawEntries: 1,
      complete: async (_system, user) => { input = user; return makeResponseFromInput(user) },
      now: () => NOW,
    })
    await compactor.compactGroup(GROUP_A)
    assert(!input.includes('raw-member'))
    assert(!input.includes('secret'))
  })

  await check('unsafe provider summary never reaches the final prompt', async () => {
    const fixture = makeFixture()
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 2,
      recentRawEntries: 2,
      complete: async () => JSON.stringify({ capsules: [{ topic: 'bad', summary: 'wxid=secret', keywords: ['bad'], sourceEventIds: [sourceId(1)] }] }),
      now: () => NOW,
    })
    await compactor.compactGroup(GROUP_A)
    assert.equal(fixture.store.count(GROUP_A), 0)
  })

  await check('Assistant source remains marked ASSISTANT in Capsule context', async () => {
    const ambient = new GroupAmbientContext({ now: () => NOW, maxEntries: 10 })
    appendAmbient(ambient, GROUP_A, 'assistant-old', 'Assistant old reply', NOW, REQUESTER_A, 'ASSISTANT')
    appendAmbient(ambient, GROUP_A, 'recent', 'recent')
    const store = new GroupTopicCapsuleStore({ now: () => NOW })
    const compactor = new GroupTopicCapsuleCompactor({
      ambient,
      store,
      triggerEventCount: 1,
      recentRawEntries: 1,
      complete: async (_system, user) => makeResponseFromInput(user),
      now: () => NOW,
    })
    await compactor.compactGroup(GROUP_A)
    assert.deepEqual(store.entries(GROUP_A)[0]?.speakerTypes, ['ASSISTANT'])
  })

  await check('GroupStyleObserver receives raw ambient only', async () => {
    const fixture = makeFixture()
    await fixture.compactor.compactGroup(GROUP_A)
    const raw = fixture.ambient.select(GROUP_A, {}).lines.map((line) => ({ text: line.text, speakerType: 'MEMBER' as const, eventId: line.messageId }))
    const profile = observeGroupStyle({ recentGroupContext: [], groupAmbientContext: raw })
    assert(!JSON.stringify(profile).includes('群聊主题'))
  })

  await check('Capsule compaction does not read Memory', async () => {
    const fixture = makeFixture()
    let input = ''
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 2,
      recentRawEntries: 2,
      complete: async (system, user) => { input = `${system}\n${user}`; return makeResponseFromInput(user) },
      now: () => NOW,
    })
    await compactor.compactGroup(GROUP_A)
    assert(!input.includes('MEMORY_WORKING_SET'))
    assert(input.includes('不要读取或生成 Memory'))
  })

  await check('FAILED outbound ACK does not schedule Capsule compaction', async () => {
    const fixture = makeFixture()
    let calls = 0
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 1,
      recentRawEntries: 1,
      complete: async (_system, user) => { calls += 1; return makeResponseFromInput(user) },
      now: () => NOW,
    })
    const agent = new ProductionChatAgent({ reply: async () => 'reply' } as unknown as ChatService, { ambientContext: fixture.ambient, topicCapsuleStore: fixture.store, topicCapsuleCompactor: compactor })
    const request = activeRequest('failed-ack')
    const answer = await agent.complete(request)
    const identity = agent.takeOutboundIdentity(request, answer)
    assert(identity)
    agent.observeOutboundDelivery({ ...identity, status: 'FAILED', errorCode: 'SEND_FAILED' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(calls, 0)
  })

  await check('DIRECT never schedules or stores Topic Capsule', async () => {
    const fixture = makeFixture()
    let calls = 0
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 1,
      recentRawEntries: 1,
      complete: async (_system, user) => { calls += 1; return makeResponseFromInput(user) },
      now: () => NOW,
    })
    const agent = new ProductionChatAgent({ reply: async () => 'direct reply' } as unknown as ChatService, { ambientContext: fixture.ambient, topicCapsuleStore: fixture.store, topicCapsuleCompactor: compactor })
    const request = activeRequest('direct', 'peer-account', 'DIRECT')
    const answer = await agent.complete(request)
    const identity = agent.takeOutboundIdentity(request, answer)
    if (identity) agent.observeOutboundDelivery({ ...identity, status: 'SENT', errorCode: '' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(calls, 0)
    assert.equal(fixture.store.count(GROUP_A), 0)
  })

  await check('successful SENT ACK schedules, but does not await, compaction', async () => {
    const fixture = makeFixture()
    let calls = 0
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 1,
      recentRawEntries: 1,
      complete: async (_system, user) => { calls += 1; return makeResponseFromInput(user) },
      now: () => NOW,
    })
    const agent = new ProductionChatAgent({ reply: async () => 'reply' } as unknown as ChatService, { ambientContext: fixture.ambient, topicCapsuleStore: fixture.store, topicCapsuleCompactor: compactor })
    const request = activeRequest('sent-ack')
    const answer = await agent.complete(request)
    const identity = agent.takeOutboundIdentity(request, answer)
    assert(identity)
    agent.observeOutboundDelivery({ ...identity, status: 'SENT', errorCode: '' })
    assert.equal(calls, 0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(calls, 1)
  })

  await check('second compaction never summarizes the first Capsule', async () => {
    const fixture = makeFixture({ count: 10 })
    const inputs: string[] = []
    const compactor = new GroupTopicCapsuleCompactor({
      ambient: fixture.ambient,
      store: fixture.store,
      triggerEventCount: 2,
      recentRawEntries: 2,
      complete: async (_system, user) => { inputs.push(user); return makeResponseFromInput(user, 'first') },
      now: () => NOW,
    })
    await compactor.compactGroup(GROUP_A)
    appendAmbient(fixture.ambient, GROUP_A, 'new-1', 'new compactable one', NOW + 20)
    appendAmbient(fixture.ambient, GROUP_A, 'new-2', 'new compactable two', NOW + 21)
    await compactor.compactGroup(GROUP_A)
    assert.equal(inputs.length, 2)
    assert(!inputs[1]?.includes('first 的公开摘要'))
  })

  await check('source event ids are opaque hashes, not raw ids', () => {
    const id = topicSourceEventId(GROUP_A, 'raw-delivery-id')
    assert.match(id, /^E[0-9a-f]{16}$/u)
    assert(!id.includes('raw-delivery-id'))
  })

  await check('P1-A mixed assembler still has an empty topic layer without Capsules', () => {
    const ambient = new GroupAmbientContext({ now: () => NOW })
    const store = new GroupTopicCapsuleStore({ now: () => NOW })
    const result = mixedContext(store, ambient).assemble({
      groupConversationId: GROUP_A,
      requesterIdentity: REQUESTER_A,
      currentEventId: 'current',
      currentTurn: currentMessage('current', '普通问题'),
      currentSpeakerLabel: 'MEMBER_1',
    })
    assert.deepEqual(result.topicContext, [])
    assert.equal(result.diagnostics.topicCapsuleSelected, 0)
  })

  await check('group Capsule cannot be read by another group', () => {
    const store = new GroupTopicCapsuleStore({ now: () => NOW })
    store.addMany(GROUP_A, [draft('only A', [sourceId(13)])])
    assert.equal(store.select(GROUP_B, 'only A').selectedCount, 0)
  })

  console.log(`[GROUP_TOPIC_CAPSULE_TEST_SUMMARY] cases=${cases} failures=${failures}`)
  if (failures > 0) process.exitCode = 1
}

await main()
