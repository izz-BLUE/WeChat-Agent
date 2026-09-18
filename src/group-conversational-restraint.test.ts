/**
 * GROUP Conversational Restraint regression tests.
 *
 * A. 摸摸你 → SOCIAL_LIGHT, no CTA, no story expansion.
 * B. 哈哈哈哈 → short reaction, no new topic.
 * C. 我呢 in a role-assignment context → only the requester.
 * D/E. 第二章/第三章 with a story thread → one bounded unit, UNIQUE.
 * F. bare 继续 with a single thread → UNIQUE.
 * G. 继续 with story + tech threads → AMBIGUOUS clarification.
 * H. 下一章你自己安排谁开车 → delegated, still TASK_NORMAL.
 * J. 给我们群每个人都编个角色 → broad creative task stays TASK_NORMAL.
 * K. 详细解释 LangGraph checkpoint → TASK_DETAILED.
 * L. LangGraph checkpoint 是啥 → TASK_NORMAL.
 * M. 给我写个 Java 两数相加 → TASK_NORMAL.
 * N/O. Historical detailed preference cannot amplify a light message.
 * P. OWNER gets the same restraint as MEMBER.
 * Q. DIRECT keeps existing behaviour: no restraint section, no CTA strip.
 * R. Guard regeneration keeps the restraint rules.
 * S. Grounding repair must not add CTA or scope expansion.
 * T. Social Output Boundary remains the final hard cap (existing suites).
 */
import { strict as assert } from 'node:assert'
import { buildSystemPrompt, buildUserPrompt, ChatService, type ChatRequestContext } from './chat.js'
import type { GroupMessage } from './context.js'
import {
  resolveEffectiveGroupResponseDepth,
  resolveGroupConversationalRestraint,
  stripTrailingGroupCta,
  type GroupConversationalRestraint,
  type GroupContinuationResolution,
  type GroupConversationalMode,
} from './group-conversational-restraint.js'
import type { MemberInteractionProfile } from './member-interaction-profile.js'
import { GROUP_SOCIAL_OUTPUT_BUDGETS } from './chat-renderer.js'

let cases = 0
let failures = 0

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  cases += 1
  try {
    await body()
    console.log(`[GROUP_RESTRAINT_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(`[GROUP_RESTRAINT_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
  }
}

interface ProviderCall {
  system: string
  user: string
}

interface ProviderStub {
  calls: ProviderCall[]
  restore(): void
}

function stubProvider(answers: readonly string[]): ProviderStub {
  const calls: ProviderCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> }
    const messages = body.messages ?? []
    calls.push({ system: messages[0]?.content ?? '', user: messages[1]?.content ?? '' })
    const content = answers[Math.min(calls.length - 1, answers.length - 1)] ?? ''
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content } }] }) }
  }) as unknown as typeof fetch
  return {
    calls,
    restore: () => { globalThis.fetch = original },
  }
}

const REQUEST: ChatRequestContext = {
  botDisplayName: '椰椰',
  mention: 'MENTIONED',
  requesterRole: 'MEMBER',
  ownerConfigured: false,
}

function question(text: string): GroupMessage {
  return { senderId: 'sender', senderName: 'MEMBER_1', text, timestamp: 1 }
}

function member(name: string, text: string): GroupMessage {
  return { senderId: name, senderName: name, text, timestamp: 1 }
}

const DETAILED_PROFILE: MemberInteractionProfile = {
  responseDepth: 'DETAILED',
  tone: 'NEUTRAL',
  emojiTolerance: 'LOW',
  addressFrequency: 'LOW',
  familiarity: 'FAMILIAR',
}

const NORMAL_PROFILE: MemberInteractionProfile = {
  responseDepth: 'NORMAL',
  tone: 'NEUTRAL',
  emojiTolerance: 'LOW',
  addressFrequency: 'LOW',
  familiarity: 'FAMILIAR',
}

const SHORT_PROFILE: MemberInteractionProfile = {
  responseDepth: 'SHORT',
  tone: 'NEUTRAL',
  emojiTolerance: 'LOW',
  addressFrequency: 'LOW',
  familiarity: 'FAMILIAR',
}

const STORY_CONTEXT: readonly string[] = [
  '我们来写一个群故事吧，第一章已经写完了',
  '剧情讲的是大家组队去海边的连载故事',
]
const TECH_CONTEXT: readonly string[] = [
  '我在调一个 Java 的空指针报错',
  '堆栈显示异常出在部署脚本里',
]

function classify(text: string, context?: readonly string[]): GroupConversationalRestraint {
  return resolveGroupConversationalRestraint({ questionText: text, recentContextTexts: context })
}

function expectMode(text: string, mode: GroupConversationalMode, context?: readonly string[]): void {
  const restraint = classify(text, context)
  assert.equal(restraint.mode, mode, `mode for ${text}`)
  assert.equal(restraint.currentIntentSource, 'CURRENT_TURN')
}

function expectContinuation(text: string, continuation: GroupContinuationResolution, context?: readonly string[]): void {
  const restraint = classify(text, context)
  assert.equal(restraint.continuation, continuation, `continuation for ${text}`)
}

await test('a-light-affection-stays-social-light', () => {
  expectMode('摸摸你', 'SOCIAL_LIGHT')
  expectMode('亲亲', 'SOCIAL_LIGHT')
  expectContinuation('摸摸你', 'NONE')
})

await test('b-laughter-stays-social-light', () => {
  expectMode('哈哈哈哈', 'SOCIAL_LIGHT')
  expectMode('笑死', 'SOCIAL_LIGHT')
  expectMode('好家伙', 'SOCIAL_LIGHT')
})

await test('short-reactions-and-punctuation-stay-social-light', () => {
  expectMode('6', 'SOCIAL_LIGHT')
  expectMode('666', 'SOCIAL_LIGHT')
  expectMode('？', 'SOCIAL_LIGHT')
  expectMode('你真可爱', 'SOCIAL_LIGHT')
  expectMode('😊😊', 'SOCIAL_LIGHT')
  expectMode('那我呢', 'SOCIAL_LIGHT')
})

await test('light-cue-does-not-override-a-task-marker', () => {
  expectMode('这个报错怎么看', 'TASK_NORMAL')
  expectMode('摸摸我的代码里这个函数', 'TASK_NORMAL')
  expectMode('了解一下 Redis 持久化', 'TASK_NORMAL')
})

await test('c-wo-ne-stays-social-light-for-roleplay-answer', () => {
  expectMode('我呢', 'SOCIAL_LIGHT')
})

await test('d-story-chapter-continuation-is-unique', () => {
  expectContinuation('第二章', 'UNIQUE', STORY_CONTEXT)
  expectMode('第二章', 'TASK_NORMAL', STORY_CONTEXT)
  expectContinuation('第三章', 'UNIQUE', STORY_CONTEXT)
})

await test('e-chapter-without-story-evidence-fails-closed-to-ambiguous', () => {
  expectContinuation('第二章', 'AMBIGUOUS', TECH_CONTEXT)
  expectContinuation('第二章', 'AMBIGUOUS')
})

await test('f-bare-continue-with-single-thread-is-unique', () => {
  expectContinuation('继续', 'UNIQUE', STORY_CONTEXT)
  expectContinuation('接着', 'UNIQUE', TECH_CONTEXT)
  expectContinuation('再来一个', 'UNIQUE', ['哈哈哈刚才那个笑话太好笑了'])
})

await test('g-bare-continue-with-two-threads-is-ambiguous', () => {
  expectContinuation('继续', 'AMBIGUOUS', [...STORY_CONTEXT, ...TECH_CONTEXT])
  expectContinuation('接着', 'AMBIGUOUS', [...STORY_CONTEXT, ...TECH_CONTEXT])
  expectContinuation('继续', 'AMBIGUOUS')
})

await test('continuation-cue-does-not-capture-full-questions', () => {
  expectContinuation('继续教育是什么', 'NONE')
  expectMode('继续教育是什么', 'TASK_NORMAL')
})

await test('h-delegated-next-chapter-stays-a-normal-task', () => {
  expectContinuation('下一章你自己安排谁开车', 'UNIQUE', STORY_CONTEXT)
  expectMode('下一章你自己安排谁开车', 'TASK_NORMAL', STORY_CONTEXT)
})

await test('j-broad-creative-request-stays-task-normal', () => {
  expectMode('给我们群每个人都编个角色', 'TASK_NORMAL')
  expectContinuation('给我们群每个人都编个角色', 'NONE')
})

await test('k-explicit-detail-request-is-task-detailed', () => {
  expectMode('详细解释 LangGraph checkpoint', 'TASK_DETAILED')
  expectMode('展开讲讲它的原理', 'TASK_DETAILED')
  expectMode('系统分析一下', 'TASK_DETAILED')
  expectMode('完整对比这两个框架', 'TASK_DETAILED')
  expectMode('逐步分析这个报错', 'TASK_DETAILED')
})

await test('l-casual-tech-question-is-task-normal', () => {
  expectMode('LangGraph checkpoint 是啥', 'TASK_NORMAL')
  expectContinuation('LangGraph checkpoint 是啥', 'NONE')
})

await test('m-code-request-is-task-normal', () => {
  expectMode('给我写个 Java 两数相加', 'TASK_NORMAL')
})

await test('n-o-current-turn-intent-is-the-only-mode-source', () => {
  // A history full of "以后回答详细一点" is just context text: it must not turn
  // "哈哈" into anything but SOCIAL_LIGHT, and "详细解释" must still be detailed.
  expectMode('哈哈', 'SOCIAL_LIGHT', ['以后回答详细一点', '你以后都给我详细讲'])
  expectContinuation('哈哈', 'NONE', ['以后回答详细一点'])
  expectMode('摸摸你', 'SOCIAL_LIGHT', ['以后回答详细一点'])
  expectMode('详细解释一下', 'TASK_DETAILED', ['以后回答简短一点'])
})

await test('p-owner-classification-is-role-blind', () => {
  expectMode('哈哈', 'SOCIAL_LIGHT')
})

await test('strip-trailing-group-cta-removes-one-plain-tail-sentence', () => {
  assert.equal(stripTrailingGroupCta('哈哈收到。要不要我继续给你写第二章？'), '哈哈收到。')
  assert.equal(stripTrailingGroupCta('好的。需要的话我还能展开讲。'), '好的。')
  assert.equal(stripTrailingGroupCta('摸摸你。\n\n要不要我继续讲下一章？'), '摸摸你。')
  assert.equal(stripTrailingGroupCta('你就当那个负责开车的。想看的话我再说。'), '你就当那个负责开车的。')
})

await test('strip-trailing-group-cta-is-conservative', () => {
  // Single-sentence replies are never rewritten.
  assert.equal(stripTrailingGroupCta('要不要我继续？'), '要不要我继续？')
  // Multi-sentence tails stay untouched: only the final plain sentence is
  // considered, and it does not match the fixed CTA phrases.
  assert.equal(stripTrailingGroupCta('哈哈。要不要我继续？我还能写。'), '哈哈。要不要我继续？我还能写。')
  // Quoted, code-bearing and list tails are never stripped.
  assert.equal(stripTrailingGroupCta('好的。要不要我继续「下一章」？'), '好的。要不要我继续「下一章」？')
  assert.equal(stripTrailingGroupCta('好的。要不要我继续？\n- 列表项'), '好的。要不要我继续？\n- 列表项')
  assert.equal(stripTrailingGroupCta('```\ncode here'), '```\ncode here')
  // Non-CTA tails are untouched.
  assert.equal(stripTrailingGroupCta('哈哈，笑死我了。'), '哈哈，笑死我了。')
})

await test('system-prompt-carries-the-restraint-rules', () => {
  const systemPrompt = buildSystemPrompt('椰椰')
  check(systemPrompt.includes('[GROUP Conversational Restraint]'), 'missing restraint rule block')
  check(systemPrompt.includes('One Request → One Requested Unit'), 'missing one-unit rule')
  check(systemPrompt.includes('不要主动扩展成新章节'), 'missing no-expansion rule')
  check(systemPrompt.includes('当前消息意图优先于历史偏好'), 'missing current-turn precedence')
})

await test('build-user-prompt-carries-deterministic-restraint-facts', () => {
  const prompt = buildUserPrompt(
    [member('MEMBER_2', '我们来写一个群故事吧，第一章写完了')],
    question('第二章'),
    { ...REQUEST, conversationType: 'GROUP' },
  )
  check(prompt.includes('[Group Conversational Restraint: TRUSTED_RUNTIME_FACT]'), 'missing restraint section')
  check(prompt.includes('mode=TASK_NORMAL'), 'missing mode line')
  check(prompt.includes('continuation=UNIQUE'), 'missing unique continuation')
  check(prompt.includes('currentIntentSource=CURRENT_TURN'), 'missing intent source')
})

await test('build-user-prompt-omits-restraint-for-direct', () => {
  const prompt = buildUserPrompt([], question('哈哈哈哈'), { ...REQUEST, conversationType: 'DIRECT' })
  check(!prompt.includes('[Group Conversational Restraint: TRUSTED_RUNTIME_FACT]'), 'DIRECT must not carry the restraint section')
})

await test('light-group-message-gets-the-social-light-facts', async () => {
  const provider = stubProvider(['哈哈，你也好可爱～'])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('哈哈哈哈'),
      { ...REQUEST, conversationType: 'GROUP', memberInteractionProfile: DETAILED_PROFILE },
    )
    check(provider.calls[0]?.user.includes('mode=SOCIAL_LIGHT'), 'SOCIAL_LIGHT facts missing from the prompt')
    check(provider.calls[0]?.system.includes('[GROUP Conversational Restraint]'), 'restraint rules missing from the system prompt')
    // N/O + A: a DETAILED profile must not flip the light message into the
    // detailed tier — the effective depth is converged to SHORT in the prompt.
    check(!provider.calls[0]?.user.includes('mode=TASK_DETAILED'), 'profile leaked into the restraint mode')
    check(provider.calls[0]?.user.includes('profileResponseDepth=DETAILED') === true, 'profile depth fact missing')
    check(provider.calls[0]?.user.includes('effectiveResponseDepth=SHORT') === true, 'effective depth not converged to SHORT')
    check(answer.includes('哈哈'), 'light reply lost its content')
  } finally {
    provider.restore()
  }
})

await test('a-light-reply-does-not-go-out-with-a-proactive-cta', async () => {
  const provider = stubProvider(['摸摸你啦。要不要我继续给你写个故事？'])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('摸摸你'),
      { ...REQUEST, conversationType: 'GROUP' },
    )
    assert.equal(answer, '摸摸你啦。')
    check(!answer.includes('要不要我继续'), 'proactive CTA survived the backstop')
  } finally {
    provider.restore()
  }
})

await test('q-direct-keeps-existing-behaviour-including-the-cta', async () => {
  const provider = stubProvider(['摸摸你啦。要不要我继续给你写个故事？'])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('摸摸你'),
      { ...REQUEST, conversationType: 'DIRECT', memberInteractionProfile: DETAILED_PROFILE },
    )
    assert.equal(answer, '摸摸你啦。要不要我继续给你写个故事？')
    check(!provider.calls[0]?.user.includes('[Group Conversational Restraint: TRUSTED_RUNTIME_FACT]'), 'restraint section leaked into DIRECT')
    // G. DIRECT keeps the historical profile depth untouched.
    check(provider.calls[0]?.user.includes('RESPONSE_DEPTH=DETAILED') === true, 'DIRECT lost the profile depth hint')
  } finally {
    provider.restore()
  }
})

await test('p-owner-gets-the-same-restraint-facts', async () => {
  const provider = stubProvider(['哈哈，收到～'])
  try {
    await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('哈哈'),
      { ...REQUEST, conversationType: 'GROUP', requesterRole: 'OWNER', memberInteractionProfile: DETAILED_PROFILE },
    )
    check(provider.calls[0]?.user.includes('mode=SOCIAL_LIGHT'), 'OWNER lost the SOCIAL_LIGHT facts')
    // F. OWNER does not get a historical-preference depth privilege either.
    check(provider.calls[0]?.user.includes('effectiveResponseDepth=SHORT') === true, 'OWNER effective depth not converged to SHORT')
  } finally {
    provider.restore()
  }
})

await test('continuation-facts-reach-the-user-prompt', async () => {
  const provider = stubProvider(['好，第二章来了。'])
  try {
    await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [member('MEMBER_2', '我们把群故事写下去吧，第一章讲海边旅行的剧情')],
      question('第二章'),
      { ...REQUEST, conversationType: 'GROUP' },
    )
    check(provider.calls[0]?.user.includes('continuation=UNIQUE'), 'UNIQUE continuation missing')
  } finally {
    provider.restore()
  }
})

await test('g-ambiguous-continuation-fact-reaches-the-user-prompt', async () => {
  const provider = stubProvider(['你想继续哪一个？'])
  try {
    await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [
        member('MEMBER_2', '我们把群故事写下去吧，第一章讲海边旅行的剧情'),
        member('MEMBER_3', '我这边还有一个 Java 报错要调'),
      ],
      question('继续'),
      { ...REQUEST, conversationType: 'GROUP' },
    )
    check(provider.calls[0]?.user.includes('continuation=AMBIGUOUS'), 'AMBIGUOUS continuation missing')
  } finally {
    provider.restore()
  }
})

await test('k-detailed-request-fact-reaches-the-user-prompt', async () => {
  const provider = stubProvider(['LangGraph checkpoint 是把图状态持久化的机制……'])
  try {
    await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('详细解释 LangGraph checkpoint'),
      { ...REQUEST, conversationType: 'GROUP' },
    )
    check(provider.calls[0]?.user.includes('mode=TASK_DETAILED'), 'TASK_DETAILED fact missing')
  } finally {
    provider.restore()
  }
})

await test('r-guard-regeneration-keeps-the-restraint-rules', async () => {
  const provider = stubProvider(['好的，我已经帮你记住了', '好的，收到～'])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('哈哈'),
      { ...REQUEST, conversationType: 'GROUP', memoryMutationThisTurn: 'NONE' },
    )
    assert.equal(provider.calls.length, 2)
    check(provider.calls[1]?.system.includes('[GROUP Conversational Restraint]'), 'rewrite system prompt lost the restraint rules')
    check(answer === '好的，收到～', 'regenerated answer was not used')
  } finally {
    provider.restore()
  }
})

await test('provider-control-repair-keeps-the-restraint-rules', async () => {
  const provider = stubProvider(['<tool_call>do_something</tool_call>', '好的，收到～'])
  try {
    await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('哈哈'),
      { ...REQUEST, conversationType: 'GROUP' },
    )
    assert.equal(provider.calls.length, 2)
    check(provider.calls[1]?.system.includes('[GROUP Conversational Restraint]'), 'provider-control repair prompt lost the restraint rules')
  } finally {
    provider.restore()
  }
})

await test('s-grounding-repair-carries-the-restraint-boundary', async () => {
  const longUngrounded = Array.from({ length: 14 }, (_, index) =>
    `第${index + 1}点，模型能力扩张与安全协作同步推进，相关计划仍在评估之中。`,
  ).join('')
  const grounded = Array.from({ length: 10 }, (_, index) =>
    `第${index + 1}点，最新报道确认模型能力扩张与安全协作同步推进[S1]。`,
  ).join('')
  const provider = stubProvider([longUngrounded, grounded])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('LangGraph checkpoint 是啥'),
      {
        ...REQUEST,
        conversationType: 'GROUP',
        webSearch: { used: true, status: 'PASS', results: [{ sourceId: 'S1', title: '资料', url: 'https://example.com/source', snippet: '摘要' }] },
      },
    )
    assert.equal(provider.calls.length, 2)
    check(provider.calls[1]?.system.includes('不要借机扩大任务范围、不要追加主动 CTA'), 'grounding repair prompt lost the restraint boundary')
    check(!answer.includes('[S1]'), 'source markers leaked into the outbound')
  } finally {
    provider.restore()
  }
})

await test('restraint-diagnostic-is-emitted-for-group-turns', async () => {
  const lines: string[] = []
  const original = console.log
  console.log = (line?: unknown): void => { lines.push(String(line)) }
  try {
    const provider = stubProvider(['哈哈，收到～'])
    try {
      await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
        [],
        question('哈哈哈哈'),
        { ...REQUEST, conversationType: 'GROUP' },
      )
    } finally {
      provider.restore()
    }
  } finally {
    console.log = original
  }
  const line = lines.find((candidate) => candidate.includes('[GROUP_CONVERSATIONAL_RESTRAINT]'))
  check(line !== undefined, 'missing GROUP_CONVERSATIONAL_RESTRAINT diagnostic')
  check(line?.includes('mode=SOCIAL_LIGHT') === true, `bad mode in diagnostic: ${line}`)
  check(line?.includes('currentIntentSource=CURRENT_TURN') === true, `bad intent source in diagnostic: ${line}`)
  check(line?.includes('continuation=NONE') === true, `bad continuation in diagnostic: ${line}`)
  check(line?.includes('result=APPLIED') === true, `bad result in diagnostic: ${line}`)
  check(!lines.some((candidate) => candidate.includes('[GROUP_CONVERSATIONAL_RESTRAINT] 原始')), 'diagnostic must not carry raw content')
})

await test('resolve-effective-group-response-depth-maps-each-mode', () => {
  assert.equal(resolveEffectiveGroupResponseDepth('SOCIAL_LIGHT'), 'SHORT')
  assert.equal(resolveEffectiveGroupResponseDepth('TASK_NORMAL'), 'NORMAL')
  assert.equal(resolveEffectiveGroupResponseDepth('TASK_DETAILED'), 'DETAILED')
})

await test('a-b-social-light-converges-historical-detailed-to-short-within-500', async () => {
  for (const text of ['哈哈', '摸摸你']) {
    const provider = stubProvider(['汉'.repeat(800)])
    try {
      const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
        [],
        question(text),
        { ...REQUEST, conversationType: 'GROUP', memberInteractionProfile: DETAILED_PROFILE },
      )
      // K. the SOCIAL_LIGHT turn never gets the DETAILED 900 hard cap.
      check(answer.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `${text} outbound exceeded the NORMAL hard cap: ${answer.length}`)
      check(provider.calls[0]?.user.includes('mode=SOCIAL_LIGHT') === true, `${text} mode fact missing`)
      check(provider.calls[0]?.user.includes('profileResponseDepth=DETAILED') === true, `${text} profile depth fact missing`)
      check(provider.calls[0]?.user.includes('effectiveResponseDepth=SHORT') === true, `${text} effective depth not SHORT`)
      check(provider.calls[0]?.user.includes('RESPONSE_DEPTH=DETAILED') === true, `${text} profile hint was deleted instead of converged`)
    } finally {
      provider.restore()
    }
  }
})

await test('a-social-light-social-boundary-stays-on-the-normal-tier', async () => {
  const lines: string[] = []
  const original = console.log
  console.log = (line?: unknown): void => { lines.push(String(line)) }
  try {
    const provider = stubProvider(['汉'.repeat(800)])
    try {
      await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
        [],
        question('哈哈'),
        { ...REQUEST, conversationType: 'GROUP', memberInteractionProfile: DETAILED_PROFILE },
      )
    } finally {
      provider.restore()
    }
  } finally {
    console.log = original
  }
  const finalSocial = lines.filter((line) => line.includes('[GROUP_SOCIAL_OUTPUT_BOUNDARY]') && line.includes('stage=FINAL_OUTBOUND'))
  check(finalSocial.length > 0, 'missing final-outbound social diagnostic')
  check(finalSocial.every((line) => line.includes('responseDepth=NORMAL')), `social boundary stayed on DETAILED: ${finalSocial[0]}`)
})

await test('c-task-normal-converges-historical-detailed-to-normal', async () => {
  const provider = stubProvider(['汉'.repeat(800)])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('LangGraph checkpoint 是啥'),
      { ...REQUEST, conversationType: 'GROUP', memberInteractionProfile: DETAILED_PROFILE },
    )
    check(answer.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `TASK_NORMAL outbound exceeded the NORMAL hard cap: ${answer.length}`)
    check(provider.calls[0]?.user.includes('mode=TASK_NORMAL') === true, 'mode fact missing')
    check(provider.calls[0]?.user.includes('profileResponseDepth=DETAILED') === true, 'profile depth fact missing')
    check(provider.calls[0]?.user.includes('effectiveResponseDepth=NORMAL') === true, 'effective depth not NORMAL')
    check(!provider.calls[0]?.user.includes('effectiveResponseDepth=DETAILED'), 'historical profile escalated a TASK_NORMAL turn')
  } finally {
    provider.restore()
  }
})

await test('d-l-task-detailed-reaches-the-detailed-tier', async () => {
  const provider = stubProvider(['汉'.repeat(2000)])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('详细解释 LangGraph checkpoint'),
      { ...REQUEST, conversationType: 'GROUP', memberInteractionProfile: NORMAL_PROFILE },
    )
    check(provider.calls[0]?.user.includes('mode=TASK_DETAILED') === true, 'TASK_DETAILED fact missing')
    check(provider.calls[0]?.user.includes('profileResponseDepth=NORMAL') === true, 'profile depth fact missing')
    check(provider.calls[0]?.user.includes('effectiveResponseDepth=DETAILED') === true, 'effective depth not DETAILED')
    check(answer.length > GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, 'DETAILED tier collapsed to NORMAL')
    check(answer.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `DETAILED outbound exceeded the hard cap: ${answer.length}`)
  } finally {
    provider.restore()
  }
})

await test('e-current-turn-detail-override-historical-short', async () => {
  const provider = stubProvider(['好的，系统分析如下。'])
  try {
    await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('系统详细分析一下'),
      { ...REQUEST, conversationType: 'GROUP', memberInteractionProfile: SHORT_PROFILE },
    )
    check(provider.calls[0]?.user.includes('mode=TASK_DETAILED') === true, 'TASK_DETAILED fact missing')
    check(provider.calls[0]?.user.includes('profileResponseDepth=SHORT') === true, 'profile depth fact missing')
    check(provider.calls[0]?.user.includes('effectiveResponseDepth=DETAILED') === true, 'current-turn intent did not override SHORT')
  } finally {
    provider.restore()
  }
})

await test('h-guard-regeneration-uses-the-converged-effective-depth', async () => {
  const provider = stubProvider(['好的，我已经帮你记住了', '好的，收到～'])
  try {
    await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('哈哈'),
      { ...REQUEST, conversationType: 'GROUP', memberInteractionProfile: DETAILED_PROFILE, memoryMutationThisTurn: 'NONE' },
    )
    assert.equal(provider.calls.length, 2)
    check(provider.calls[1]?.user.includes('effectiveResponseDepth=SHORT') === true, 'rewrite prompt re-read the historical DETAILED profile')
    check(!provider.calls[1]?.user.includes('effectiveResponseDepth=DETAILED'), 'rewrite prompt escalated the light turn')
  } finally {
    provider.restore()
  }
})

await test('i-provider-control-repair-uses-the-converged-effective-depth', async () => {
  const provider = stubProvider(['<tool_call>do_something</tool_call>', '好的，收到～'])
  try {
    await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('哈哈'),
      { ...REQUEST, conversationType: 'GROUP', memberInteractionProfile: DETAILED_PROFILE },
    )
    assert.equal(provider.calls.length, 2)
    check(provider.calls[1]?.user.includes('effectiveResponseDepth=SHORT') === true, 'repair prompt re-read the historical DETAILED profile')
  } finally {
    provider.restore()
  }
})

await test('j-grounding-repair-uses-the-converged-effective-depth', async () => {
  const longUngrounded = Array.from({ length: 14 }, (_, index) =>
    `第${index + 1}点，模型能力扩张与安全协作同步推进，相关计划仍在评估之中。`,
  ).join('')
  const grounded = Array.from({ length: 10 }, (_, index) =>
    `第${index + 1}点，最新报道确认模型能力扩张与安全协作同步推进[S1]。`,
  ).join('')
  const provider = stubProvider([longUngrounded, grounded])
  try {
    await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      question('LangGraph checkpoint 是啥'),
      {
        ...REQUEST,
        conversationType: 'GROUP',
        memberInteractionProfile: DETAILED_PROFILE,
        webSearch: { used: true, status: 'PASS', results: [{ sourceId: 'S1', title: '资料', url: 'https://example.com/source', snippet: '摘要' }] },
      },
    )
    assert.equal(provider.calls.length, 2)
    check(provider.calls[1]?.user.includes('effectiveResponseDepth=NORMAL') === true, 'grounding repair prompt re-read the historical DETAILED profile')
    check(!provider.calls[1]?.user.includes('effectiveResponseDepth=DETAILED'), 'grounding repair prompt escalated the TASK_NORMAL turn')
  } finally {
    provider.restore()
  }
})

console.log(`[GROUP_RESTRAINT_SUMMARY] cases=${cases} failures=${failures}`)
if (failures > 0) {
  process.exitCode = 1
}
