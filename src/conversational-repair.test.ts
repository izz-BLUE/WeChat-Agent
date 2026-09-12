import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSystemPrompt,
  buildUserPrompt,
  ChatService,
  type ChatRequestContext,
} from './chat.js'
import type { GroupMessage } from './context.js'
import type { AmbientLine } from './group-ambient-context.js'
import { MemoryExtractor } from './memory-extractor.js'
import { MemoryService } from './memory-service.js'
import { MemoryStore } from './memory-store.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import {
  buildWebSearchPlannerUserPrompt,
  WebSearchPlanner,
  type WebSearchPlanInput,
} from './web-search-planner.js'

let cases = 0
let failures = 0

function testMessage(senderName: string, text: string, messageId = 'message-1'): GroupMessage {
  return { senderId: senderName, senderName, text, timestamp: 1, messageId }
}

function assistant(text: string, replyTarget: AmbientLine['replyTarget']): AmbientLine {
  return { label: 'ASSISTANT', text, messageId: 'assistant-1', replyTarget }
}

function promptContext(overrides: Partial<ChatRequestContext> = {}): ChatRequestContext {
  return {
    botDisplayName: '椰椰',
    mention: 'MENTIONED',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    ...overrides,
  }
}

function runtimeTime(): WebSearchPlanInput['runtimeTime'] {
  return {
    utcIso: '2026-09-13T00:00:00.000Z',
    localDate: '2026-09-13',
    localDateTime: '2026-09-13T08:00:00',
    timeZone: 'Asia/Shanghai',
  }
}

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  cases += 1
  try {
    await body()
    console.log(`[CONVERSATIONAL_REPAIR_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(`[CONVERSATIONAL_REPAIR_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
  }
}

await test('assistant-correction-gets-compact-repair-contract', () => {
  const system = buildSystemPrompt('椰椰')
  assert(system.includes('[Conversational Repair]'))
  assert(system.includes('简短承认偏差'))
  assert(system.includes('采用新事实继续'))
  assert(system.includes('不坚持旧结论或长篇道歉复述'))
})

await test('new-information-is-not-automatically-called-an-error', () => {
  const system = buildSystemPrompt('椰椰')
  assert(system.includes('仅补充新条件时更新推理'))
  assert(system.includes('不说“我刚才错了”'))
})

await test('object-correction-keeps-assistant-history-and-new-object', () => {
  const current = testMessage('MEMBER_1', '我说的是 MySQL。', 'current')
  const prompt = buildUserPrompt([], current, promptContext({
    ambient: [assistant('你说的是 Redis。', 'CURRENT_REQUESTER')],
    currentRequesterActiveContext: [],
    otherMemberActiveContext: [],
  }))
  assert(prompt.includes('你说的是 Redis。'))
  assert(prompt.includes('我说的是 MySQL。'))
  assert(prompt.includes('ASSISTANT_REPLY_TARGET=CURRENT_REQUESTER'))
})

await test('ordinal-correction-keeps-the-corrected-option', () => {
  const prompt = buildUserPrompt([], testMessage('MEMBER_1', '不对，第二个不用重启，第三个才需要。', 'current'), promptContext({
    ambient: [assistant('第二个方案需要重启服务，第三个不用。', 'CURRENT_REQUESTER')],
  }))
  assert(prompt.includes('第二个方案需要重启服务，第三个不用。'))
  assert(prompt.includes('不对，第二个不用重启，第三个才需要。'))
})

await test('other-member-assistant-reply-is-not-attributed-to-current-requester', () => {
  const prompt = buildUserPrompt([], testMessage('MEMBER_2', '不对。', 'current'), promptContext({
    ambient: [assistant('你说的是 Redis。', 'OTHER_MEMBER')],
    currentRequesterActiveContext: [],
    otherMemberActiveContext: [testMessage('MEMBER_1', '我问的是 MySQL。', 'other-1')],
  }))
  assert(prompt.includes('ASSISTANT_REPLY_TARGET=OTHER_MEMBER'))
  const system = buildSystemPrompt('椰椰')
  assert(system.includes('OTHER_MEMBER、UNKNOWN 或 NONE 不这样归因'))
})

await test('current-requester-assistant-reply-can-be-repaired', () => {
  const prompt = buildUserPrompt([], testMessage('MEMBER_1', 'Redis 指标正常，先看 MySQL。', 'current'), promptContext({
    ambient: [assistant('看起来像 Redis 连接池耗尽。', 'CURRENT_REQUESTER')],
  }))
  assert(prompt.includes('ASSISTANT_REPLY_TARGET=CURRENT_REQUESTER'))
  assert(prompt.includes('Redis 指标正常，先看 MySQL。'))
  assert(buildSystemPrompt('椰椰').includes('只有 ASSISTANT_REPLY_TARGET=CURRENT_REQUESTER 才归因于椰椰'))
})

await test('ambiguous-repair-asks-for-minimal-clarification', () => {
  const prompt = buildUserPrompt([], testMessage('MEMBER_1', '不是这个。', 'current'), promptContext({
    ambient: [
      assistant('方案一需要重启。', 'CURRENT_REQUESTER'),
      { label: 'AMBIENT_SPEAKER_1', text: '方案二也许需要重启。', messageId: 'member-2' },
    ],
    currentRequesterActiveContext: [],
    otherMemberActiveContext: [],
  }))
  assert(prompt.includes('方案一需要重启。') && prompt.includes('方案二也许需要重启。'))
  assert(buildSystemPrompt('椰椰').includes('证据不足就最小澄清'))
})

await test('search-planner-receives-corrected-object-through-existing-context', async () => {
  const input: WebSearchPlanInput = {
    question: '不是 Pro 版，我问的是标准版现在售价。',
    recentContext: [],
    ambient: [assistant('这款产品 Pro 版现在售价大约 2999。', 'CURRENT_REQUESTER')],
    authorizedMemory: [],
    runtimeTime: runtimeTime(),
    currentRequesterActiveContext: [],
    otherMemberActiveContext: [],
  }
  const plannerPrompt = buildWebSearchPlannerUserPrompt(input)
  assert(plannerPrompt.includes('这款产品 Pro 版现在售价大约 2999。'))
  assert(plannerPrompt.includes('不是 Pro 版，我问的是标准版现在售价。'))
  assert(plannerPrompt.includes('ASSISTANT_REPLY_TARGET=CURRENT_REQUESTER'))

  const result = await new WebSearchPlanner(async (_system, user) => {
    assert(user.includes('标准版现在售价'))
    return 'ACTION=SEARCH\nREASON=EXTERNAL_VERIFICATION\nQUERY=产品 标准版 现在售价\nSEARCH_MODE=GENERAL\nRECENCY_WINDOW=NONE'
  }).plan(input)
  assert.equal(result.decision.query, '产品 标准版 现在售价')
})

await test('repair-message-does-not-write-error-fact-to-memory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-agent-conversational-repair-'))
  const store = new MemoryStore({ filePath: join(directory, 'memory.json'), pathSource: 'TEST', log: () => undefined })
  let extractorCalls = 0
  const memory = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => {
      extractorCalls += 1
      return '[]'
    }),
    mutate: async () => '{"operation":"NONE"}',
    enableTimer: false,
    log: () => undefined,
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { role: 'assistant', content: '那按 MySQL 看。' } }] }),
  })) as unknown as typeof fetch

  try {
    const agent = new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'key', 'model'), { memory })
    await agent.complete({
      conversationKey: 'group:repair-memory',
      messageId: 'repair-memory-1',
      conversationType: 'GROUP',
      conversationId: 'repair-memory',
      senderId: 'requester-a',
      requesterId: 'requester-a',
      requesterSource: 'runtime',
      requesterRole: 'MEMBER',
      ownerConfigured: false,
      ownerDisplayName: null,
      senderName: 'requester-a',
      text: '不是 Redis，是 MySQL。',
      rawText: '不是 Redis，是 MySQL。',
      timestamp: 1,
      mentionState: 'MENTIONED',
      metadata: { rawMessageType: 1 },
    })
    assert.equal(memory.recordCount, 0)
    assert.equal(extractorCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
    memory.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

await test('requester-local-repair-context-does-not-cross-speaker-boundary', () => {
  const prompt = buildUserPrompt([], testMessage('MEMBER_2', '我继续问刚才那个。', 'current'), promptContext({
    currentRequesterActiveContext: [testMessage('MEMBER_2', '我说的是 MySQL。', 'current-member')],
    otherMemberActiveContext: [testMessage('MEMBER_1', '不是 MySQL，是 Redis。', 'other-member')],
  }))
  const currentStart = prompt.indexOf('[Current Requester Active Context]')
  const otherStart = prompt.indexOf('[Other Members Active Context]')
  assert(currentStart >= 0 && otherStart > currentStart)
  const currentSection = prompt.slice(currentStart, otherStart)
  assert(currentSection.includes('我说的是 MySQL。'))
  assert(!currentSection.includes('不是 MySQL，是 Redis。'))
})

await test('repair-respects-group-reply-pressure', () => {
  const prompt = buildUserPrompt([], testMessage('MEMBER_1', '不对，第二个不用重启。', 'current'), promptContext({
    ambient: [assistant('第二个方案需要重启服务。', 'CURRENT_REQUESTER')],
    groupReplyPressure: 'HIGH',
  }))
  assert(prompt.includes('GROUP_REPLY_PRESSURE=HIGH'))
  assert(buildSystemPrompt('椰椰').includes('GROUP_REPLY_PRESSURE=HIGH：普通群聊默认非常紧凑'))
})

await test('semantic-follow-up-contract-remains-present', () => {
  const system = buildSystemPrompt('椰椰')
  assert(system.includes('[Follow-up & Reference Resolution]'))
  assert(system.includes('只有一个清晰解释时直接回答'))
  assert(system.includes('[Conversational Repair]'))
})

console.log(`[CONVERSATIONAL_REPAIR_TEST_SUMMARY] cases=${cases} failures=${failures}`)
if (failures > 0) {
  process.exitCode = 1
}
