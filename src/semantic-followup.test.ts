import { strict as assert } from 'node:assert'
import {
  buildSystemPrompt,
  buildUserPrompt,
  ChatService,
  type ChatRequestContext,
} from './chat.js'
import type { GroupMessage } from './context.js'
import {
  formatConversationDynamicsProfile,
  observeConversationDynamics,
  type ConversationDynamicsProfile,
} from './conversation-dynamics.js'
import {
  WebSearchPlanner,
  buildWebSearchPlannerUserPrompt,
  parseWebSearchDecisionProtocol,
  type WebSearchPlanInput,
} from './web-search-planner.js'
import type { AmbientLine } from './group-ambient-context.js'
import type { AgentRequest } from './agent-adapter.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import type { WebSearchRequest } from './web-search.js'

let cases = 0
let failures = 0

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  cases += 1
  try {
    await body()
    console.log(`[SEMANTIC_FOLLOWUP_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(`[SEMANTIC_FOLLOWUP_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
  }
}

function active(senderName: string, text: string, messageId: string): GroupMessage {
  return { senderId: senderName, senderName, text, timestamp: 1, messageId }
}

function ambient(label: string, text: string, messageId: string, replyTarget?: AmbientLine['replyTarget']): AmbientLine {
  return {
    label,
    text,
    messageId,
    ...(replyTarget === undefined ? {} : { replyTarget }),
  }
}

function promptContext(overrides: Partial<ChatRequestContext> = {}): ChatRequestContext {
  return {
    botDisplayName: '椰椰',
    mention: 'MENTIONED',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    currentSpeakerLabel: 'MEMBER_1',
    ...overrides,
  }
}

function profileWith(
  recentGroupContext: readonly GroupMessage[],
  groupAmbientContext: readonly AmbientLine[],
  currentSpeakerLabel = 'MEMBER_1',
): ConversationDynamicsProfile {
  return observeConversationDynamics({ recentGroupContext, groupAmbientContext, currentSpeakerLabel })
}

function plannerInput(overrides: Partial<WebSearchPlanInput> = {}): WebSearchPlanInput {
  return {
    question: '当前问题',
    recentContext: [],
    ambient: [],
    authorizedMemory: [],
    runtimeTime: {
      utcIso: '2026-09-11T07:40:00.000Z',
      localDate: '2026-09-11',
      localDateTime: '2026-09-11T15:40:00',
      timeZone: 'Asia/Shanghai',
    },
    ...overrides,
  }
}

function request(messageId: string, text: string, requesterId = 'requester-a'): AgentRequest {
  return {
    conversationKey: 'group:p1-room',
    messageId,
    conversationType: 'GROUP',
    conversationId: 'p1-room',
    senderId: requesterId,
    requesterId,
    requesterSource: 'Signature',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    ownerDisplayName: null,
    senderName: 'public member',
    text,
    rawText: text,
    timestamp: Date.now(),
    mentionState: 'MENTIONED',
    metadata: { rawMessageType: 1 },
  }
}

await test('case-1 same-requester-simple-follow-up', () => {
  const previous = active('MEMBER_1', 'Redis 和 Memcached 有什么区别？', 'turn-1')
  const current = active('MEMBER_1', '那第二个适合什么场景？', 'current')
  const profile = profileWith([previous], [ambient('ASSISTANT', '刚才的回答', 'assistant-1', 'CURRENT_REQUESTER')])
  const prompt = buildUserPrompt([], current, promptContext({
    conversationDynamics: profile,
    currentRequesterActiveContext: [previous],
  }))
  check(prompt.includes('[Current Requester Active Context]') && prompt.includes(previous.text), 'final prompt omitted same-requester antecedent')
  check(prompt.includes(current.text), 'final prompt omitted current follow-up')
  check(buildSystemPrompt('椰椰').includes('[Follow-up & Reference Resolution]'), 'final system prompt lacks reference contract')
})

await test('case-2 comparison-ellipsis-search-context', async () => {
  let plannerUser = ''
  const previous = active('MEMBER_1', 'Gemini 新模型怎么样？', 'turn-1')
  const planned = await new WebSearchPlanner(async (_system, user) => {
    plannerUser = user
    return 'ACTION=SEARCH\nREASON=EXTERNAL_VERIFICATION\nQUERY=Gemini 新模型 与 DeepSeek 比较\nSEARCH_MODE=GENERAL\nRECENCY_WINDOW=NONE'
  }).plan(plannerInput({
    question: '那和 DeepSeek 比呢？',
    recentContext: [previous],
    currentRequesterActiveContext: [previous],
    ambient: [ambient('ASSISTANT', '可以继续比较', 'assistant-1', 'CURRENT_REQUESTER')],
    conversationDynamics: profileWith([previous], [ambient('ASSISTANT', '可以继续比较', 'assistant-1', 'CURRENT_REQUESTER')]),
  }))
  check(plannerUser.includes('speaker=MEMBER_1: Gemini 新模型怎么样？'), 'Search Planner did not receive the antecedent speaker label')
  check(plannerUser.includes('ASSISTANT_REPLY_TARGET=CURRENT_REQUESTER'), 'Search Planner lost assistant reply ownership')
  check(plannerUser.includes('CONTINUITY=FOLLOW_UP_LIKELY'), 'Search Planner did not receive structural continuity')
  check(planned.result === 'PASS' && planned.decision.query?.includes('Gemini') && planned.decision.query.includes('DeepSeek'), 'search query did not carry the resolved comparison object')
})

await test('case-3-assistant-previous-answer', () => {
  const prompt = buildUserPrompt([], active('MEMBER_1', '第二种怎么落地？', 'current'), promptContext({
    ambient: [
      ambient('ASSISTANT', '三种方案：A、B、C', 'assistant-1', 'CURRENT_REQUESTER'),
    ],
  }))
  check(prompt.includes('三种方案：A、B、C'), 'assistant answer was not available to final Chat')
  check(prompt.includes('ASSISTANT_REPLY_TARGET=CURRENT_REQUESTER'), 'assistant answer ownership was omitted')
  check(buildSystemPrompt('椰椰').includes('不机械复述完整前文'), 'final prompt lacks concise follow-up behavior')
})

await test('case-4-other-member-speech', () => {
  const prompt = buildUserPrompt([], active('MEMBER_2', '他说的有道理吗？', 'current'), promptContext({
    currentRequesterActiveContext: [],
    otherMemberActiveContext: [active('MEMBER_1', '我觉得是数据库连接池的问题。', 'member-a')],
  }))
  check(prompt.includes('[Other Members Active Context]') && prompt.includes('数据库连接池'), 'other member speech was not provided')
  check(!prompt.includes('[Current Requester Active Context]\nMEMBER_1：我觉得是数据库连接池'), 'other member speech crossed requester section')
  check(buildSystemPrompt('椰椰').includes('绝不能把其他成员的话归给当前 requester'), 'speaker ownership rule is missing')
})

await test('case-5-ambiguous-reference-clarify', () => {
  const prompt = buildUserPrompt([], active('MEMBER_1', '那个怎么处理？', 'current'), promptContext({
    currentRequesterActiveContext: [active('MEMBER_1', 'Redis 连接池方案', 'a-1')],
    otherMemberActiveContext: [active('MEMBER_2', '数据库迁移方案', 'b-1')],
    conversationDynamics: profileWith([
      active('MEMBER_1', 'Redis 连接池方案', 'a-1'),
      active('MEMBER_2', '数据库迁移方案', 'b-1'),
    ], []),
  }))
  check(prompt.includes('Redis 连接池方案') && prompt.includes('数据库迁移方案'), 'ambiguous candidates were not both visible')
  check(buildSystemPrompt('椰椰').includes('存在两个或以上同样合理的候选时，问一句最小澄清'), 'ambiguous-reference clarification contract is missing')
})

await test('case-6-interrupted-conversation-is-cautious', () => {
  const previous = active('MEMBER_1', 'Redis 讨论', 'a-1')
  const interrupted = active('MEMBER_2', '另一个话题', 'b-1')
  const dynamics = profileWith(
    [previous, interrupted],
    [ambient('ASSISTANT', '回复 A', 'assistant-1', 'CURRENT_REQUESTER'), ambient('AMBIENT_SPEAKER_2', 'B 插话', 'b-2')],
  )
  const user = buildWebSearchPlannerUserPrompt(plannerInput({
    question: '那个呢？',
    recentContext: [previous, interrupted],
    currentRequesterActiveContext: [previous],
    otherMemberActiveContext: [interrupted],
    ambient: [ambient('ASSISTANT', '回复 A', 'assistant-1', 'CURRENT_REQUESTER'), ambient('AMBIENT_SPEAKER_2', 'B 插话', 'b-2')],
    conversationDynamics: dynamics,
  }))
  check(dynamics.continuity === 'INTERRUPTED', 'fixture did not establish interrupted dynamics')
  check(user.includes('CONTINUITY=INTERRUPTED') && user.includes('speaker=AMBIENT_SPEAKER_2: B 插话'), 'Search Planner lost interruption evidence')
})

await test('case-7-cross-requester-boundary', () => {
  const prompt = buildUserPrompt([], active('MEMBER_2', '他刚才那个呢？', 'current'), promptContext({
    currentSpeakerLabel: 'MEMBER_2',
    currentRequesterActiveContext: [],
    otherMemberActiveContext: [active('MEMBER_1', 'A 的公开问题', 'a-1')],
    memory: [{ scope: 'GROUP', content: '公开群聊内容' }],
  }))
  check(prompt.includes('公开群聊内容') && !prompt.includes('A 的 PERSONAL Memory'), 'cross-requester fixture did not stay public-only')
  check(buildSystemPrompt('椰椰').includes('不要跨区转移发言、称呼、行为、承诺或记忆'), 'cross-requester ownership boundary is missing')
})

await test('case-8-no-context-asks-for-clarification', () => {
  const prompt = buildUserPrompt([], active('MEMBER_1', '第二个呢？', 'current'), promptContext({
    currentRequesterActiveContext: [],
    otherMemberActiveContext: [],
    ambient: [],
  }))
  check(prompt.includes('[Recent Group Context]\n（暂无）'), 'no-context prompt did not remain empty')
  check(prompt.includes('第二个呢？'), 'no-context current question is missing')
  check(buildSystemPrompt('椰椰').includes('证据不足就澄清'), 'no-context clarification rule is missing')
})

await test('case-9-search-query-privacy', () => {
  const rawRequesterId = 'wxid-private-a'
  const rawConversationId = 'room-private-a'
  const prompt = buildWebSearchPlannerUserPrompt(plannerInput({
    question: '那个现在多少钱？',
    recentContext: [{
      senderId: rawRequesterId,
      senderName: 'MEMBER_1',
      text: '某产品',
    timestamp: Date.now(),
    }],
    ambient: [ambient('AMBIENT_SPEAKER_1', '公开讨论', 'event-1')],
  }))
  check(!prompt.includes(rawRequesterId) && !prompt.includes(rawConversationId), 'planner prompt leaked raw identity')
  check(!parseWebSearchDecisionProtocol(
    `ACTION=SEARCH\nREASON=EXTERNAL_VERIFICATION\nQUERY=${rawRequesterId}\nSEARCH_MODE=GENERAL\nRECENCY_WINDOW=NONE`,
    [rawRequesterId, rawConversationId],
  ).valid, 'raw identity was accepted as a search query')
})

await test('case-10-production-search-carrier-and-no-extra-llm-call', async () => {
  const plannerPrompts: string[] = []
  const searchRequests: WebSearchRequest[] = []
  const finalContexts: ChatRequestContext[] = []
  const planner = new WebSearchPlanner(async (_system, user) => {
    plannerPrompts.push(user)
    return plannerPrompts.length === 1
      ? 'ACTION=DIRECT\nREASON=DIRECT_SUFFICIENT\nQUERY=\nSEARCH_MODE=GENERAL\nRECENCY_WINDOW=NONE'
      : 'ACTION=SEARCH\nREASON=EXTERNAL_VERIFICATION\nQUERY=Gemini 新模型 DeepSeek 比较\nSEARCH_MODE=GENERAL\nRECENCY_WINDOW=NONE'
  })
  const chat = {
    reply: async (_context: GroupMessage[], _question: GroupMessage, requestContext: ChatRequestContext) => {
      finalContexts.push(requestContext)
      return `回复${String(finalContexts.length)}`
    },
  } as unknown as ChatService
  const agent = new ProductionChatAgent(chat, {
    webSearchPlanner: planner,
    webSearchProvider: {
      search: async (searchRequest) => {
        searchRequests.push(searchRequest)
        return { results: [{ sourceId: 'S1', title: '公开来源', url: 'https://example.com/s1', snippet: '公开摘要' }] }
      },
    },
  })

  const first = request('turn-1', 'Gemini 新模型怎么样？')
  const firstAnswer = await agent.complete(first)
  const firstIdentity = agent.takeOutboundIdentity(first, firstAnswer)
  check(firstIdentity !== null, 'first generated answer was not staged')
  agent.observeOutboundDelivery({ ...firstIdentity, status: 'SENT', errorCode: '' })

  const second = request('turn-2', '那和 DeepSeek 比呢？')
  const secondAnswer = await agent.complete(second)
  check(secondAnswer === '回复2', 'second follow-up did not complete')
  check(plannerPrompts.length === 2, `expected one existing Planner call per turn, got ${plannerPrompts.length}`)
  check(plannerPrompts[1]?.includes('speaker=MEMBER_1: Gemini 新模型怎么样？'), 'production Search Planner missed active antecedent')
  check(plannerPrompts[1]?.includes('ASSISTANT_REPLY_TARGET=CURRENT_REQUESTER'), 'production Search Planner missed assistant ownership')
  check(searchRequests.length === 1 && searchRequests[0]?.query.includes('Gemini') && searchRequests[0]?.query.includes('DeepSeek'), 'resolved follow-up did not reach Search Provider')
  check(finalContexts[1]?.conversationDynamics?.continuity === 'FOLLOW_UP_LIKELY', 'production dynamics did not remain available to final Chat')
  check(finalContexts.length === 2 && finalContexts[1]?.webSearch?.status === 'PASS', 'Search result was not passed to final Chat')
  check(!formatConversationDynamicsProfile(finalContexts[1]?.conversationDynamics ?? profileWith([], [])).includes('requester-a'), 'dynamics crossed raw requester identity')
})

console.log(`[SEMANTIC_FOLLOWUP_TEST_SUMMARY] cases=${cases} failures=${failures}`)
if (failures > 0) process.exitCode = 1
