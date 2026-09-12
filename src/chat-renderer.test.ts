import { strict as assert } from 'node:assert'
import { buildUserPrompt, ChatService, type ChatRequestContext } from './chat.js'
import { appendGroundedSources, type WebSearchResult } from './web-search.js'
import { renderHumanChat } from './chat-renderer.js'

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
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

const QUESTION = { senderId: 'sender', senderName: 'MEMBER_1', text: '你好', timestamp: 1 }
const REQUEST: ChatRequestContext = {
  botDisplayName: '椰椰',
  mention: 'MENTIONED',
  requesterRole: 'MEMBER',
  ownerConfigured: false,
}

async function runCase(name: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body()
    console.log(`[CHAT_RENDERER_CASE] name=${name} result=PASS`)
  } catch (error) {
    console.log(`[CHAT_RENDERER_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

await runCase('simple-chat-is-unchanged', () => {
  const answer = '嗯，这个可以。'
  assert.equal(renderHumanChat(answer), answer)
})

await runCase('decorative-markdown-is-normalized', () => {
  const rendered = renderHumanChat('**刚查了下**\n## 最近动态\n\n\n\n- **第一条**\n1. __第二条__')
  assert.equal(rendered, '刚查了下\n最近动态\n\n- 第一条\n1. 第二条')
})

await runCase('code-block-is-preserved-byte-for-byte', () => {
  const code = '```python\r\nx = "**hello**"\r\n# heading\r\n[S1] https://example.com\r\n```'
  const input = `**刚查了下**\r\n${code}\r\n\r\nhttps://example.com/source [S1]`
  const rendered = renderHumanChat(input)
  check(rendered.includes(code), 'fenced code block changed')
  check(rendered.includes('刚查了下\r\n'), 'outside heading was not normalized')
  check(rendered.includes('https://example.com/source [S1]'), 'URL or source id was changed')
})

await runCase('source-grounding-happens-after-renderer', () => {
  const results: WebSearchResult[] = [{ sourceId: 'S1', title: '真实来源', url: 'https://real.example/source', snippet: '摘要' }]
  const rendered = renderHumanChat('刚查了下 **这个比较重要** [S1]')
  const grounded = appendGroundedSources(rendered, results)
  assert(!grounded.includes('**'), 'renderer left decorative bold markup')
  check(grounded.includes('这个比较重要') && !grounded.includes('[S1]'), 'internal source id remained visible')
  check(grounded.includes('https://real.example/source'), 'runtime source URL was not appended')
})

await runCase('provider-control-regeneration-uses-renderer', async () => {
  const provider = stubProvider([
    '<|minimax|><tool_call>blocked</tool_call>',
    '# 已处理\n**可以**',
  ])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply([], QUESTION, REQUEST)
    assert.equal(answer, '已处理\n可以')
    assert.equal(provider.calls.length, 2)
  } finally {
    provider.restore()
  }
})

await runCase('answer-guard-regeneration-uses-renderer', async () => {
  const provider = stubProvider([
    '你就是 MEMBER_1。',
    '## 安全回复\n**可以**',
  ])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [{ senderId: 'other', senderName: 'MEMBER_1', text: '之前的话', timestamp: 1 }],
      { ...QUESTION, senderName: 'MEMBER_2' },
      { ...REQUEST, currentSpeakerLabel: 'MEMBER_2' },
    )
    assert.equal(answer, '安全回复\n可以')
    assert.equal(provider.calls.length, 2)
  } finally {
    provider.restore()
  }
})

await runCase('chat-service-renders-before-grounded-source-append', async () => {
  const provider = stubProvider(['刚查了下 **这个比较重要** [S1]'])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      QUESTION,
      {
        ...REQUEST,
        webSearch: {
          used: true,
          status: 'PASS',
          results: [{ sourceId: 'S1', title: '真实来源', url: 'https://real.example/source', snippet: '摘要' }],
        },
      },
    )
    check(answer.startsWith('刚查了下 这个比较重要') && !answer.includes('[S1]'), 'renderer did not run before internal source cleanup')
    check(answer.includes('https://real.example/source'), 'grounded source was lost')
  } finally {
    provider.restore()
  }
})

await runCase('runtime-time-and-memory-prompt-contract-remains', () => {
  // The existing prompt contract is exercised here with the new optional layer
  // absent: the renderer must not require or alter runtime facts and memory.
  const rendered = buildUserPrompt([], QUESTION, {
    ...REQUEST,
    memory: [{ scope: 'PERSONAL', content: '用户代号 AlphaTest' }],
    runtimeTime: {
      utcIso: '2026-09-11T00:00:00.000Z',
      localDate: '2026-09-11',
      localDateTime: '2026-09-11T08:00:00',
      timeZone: 'Asia/Shanghai',
    },
  })
  check(rendered.includes('用户代号 AlphaTest'), 'memory prompt contract regressed')
  check(rendered.includes('CURRENT_TIME_UTC=2026-09-11T00:00:00.000Z'), 'runtime time prompt contract regressed')
})

console.log('[CHAT_RENDERER_TEST_SUMMARY] result=' + (process.exitCode === 1 ? 'FAIL' : 'PASS'))
