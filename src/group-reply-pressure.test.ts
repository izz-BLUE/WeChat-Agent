/**
 * Group reply pressure and low-information response-depth contract tests.
 *
 * Runtime supplies only a coarse structural pressure fact. The final provider
 * still decides whether the current message is a reaction or an explicit task.
 */
import { strict as assert } from 'node:assert'
import { buildSystemPrompt, buildUserPrompt, ChatService, type ChatRequestContext } from './chat.js'
import type { GroupMessage } from './context.js'
import type {
  ConversationContinuity,
  ConversationDynamicsProfile,
  ConversationPace,
  ConversationParticipation,
} from './conversation-dynamics.js'

function profile(
  participation: ConversationParticipation,
  pace: ConversationPace,
): ConversationDynamicsProfile {
  return {
    activeTurnCount: 0,
    ambientLineCount: 0,
    lastActiveRequester: 'NONE',
    assistantRecent: false,
    lastAssistantReplyTarget: 'NONE',
    membersAfterAssistant: 0,
    participation,
    pace,
    continuity: 'NONE' as ConversationContinuity,
  }
}

const QUESTION: GroupMessage = {
  senderId: 'requester-a',
  senderName: 'MEMBER_2',
  text: '当前问题',
  timestamp: 1,
}

const BASE_REQUEST: ChatRequestContext = {
  botDisplayName: '椰椰',
  mention: 'MENTIONED',
  requesterRole: 'MEMBER',
  ownerConfigured: false,
  currentSpeakerLabel: 'MEMBER_2',
  memoryMutationThisTurn: 'NONE',
}

function assertIncludes(text: string, expected: string, message: string): void {
  assert(text.includes(expected), `${message}: missing ${expected}`)
}

function providerStub(answers: readonly string[]): {
  calls: Array<{ system: string; user: string }>
  restore(): void
} {
  const calls: Array<{ system: string; user: string }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> }
    const messages = body.messages ?? []
    calls.push({ system: messages[0]?.content ?? '', user: messages[1]?.content ?? '' })
    const content = answers[Math.min(calls.length - 1, answers.length - 1)] ?? ''
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }),
    }
  }) as unknown as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

function testPressurePromptFacts(): void {
  const cases: Array<[
    ConversationParticipation,
    ConversationPace,
    string,
  ]> = [
    ['MULTI_PARTY', 'HIGH', 'HIGH'],
    ['MULTI_PARTY', 'MEDIUM', 'MEDIUM'],
    ['FOCUSED', 'HIGH', 'MEDIUM'],
    ['FOCUSED', 'LOW', 'LOW'],
  ]
  for (const [participation, pace, expected] of cases) {
    const prompt = buildUserPrompt([], QUESTION, {
      ...BASE_REQUEST,
      conversationDynamics: profile(participation, pace),
    })
    assertIncludes(prompt, '[Group Reply Pressure: TRUSTED_RUNTIME_FACT]', 'reply pressure section missing')
    assertIncludes(prompt, `GROUP_REPLY_PRESSURE=${expected}`, `${participation}+${pace} mapped incorrectly`)
  }
}

function testResponseDepthContract(): void {
  const system = buildSystemPrompt('椰椰')
  assertIncludes(system, '[Group Reply Pressure]', 'system prompt lacks group reply pressure contract')
  assertIncludes(system, '普通群聊默认非常紧凑', 'HIGH pressure contract is missing')
  assertIncludes(system, '简单 reaction / acknowledgement', 'low-information reaction contract is missing')
  assertIncludes(system, '没有提出新的明确问题、任务或信息请求', 'reaction semantic boundary is missing')
  assertIncludes(system, '明确要求详细解释、教程、步骤或代码', 'explicit detail override is missing')
  assertIncludes(system, '可以自然突破 Reply Pressure', 'pressure is not a soft constraint')
  assertIncludes(system, '不主动重新解释上一主题', 'reaction must not expand the previous topic')
  assertIncludes(system, '不要从 PARTICIPATION/PACE 自行计算压力', 'model is not told to recalculate pressure')
  assert(!system.includes('answer.slice(0, 200)'), 'hard truncation leaked into the system contract')
}

function testReactionAndExplicitQuestionStayWithTheFinalLlm(): void {
  const reactionTexts = ['哈哈', '诶我去', '牛逼', '笑死']
  for (const text of reactionTexts) {
    const prompt = buildUserPrompt([], { ...QUESTION, text }, {
      ...BASE_REQUEST,
      conversationDynamics: profile('MULTI_PARTY', 'HIGH'),
    })
    assertIncludes(prompt, `当前提问：\nMEMBER_2：${text}`, `reaction ${text} was not passed to the final prompt`)
    assertIncludes(prompt, 'GROUP_REPLY_PRESSURE=HIGH', `reaction ${text} lost reply pressure`)
  }

  const followUpPrompt = buildUserPrompt([], {
    ...QUESTION,
    text: '哈哈，那为什么这个方案会死锁？',
  }, {
    ...BASE_REQUEST,
    conversationDynamics: profile('MULTI_PARTY', 'HIGH'),
  })
  assertIncludes(followUpPrompt, '哈哈，那为什么这个方案会死锁？', 'reaction plus explicit question was not passed through')
}

async function testExplicitDetailOverrideReachesProvider(): Promise<void> {
  const provider = providerStub(['这次详细讲：第一步确认线程状态，第二步分析锁的获取顺序。'])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      { ...QUESTION, text: '详细解释一下这段代码，一步一步讲' },
      {
        ...BASE_REQUEST,
        conversationDynamics: profile('MULTI_PARTY', 'HIGH'),
      },
    )
    assertIncludes(answer, '第一步', 'explicit detail request was shortened by pressure')
    assert.equal(provider.calls.length, 1, 'explicit detail request caused an unexpected regeneration')
    assertIncludes(provider.calls[0]?.user ?? '', 'GROUP_REPLY_PRESSURE=HIGH', 'detail request lost pressure fact')
  } finally {
    provider.restore()
  }
}

async function testAnswerGuardRegenerationKeepsPressure(): Promise<void> {
  const provider = providerStub(['你就是 MEMBER_1。', '收到。'])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [{ senderId: 'other', senderName: 'MEMBER_1', text: '之前的话', timestamp: 1 }],
      QUESTION,
      {
        ...BASE_REQUEST,
        conversationDynamics: profile('MULTI_PARTY', 'HIGH'),
      },
    )
    assert.equal(answer, '收到。')
    assert.equal(provider.calls.length, 2, 'Answer Guard did not perform exactly one bounded regeneration')
    assertIncludes(provider.calls[0]?.user ?? '', 'GROUP_REPLY_PRESSURE=HIGH', 'initial final prompt lost pressure')
    assertIncludes(provider.calls[1]?.user ?? '', 'GROUP_REPLY_PRESSURE=HIGH', 'regeneration user prompt lost pressure')
    assertIncludes(provider.calls[1]?.system ?? '', '[Group Reply Pressure]', 'regeneration system prompt lost pressure contract')
  } finally {
    provider.restore()
  }
}

function testProviderSafePressureProjection(): void {
  const forbidden = ['requester-a', 'room-a@chatroom', 'MEMBER_2', '原始群聊正文']
  const prompt = buildUserPrompt([], QUESTION, {
    ...BASE_REQUEST,
    conversationDynamics: profile('MULTI_PARTY', 'HIGH'),
  })
  const pressureSection = /\[Group Reply Pressure: TRUSTED_RUNTIME_FACT\]\nGROUP_REPLY_PRESSURE=(?:LOW|MEDIUM|HIGH)/u.exec(prompt)?.[0] ?? ''
  assertIncludes(pressureSection, 'GROUP_REPLY_PRESSURE=HIGH', 'pressure fact is not enum-valued')
  for (const value of forbidden) {
    assert(!pressureSection.includes(value), `pressure section leaked ${value}`)
  }
}

async function main(): Promise<void> {
  testPressurePromptFacts()
  testResponseDepthContract()
  testProviderSafePressureProjection()
  testReactionAndExplicitQuestionStayWithTheFinalLlm()
  await testExplicitDetailOverrideReachesProvider()
  await testAnswerGuardRegenerationKeepsPressure()
  console.log('group-reply-pressure: ok')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
