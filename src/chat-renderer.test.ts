import { strict as assert } from 'node:assert'
import { buildUserPrompt, ChatService, type ChatRequestContext } from './chat.js'
import { appendGroundedSources, type WebSearchResult } from './web-search.js'
import { decorateYeyeReplySignature, renderHumanChat, YEYE_REPLY_SIGNATURE } from './chat-renderer.js'
import type { AgentRequest } from './agent-adapter.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import { GroupAmbientContext } from './group-ambient-context.js'
import { RequestDeadlineExceededError } from './request-deadline.js'

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

const SIGNATURE_REQUEST: AgentRequest = {
  conversationKey: 'group:renderer-signature@chatroom',
  messageId: 'renderer-signature-request',
  conversationType: 'GROUP',
  conversationId: 'renderer-signature@chatroom',
  senderId: 'renderer-sender',
  requesterId: 'renderer-sender',
  requesterSource: 'TEST',
  requesterRole: 'MEMBER',
  ownerConfigured: false,
  ownerDisplayName: null,
  publicDisplayName: '测试成员',
  senderName: '测试成员',
  text: '你好',
  rawText: '你好',
  timestamp: 1,
  mentionState: 'MENTIONED',
  botMentionSpans: { trust: 'VALID', spans: [] },
  userContentSpan: { trust: 'VALID', span: { start: 0, length: 2 } },
  metadata: { rawMessageType: 1 },
}

function chatReturning(answer: string): ChatService {
  const chat = new ChatService('https://provider.invalid/v1', 'key', 'model')
  chat.reply = async () => answer
  return chat
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

await runCase('signature-is-sentence-level-and-deterministic', () => {
  assert.equal(
    decorateYeyeReplySignature('你好。今天继续测试！准备好了吗？\nThat works! Really?'),
    `你好。${YEYE_REPLY_SIGNATURE}今天继续测试！${YEYE_REPLY_SIGNATURE}准备好了吗？${YEYE_REPLY_SIGNATURE}\nThat works!${YEYE_REPLY_SIGNATURE} Really?${YEYE_REPLY_SIGNATURE}`,
  )
  assert.equal(decorateYeyeReplySignature('知道了'), `知道了${YEYE_REPLY_SIGNATURE}`)
})

await runCase('signature-is-idempotent-and-empty-safe', () => {
  const answer = `知道啦。${YEYE_REPLY_SIGNATURE}`
  assert.equal(decorateYeyeReplySignature(answer), answer)
  assert.equal(decorateYeyeReplySignature(decorateYeyeReplySignature(answer)), answer)
  assert.equal(decorateYeyeReplySignature(''), '')
  assert.equal(decorateYeyeReplySignature('   '), '')
})

await runCase('signature-preserves-protected-content', () => {
  const code = '```js\nconst x = 1;\n```'
  const sourceList = '来源：\n1. 真实来源 https://example.com'
  assert.equal(decorateYeyeReplySignature(code), code)
  assert.equal(decorateYeyeReplySignature('请运行 `const x = 1;`。'), `请运行 \`const x = 1;\`。${YEYE_REPLY_SIGNATURE}`)
  assert.equal(decorateYeyeReplySignature('https://example.com'), 'https://example.com')
  assert.equal(decorateYeyeReplySignature('结论成立。[S1]'), `结论成立。${YEYE_REPLY_SIGNATURE} [S1]`)
  assert.equal(decorateYeyeReplySignature('- 第一条说明。\n1. 第二条说明？'), `- 第一条说明。${YEYE_REPLY_SIGNATURE}\n1. 第二条说明？${YEYE_REPLY_SIGNATURE}`)
  assert.equal(decorateYeyeReplySignature(sourceList), sourceList)
  assert.equal(decorateYeyeReplySignature('const x = 1;'), 'const x = 1;')
  assert.equal(decorateYeyeReplySignature('{"answer":"hello"}'), '{"answer":"hello"}')
  assert.equal(decorateYeyeReplySignature('$ npm run build'), '$ npm run build')
  assert.equal(decorateYeyeReplySignature('Error: request failed'), 'Error: request failed')
})

await runCase('production-final-and-staged-outbound-use-one-signed-text', async () => {
  const ambient = new GroupAmbientContext({ now: () => 1 })
  const agent = new ProductionChatAgent(chatReturning('你好。'), { ambientContext: ambient })
  const answer = await agent.complete(SIGNATURE_REQUEST)
  assert.equal(answer, `你好。${YEYE_REPLY_SIGNATURE}`)
  const identity = agent.takeOutboundIdentity(SIGNATURE_REQUEST, answer)
  check(identity !== null, 'signed answer was not staged')
  const ack = agent.observeOutboundDelivery({
    ...identity,
    status: 'SENT',
    errorCode: '',
  })
  assert.equal(ack.accepted, true)
  assert.equal(ambient.entries(SIGNATURE_REQUEST.conversationId).find((line) => line.speakerType === 'ASSISTANT')?.text, answer)
})

await runCase('production-decorates-deadline-fallback-and-keeps-owner-empty', async () => {
  const failingChat = chatReturning('never sent')
  failingChat.reply = async () => { throw new RequestDeadlineExceededError('FINAL_ANSWER') }
  const agent = new ProductionChatAgent(failingChat, { requestDeadlineMs: 500 })
  const fallback = await agent.complete({ ...SIGNATURE_REQUEST, messageId: 'renderer-deadline-request' })
  assert.equal(fallback, `这次处理有点超时了，稍后再问我一次。${YEYE_REPLY_SIGNATURE}`)

  const ownerEmpty = await new ProductionChatAgent(chatReturning('must not chat')).complete({
    ...SIGNATURE_REQUEST,
    messageId: 'renderer-owner-request',
    conversationType: 'DIRECT',
    conversationKey: 'direct:owner',
    conversationId: 'owner-account@chatroom',
    senderId: 'owner-account',
    requesterId: 'owner-account',
    requesterSource: 'DIRECT_OWNER_FIELD_VERIFIED',
    requesterRole: 'OWNER',
    ownerConfigured: true,
    mentionState: 'NOT_MENTIONED',
    botMentionSpans: undefined,
    userContentSpan: undefined,
  })
  assert.equal(ownerEmpty, '')
})

await runCase('production-decorates-memory-and-grounding-safe-replies', async () => {
  const selfAddressAgent = new ProductionChatAgent(chatReturning('must not reach final chat'), {
    memory: {
      tryHandleSelfAddressPreference: () => ({ handled: true, reply: '好，以后叫你公主。' }),
      tryHandleExplicit: async () => ({ handled: false, reply: '' }),
    } as never,
  })
  assert.equal(await selfAddressAgent.complete(SIGNATURE_REQUEST), `好，以后叫你公主。${YEYE_REPLY_SIGNATURE}`)

  const explicitMemoryAgent = new ProductionChatAgent(chatReturning('must not reach final chat'), {
    memory: {
      tryHandleSelfAddressPreference: () => ({ handled: false, reply: '' }),
      tryHandleExplicit: async () => ({ handled: true, reply: '已处理记忆。' }),
    } as never,
  })
  assert.equal(await explicitMemoryAgent.complete({ ...SIGNATURE_REQUEST, messageId: 'renderer-explicit-memory-request' }), `已处理记忆。${YEYE_REPLY_SIGNATURE}`)

  const groundingFailureAgent = new ProductionChatAgent(
    chatReturning('我查到了些资料，但这次没法可靠对应到具体来源，先不乱下结论。'),
  )
  assert.equal(
    await groundingFailureAgent.complete({ ...SIGNATURE_REQUEST, messageId: 'renderer-grounding-failure-request' }),
    `我查到了些资料，但这次没法可靠对应到具体来源，先不乱下结论。${YEYE_REPLY_SIGNATURE}`,
  )
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
