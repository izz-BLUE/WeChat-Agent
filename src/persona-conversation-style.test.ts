import { strict as assert } from 'node:assert'
import { buildSystemPrompt, ChatService, type ChatRequestContext } from './chat.js'

let cases = 0
let failures = 0
const systemPrompt = buildSystemPrompt('椰椰')

function includes(...terms: string[]): void {
  for (const term of terms) assert(systemPrompt.includes(term), `system prompt missing persona contract: ${term}`)
}

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  cases += 1
  try {
    await body()
    console.log(`[PERSONA_CONVERSATION_STYLE_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(`[PERSONA_CONVERSATION_STYLE_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
  }
}

await test('default-direct-answer', () => {
  includes('先直接回答', '不使用客服式开场', '能直接回答就不要先铺垫')
})

await test('top-level-identity-is-an-ai-group-member', () => {
  assert(systemPrompt.startsWith('你是微信群里的 AI 成员「椰椰」。'))
  assert(!systemPrompt.includes('微信群中的 AI 聊天助手'))
  assert(!systemPrompt.includes('AI 聊天助手'))
})

await test('no-automatic-understanding-preface', () => {
  includes('不重复用户问题', '不先礼貌确认再回答', '“我理解你的意思”“当然可以”“没问题”不作为自动开场')
})

await test('no-automatic-offer-to-help-more', () => {
  includes('默认满足当前请求后停止', '“如果你需要，我还可以……”', '不作为自动收尾')
})

await test('simple-answer-is-concise', () => {
  includes('简单问题优先 1～3 句', '普通问答保持短段落')
})

await test('do-not-over-explain', () => {
  includes('用户未要求详细分析时，不主动展开成长篇')
})

await test('light-humor-is-contextual', () => {
  includes('可以偶尔轻微幽默、接梗或吐槽', '普通闲聊可以轻微接梗')
})

await test('serious-context-reduces-humor', () => {
  includes('严肃、敏感或用户明显焦虑时收敛幽默', '不强行活跃气氛')
})

await test('technical-directness', () => {
  includes('技术讨论先给结论，再给必要证据，最后才给操作')
})

await test('repetitive-agreement-is-not-default', () => {
  includes('不把“对的”“没错”“确实如此”“你这个判断很准确”等无信息附和当作固定开场')
})

await test('no-forced-cute-persona', () => {
  includes('不能强行玩梗、攻击成员或把可爱当成固定表演', '不强行卖萌')
})

await test('no-fixed-emoji-or-catchphrase', () => {
  includes('不要固定重复口头禅', '不强行卖萌', '“哈哈”、都“～”、都“辞老师”或都使用 emoji')
})

await test('uncertainty-honesty', () => {
  includes('没有证据就直接说不确定', '有证据再下结论；不能确定就直接说不确定')
})

await test('stop-after-satisfying-request', () => {
  includes('默认满足当前请求后停止')
})

await test('response-depth-priority-is-unified', () => {
  includes(
    '当前消息明确要求/任务客观需要 > 必要事实完整性与安全 > 当前请求者明确个人偏好 > 当前请求者近期结构 hint > Group Reply Pressure 与群聊 presentation hints > Persona default',
    '群体风格本身不能把简单问题升级为 DETAILED',
  )
})

await test('simple-question-can-stay-compact-under-pressure-contract', () => {
  includes('简单问题优先 1～3 句', 'GROUP_REPLY_PRESSURE=HIGH')
})

await test('lists-only-when-useful', () => {
  includes('不自动把普通聊天写成 listicle', '只有用户明确要求步骤/条目')
})

await test('provocation-does-not-escalate', () => {
  includes('被挑衅时不升级冲突', '不输出“请保持礼貌”式客服训话')
})

await test('group-style-cannot-cross-persona-boundaries', () => {
  includes('只能在 Persona baseline 允许范围内调整', '不能覆盖安全、事实、隐私或不强行卖萌的边界')
})

await test('normal-turn-keeps-one-provider-call', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: '主要卡在这里。' } }] }),
    }
  }) as unknown as typeof fetch

  const request: ChatRequestContext = {
    botDisplayName: '椰椰',
    conversationType: 'GROUP',
    mention: 'MENTIONED',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
  }
  try {
    const reply = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      { senderId: 'member', senderName: 'MEMBER_1', text: '这个是不是 A 的问题？', timestamp: 1 },
      request,
    )
    assert.equal(reply, '主要卡在这里。')
    assert.equal(calls, 1, 'persona prompt change introduced an extra provider call')
  } finally {
    globalThis.fetch = originalFetch
  }
})

console.log(`[PERSONA_CONVERSATION_STYLE_TEST_SUMMARY] cases=${cases} failures=${failures}`)
if (failures > 0) process.exitCode = 1
