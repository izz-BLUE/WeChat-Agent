import { strict as assert } from 'node:assert'
import { buildSystemPrompt, buildUserPrompt, ChatService, type ChatRequestContext } from './chat.js'
import { WEB_SEARCH_FAILURE_DISCLOSURE } from './chat.js'
import { appendGroundedSources, type WebSearchResult } from './web-search.js'
import {
  boundGroupBulkOutput,
  boundGroupReply,
  boundGroupSocialOutput,
  decorateYeyeReplySignature,
  GROUP_BULK_OUTPUT_FALLBACK,
  GROUP_REPLY_LENGTH_BUDGETS,
  GROUP_REPLY_SIGNATURE_RESERVE_CHARS,
  GROUP_SOCIAL_CLOSING_TAIL,
  GROUP_SOCIAL_COMPACT_FALLBACK,
  GROUP_SOCIAL_OUTPUT_BUDGETS,
  renderHumanChat,
  YEYE_REPLY_SIGNATURE,
} from './chat-renderer.js'
import type { AgentRequest } from './agent-adapter.js'
import type { MemberInteractionProfile } from './member-interaction-profile.js'
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
// Depth convergence: a historical DETAILED profile alone no longer selects the
// DETAILED social tier — the cases below exercise the DETAILED budget through an
// explicit current-turn detailed request instead.
const DETAILED_QUESTION = { ...QUESTION, text: '详细讲讲最新的模型动态' }
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

const LARGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg">\n${'<path d="M0 0 L10 10" />\n'.repeat(120)}</svg>`

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

await runCase('signature-is-reply-level-and-deterministic', () => {
  assert.equal(
    decorateYeyeReplySignature('你好。今天继续测试！准备好了吗？\nThat works! Really?'),
    `你好。今天继续测试！准备好了吗？\nThat works! Really?${YEYE_REPLY_SIGNATURE}`,
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
  assert.equal(decorateYeyeReplySignature('- 第一条说明。\n1. 第二条说明？'), `- 第一条说明。\n1. 第二条说明？${YEYE_REPLY_SIGNATURE}`)
  assert.equal(decorateYeyeReplySignature(sourceList), sourceList)
  assert.equal(decorateYeyeReplySignature('const x = 1;'), 'const x = 1;')
  assert.equal(decorateYeyeReplySignature('{"answer":"hello"}'), '{"answer":"hello"}')
  assert.equal(decorateYeyeReplySignature('$ npm run build'), '$ npm run build')
  assert.equal(decorateYeyeReplySignature('Error: request failed'), 'Error: request failed')
})

await runCase('reply-level-signature-covers-grounded-and-structural-cases', () => {
  const results: WebSearchResult[] = [{ sourceId: 'S1', title: '真实来源', url: 'https://real.example/source', snippet: '摘要' }]
  const grounded = appendGroundedSources('正文第一句。正文第二句。[S1]', results)
  const decorated = decorateYeyeReplySignature(grounded)
  assert.equal(decorated.match(new RegExp(YEYE_REPLY_SIGNATURE, 'gu'))?.length, 1)
  check(decorated.startsWith('正文第一句。正文第二句。'), 'grounded answer changed unexpectedly')
  check(!decorated.includes('[S1]') && !decorated.includes('来源：') && !decorated.includes('https://real.example/source'), 'internal source presentation remained visible')

  const codeOnly = '```ts\nconst answer = "你好。";\n```\nhttps://example.com/source [S1]'
  assert.equal(decorateYeyeReplySignature(codeOnly), codeOnly)
  assert.equal(decorateYeyeReplySignature(decorateYeyeReplySignature('第一段。\n\n第二段。')).match(new RegExp(YEYE_REPLY_SIGNATURE, 'gu'))?.length, 1)
  assert.equal(decorateYeyeReplySignature(`正文。${YEYE_REPLY_SIGNATURE}`), `正文。${YEYE_REPLY_SIGNATURE}`)
  assert.equal(
    decorateYeyeReplySignature('请看 `const x = 1;`，或访问 https://example.com/a?x=1。'),
    `请看 \`const x = 1;\`，或访问 https://example.com/a?x=1。${YEYE_REPLY_SIGNATURE}`,
  )
})

await runCase('group-reply-length-boundary-is-safe-and-profile-driven', () => {
  const longStory = Array.from({ length: 20 }, (_, index) => `第${index + 1}段先交代气氛，然后推进人物关系，最后留下一个完整的转折。`).join('\n\n')
  const shortHigh = boundGroupReply(longStory, { responseDepth: 'SHORT', groupReplyPressure: 'HIGH' })
  check(shortHigh.bounded, 'SHORT + HIGH did not apply the fallback boundary')
  check(shortHigh.afterChars <= GROUP_REPLY_LENGTH_BUDGETS.SHORT.HIGH, 'SHORT + HIGH exceeded its budget')
  check(/[。！？]$/u.test(shortHigh.text), 'Chinese boundary cut did not end at sentence punctuation')

  const normalHigh = boundGroupReply(longStory, { responseDepth: 'NORMAL', groupReplyPressure: 'HIGH' })
  const normalMedium = boundGroupReply(longStory, { responseDepth: 'NORMAL', groupReplyPressure: 'MEDIUM' })
  check(normalHigh.bounded && normalHigh.afterChars < longStory.length, 'NORMAL + HIGH did not reduce the runaway reply')
  check(normalMedium.afterChars > normalHigh.afterChars, 'MEDIUM pressure did not allow a wider ordinary reply')

  const detailed = boundGroupReply(longStory, { responseDepth: 'DETAILED', groupReplyPressure: 'HIGH' })
  check(
    !detailed.bounded && detailed.boundaryType === 'NONE' && detailed.socialOutput?.result === 'PASS',
    'DETAILED story inside the social budget was mechanically compressed',
  )

  const shortReply = boundGroupReply('收到。', { responseDepth: 'SHORT', groupReplyPressure: 'HIGH' })
  assert.equal(shortReply.text, '收到。')

  const english = boundGroupReply('First sentence is complete. Second sentence is also complete. Third sentence keeps going without a cut. Fourth sentence is deliberately beyond the compact reply budget.', {
    responseDepth: 'SHORT',
    groupReplyPressure: 'HIGH',
  })
  check(english.bounded && english.text.endsWith('.'), 'English sentence boundary was not preserved')

  const fenced = `前置说明。\n\n\`\`\`js\n${'const item = 1;\n'.repeat(40)}\`\`\``
  const codeResult = boundGroupReply(fenced, { responseDepth: 'SHORT', groupReplyPressure: 'HIGH' })
  assert.equal(codeResult.boundaryType, 'BULK_OUTPUT_BLOCKED')
  assert.equal(codeResult.bulkOutput?.kind, 'FENCED_CODE')
  assert.equal(codeResult.text, GROUP_BULK_OUTPUT_FALLBACK)

  const searched = boundGroupReply(`${'搜索结论先说清楚。'.repeat(8)}[S1]\n\n后续展开。`, {
    responseDepth: 'NORMAL',
    groupReplyPressure: 'HIGH',
  })
  check(searched.text.includes('[S1]'), 'safe bound dropped the source citation')
  check(!searched.text.endsWith('搜'), 'safe bound cut a Chinese sentence')
})

await runCase('group-bulk-classifier-keeps-small-code-and-blocks-structured-payloads', () => {
  const smallCode = `int add(int a, int b) {\n    int result = a + b;\n    if (result < 0) {\n        return 0;\n    }\n    return result;\n}\n// still a small example\nint twice(int value) {\n    return value * 2;\n}`
  const small = boundGroupBulkOutput(smallCode)
  assert.equal(small.result, 'PASS')
  assert.equal(small.kind, 'NONE')

  const fenced = boundGroupBulkOutput(`\`\`\`js\n${'const item = 1;\n'.repeat(100)}\`\`\``)
  assert.equal(fenced.kind, 'FENCED_CODE')
  assert.equal(fenced.result, 'BLOCKED')
  assert.equal(fenced.text, GROUP_BULK_OUTPUT_FALLBACK)

  const svg = `<svg xmlns="http://www.w3.org/2000/svg">\n${'<path d="M0 0 L10 10" />\n'.repeat(80)}</svg>`
  const markup = boundGroupBulkOutput(svg)
  assert.equal(markup.kind, 'STRUCTURED_MARKUP')
  assert.equal(markup.result, 'BLOCKED')
  check(!markup.text.includes('<svg'), 'blocked SVG leaked into fallback')

  const smallJson = boundGroupBulkOutput('{"ok":true,"items":[1,2,3]}')
  assert.equal(smallJson.result, 'PASS')
  const largeJson = boundGroupBulkOutput(JSON.stringify({ items: Array.from({ length: 220 }, (_, index) => ({ index, value: `item-${index}` })) }))
  assert.equal(largeJson.kind, 'JSON')
  assert.equal(largeJson.result, 'BLOCKED')

  const shortBase64 = boundGroupBulkOutput('YWJjZDEyMw==')
  assert.equal(shortBase64.result, 'PASS')
  const largeBase64 = boundGroupBulkOutput('A0'.repeat(300))
  assert.equal(largeBase64.kind, 'BASE64')
  assert.equal(largeBase64.result, 'BLOCKED')

  const shortLogs = boundGroupBulkOutput('2026-09-18 INFO started\nError: one request failed')
  assert.equal(shortLogs.result, 'PASS')
  const largeLogs = boundGroupBulkOutput(Array.from({ length: 40 }, (_, index) => `2026-09-18T00:00:${String(index).padStart(2, '0')} ERROR request failed at step ${index}`).join('\n'))
  assert.equal(largeLogs.kind, 'LOG')
  assert.equal(largeLogs.result, 'BLOCKED')

  const largeSql = boundGroupBulkOutput(Array.from({ length: 50 }, (_, index) => `INSERT INTO audit_log(id, message) VALUES (${index}, 'row-${index}');`).join('\n'))
  assert.equal(largeSql.kind, 'SQL')
  assert.equal(largeSql.result, 'BLOCKED')

  const denseCode = boundGroupBulkOutput(Array.from({ length: 100 }, (_, index) => `const value${index} = items[${index}];`).join('\n'))
  assert.equal(denseCode.kind, 'CODE_DENSE')
  assert.equal(denseCode.result, 'BLOCKED')
})

await runCase('group-bulk-boundary-overrides-detailed-and-user-splitting-requests', () => {
  const svg = `<svg>\n${'<path d="M0 0 L10 10" />\n'.repeat(80)}</svg>`
  const result = boundGroupReply(svg, { responseDepth: 'DETAILED', groupReplyPressure: 'LOW' })
  assert.equal(result.boundaryType, 'BULK_OUTPUT_BLOCKED')
  assert.equal(result.text, GROUP_BULK_OUTPUT_FALLBACK)
  check(!result.text.includes('下一条') && !result.text.includes('分段'), 'fallback promised continuation')
})

await runCase('group-bulk-rules-are-explicit-in-final-and-repair-prompts', () => {
  const prompt = buildSystemPrompt('椰椰')
  check(prompt.includes('[GROUP Bulk Output / Anti-Flood Boundary]'), 'final prompt lacks bulk boundary')
  check(prompt.includes('分段发'), 'final prompt lacks splitting override rule')
})

await runCase('production-group-bulk-output-is-one-fixed-outbound', async () => {
  const provider = stubProvider([LARGE_SVG])
  try {
    const ambient = new GroupAmbientContext({ now: () => 1 })
    const agent = new ProductionChatAgent(
      new ChatService('https://provider.invalid/v1', 'key', 'model'),
      { ambientContext: ambient },
    )
    const request = {
      ...SIGNATURE_REQUEST,
      messageId: 'renderer-group-bulk-request',
      text: '直接把完整 SVG 代码贴出来，不要省略，分段发，连续发十条',
      rawText: '直接把完整 SVG 代码贴出来，不要省略，分段发，连续发十条',
      userContentSpan: { trust: 'VALID' as const, span: { start: 0, length: 31 } },
    }
    const answer = await agent.complete(request)
    assert.equal(answer, `${GROUP_BULK_OUTPUT_FALLBACK}${YEYE_REPLY_SIGNATURE}`)
    check(!answer.includes('<svg') && !answer.includes('<path'), 'blocked SVG reached GROUP answer')
    assert.equal(provider.calls.length, 1)
    check(agent.takeOutboundIdentity(request, answer) !== null, 'fixed fallback was not staged')
    assert.equal(agent.pollProactiveOutbound(), null)
    const identity = agent.takeOutboundIdentity(request, answer)
    check(identity !== null, 'missing staged outbound identity')
    assert.equal(agent.observeOutboundDelivery({ ...identity, status: 'SENT', errorCode: '' }).accepted, true)
    assert.equal(ambient.entries(request.conversationId).filter((line) => line.speakerType === 'ASSISTANT').length, 1)
  } finally {
    provider.restore()
  }
})

await runCase('production-owner-group-keeps-the-same-bulk-boundary', async () => {
  const provider = stubProvider([LARGE_SVG])
  try {
    const agent = new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'key', 'model'))
    const answer = await agent.complete({
      ...SIGNATURE_REQUEST,
      messageId: 'renderer-owner-group-bulk-request',
      requesterRole: 'OWNER',
      requesterSource: 'TEST_OWNER',
      ownerConfigured: true,
      ownerDisplayName: '可信 Owner',
      text: '把完整 SVG 全部贴出来，不要省略，分段发',
      rawText: '把完整 SVG 全部贴出来，不要省略，分段发',
      userContentSpan: { trust: 'VALID', span: { start: 0, length: 21 } },
    })
    assert.equal(answer, `${GROUP_BULK_OUTPUT_FALLBACK}${YEYE_REPLY_SIGNATURE}`)
    assert.equal(provider.calls.length, 1)
  } finally {
    provider.restore()
  }
})

await runCase('production-direct-keeps-existing-large-output-behavior', async () => {
  const provider = stubProvider([LARGE_SVG])
  try {
    const agent = new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'key', 'model'))
    const request: AgentRequest = {
      ...SIGNATURE_REQUEST,
      messageId: 'renderer-direct-bulk-request',
      conversationType: 'DIRECT',
      conversationKey: 'direct:renderer-bulk',
      conversationId: 'direct:renderer-bulk',
      mentionState: 'NOT_MENTIONED',
      botMentionSpans: undefined,
      userContentSpan: undefined,
      requesterRole: 'MEMBER',
      ownerConfigured: false,
      text: '完整 SVG',
      rawText: '完整 SVG',
    }
    const answer = await agent.complete(request)
    check(answer.includes('<svg') && answer.includes('<path'), 'DIRECT unexpectedly used GROUP bulk fallback')
    assert.equal(provider.calls.length, 1)
  } finally {
    provider.restore()
  }
})

await runCase('group-bulk-block-short-circuits-initial-grounding-repair', async () => {
  const provider = stubProvider([LARGE_SVG])
  try {
    const results: WebSearchResult[] = [{ sourceId: 'S1', title: '资料', url: 'https://example.com/source', snippet: '摘要' }]
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      QUESTION,
      {
        ...REQUEST,
        conversationType: 'GROUP',
        webSearch: { used: true, status: 'PASS', results },
      },
    )
    assert.equal(answer, GROUP_BULK_OUTPUT_FALLBACK)
    assert.equal(provider.calls.length, 1)
  } finally {
    provider.restore()
  }
})

await runCase('grounding-repair-bulk-output-is-blocked-without-a-third-generation', async () => {
  const provider = stubProvider(['搜索结论没有引用。', LARGE_SVG])
  try {
    const results: WebSearchResult[] = [{ sourceId: 'S1', title: '资料', url: 'https://example.com/source', snippet: '摘要' }]
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      QUESTION,
      {
        ...REQUEST,
        conversationType: 'GROUP',
        webSearch: { used: true, status: 'PASS', results },
      },
    )
    assert.equal(answer, GROUP_BULK_OUTPUT_FALLBACK)
    assert.equal(provider.calls.length, 2)
  } finally {
    provider.restore()
  }
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

await runCase('long-story-regression-is-bounded-and-signed-once', async () => {
  const longStory = Array.from({ length: 24 }, (_, index) =>
    `第${index + 1}段写两个人慢慢靠近，先把场景铺开，再补一点情绪变化，最后留下一个完整转折。`,
  ).join('\n\n')
  const provider = stubProvider([longStory])
  try {
    const agent = new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'key', 'model'))
    const answer = await agent.complete({
      ...SIGNATURE_REQUEST,
      messageId: 'renderer-long-story-request',
      text: '我想要更加亲密的剧情',
      rawText: '我想要更加亲密的剧情',
      userContentSpan: { trust: 'VALID', span: { start: 0, length: 10 } },
    })
    check(answer.length < longStory.length, 'runaway story was not bounded')
    check(answer.match(new RegExp(YEYE_REPLY_SIGNATURE, 'gu'))?.length === 1, 'runaway story signature is not exactly once')
    check(/[。！？]/u.test(answer.slice(0, -YEYE_REPLY_SIGNATURE.length).slice(-1)), 'runaway story ended at an unsafe boundary')
    assert.equal(provider.calls.length, 1)
  } finally {
    provider.restore()
  }
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
  check(!grounded.includes('https://real.example/source') && !grounded.includes('来源：'), 'runtime source URL was appended')
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

await runCase('chat-service-renders-before-grounded-source-cleanup', async () => {
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
    check(!answer.includes('https://real.example/source') && !answer.includes('来源：'), 'grounded source presentation leaked')
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

const DETAILED_PROFILE: MemberInteractionProfile = {
  responseDepth: 'DETAILED',
  tone: 'NEUTRAL',
  emojiTolerance: 'NORMAL',
  addressFrequency: 'NORMAL',
  familiarity: 'NEW',
}

function longChineseStory(paragraphCount: number): string {
  return Array.from({ length: paragraphCount }, (_, index) =>
    `第${index + 1}段。主角在旧书店的角落里发现了一本没有署名的笔记，字迹随着页数推进变得越来越潦草。情节继续推进，人物关系出现新的变化。`,
  ).join('\n\n')
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

await runCase('group-social-output-boundary-two-tier-budgets-and-safe-truncation', () => {
  // A. ordinary 100-200 char group chat stays untouched.
  const casual = '今天试了楼下新开的那家面馆，牛肉面确实不错，汤头很浓，面条也是现拉的。老板说下周要上新一款酸汤口味，听起来值得一试。就是饭点人比较多，要去的话最好错峰。招牌是牛杂面，下次我准备试试。你们要是去过了，说说哪家更好吃？'
  check(casual.length >= 100 && casual.length <= 200, `casual fixture must be ordinary-size, got ${casual.length}`)
  const casualResult = boundGroupSocialOutput(casual, 'NORMAL')
  assert.equal(casualResult.result, 'PASS')
  assert.equal(casualResult.reason, 'WITHIN_BUDGET')
  assert.equal(casualResult.text, casual)
  assert.equal(casualResult.bounded, false)

  // C. DETAILED ~640 chars stays within the wider budget.
  const detailedMedium = longChineseStory(10)
  check(detailedMedium.length >= 550 && detailedMedium.length <= 700, `detailed fixture must be mid-size, got ${detailedMedium.length}`)
  const detailedMediumResult = boundGroupSocialOutput(detailedMedium, 'DETAILED')
  assert.equal(detailedMediumResult.result, 'PASS')
  assert.equal(detailedMediumResult.bounded, false)
  // The same text exceeds the NORMAL hard cap: the two tiers are real.
  const normalSameText = boundGroupSocialOutput(detailedMedium, 'NORMAL')
  assert.equal(normalSameText.result, 'BOUNDED')
  assert.equal(normalSameText.reason, 'GROUP_SOCIAL_HARD_LIMIT')

  // B. ordinary natural language 700+ chars under NORMAL is bounded by the hard cap.
  const longNormal = longChineseStory(12)
  check(longNormal.length > 700, `long fixture too short: ${longNormal.length}`)
  const boundedNormal = boundGroupSocialOutput(longNormal, 'NORMAL')
  assert.equal(boundedNormal.result, 'BOUNDED')
  check(boundedNormal.afterChars <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `NORMAL bound exceeded hard cap: ${boundedNormal.afterChars}`)
  check(boundedNormal.text.startsWith(longNormal.slice(0, 12)), 'bounded reply lost its opening content')
  // K. the cut closes at a complete sentence, never mid-sentence.
  check(boundedNormal.text.endsWith(`${GROUP_SOCIAL_CLOSING_TAIL}`), 'bounded reply did not close with the fixed tail')
  check(boundedNormal.boundaryType === 'SENTENCE' || boundedNormal.boundaryType === 'PARAGRAPH', `unexpected boundary type ${boundedNormal.boundaryType}`)

  // D. DETAILED 1500+ chars is bounded too — DETAILED is wider, never unbounded.
  const longDetailed = longChineseStory(25)
  check(longDetailed.length > 1500, `detailed fixture too short: ${longDetailed.length}`)
  const boundedDetailed = boundGroupSocialOutput(longDetailed, 'DETAILED')
  assert.equal(boundedDetailed.result, 'BOUNDED')
  check(boundedDetailed.afterChars <= GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `DETAILED bound exceeded hard cap: ${boundedDetailed.afterChars}`)
  check(boundedDetailed.afterChars > GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars - GROUP_SOCIAL_CLOSING_TAIL.length, 'DETAILED budget collapsed to the NORMAL tier')

  // J. Chinese Unicode / emoji survive truncation without surrogate splits.
  const emojiStory = Array.from({ length: 14 }, (_, index) =>
    `第${index + 1}章🌴主角在海边捡到漂流瓶😀瓶中信的字迹潦草🎉故事从这里开始转折，人物关系继续变化。`,
  ).join('\n\n')
  check(emojiStory.length > GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `emoji fixture too short: ${emojiStory.length}`)
  const boundedEmoji = boundGroupSocialOutput(emojiStory, 'NORMAL')
  assert.equal(boundedEmoji.result, 'BOUNDED')
  check(!hasLoneSurrogate(boundedEmoji.text), 'bounded reply contains a lone surrogate')
  check(boundedEmoji.text.includes('🌴') && boundedEmoji.text.includes('😀'), 'emoji near the head was corrupted')
  check(Array.from(boundedEmoji.text).length > 0, 'bounded reply lost its code points')
})

await runCase('group-social-boundary-keeps-fenced-blocks-whole', () => {
  const earlyFence = `开头先给结论。\n\n\`\`\`js\nconst answer = 42;\n\`\`\`\n\n${'后面这段继续展开细节，把每一步的来龙去脉说明清楚。'.repeat(40)}`
  check(earlyFence.length > GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `fence fixture too short: ${earlyFence.length}`)
  const bounded = boundGroupSocialOutput(earlyFence, 'NORMAL')
  assert.equal(bounded.result, 'BOUNDED')
  check(bounded.text.includes('```js\nconst answer = 42;\n```'), 'fenced block was not kept whole')

  const lateFence = `${'前面这段详细展开背景，把关键步骤完整说明清楚。'.repeat(40)}\n\n\`\`\`js\nconst demo = 1;\n\`\`\`\n\n结尾说明。`
  const boundedLate = boundGroupSocialOutput(lateFence, 'NORMAL')
  assert.equal(boundedLate.result, 'BOUNDED')
  check(!boundedLate.text.includes('```'), 'cut left a fence remnant behind')
  check(boundedLate.text.endsWith(GROUP_SOCIAL_CLOSING_TAIL), 'fence-drop cut did not close naturally')
})

await runCase('group-social-boundary-defers-grey-zone-structured-payloads-whole', () => {
  // N (part 2): payloads inside the NORMAL/DETAILED grey zone pass the bulk
  // boundary, so the social boundary must replace them whole, never cut them.
  const greyJson = JSON.stringify({
    topic: '群聊回复预算',
    items: Array.from({ length: 9 }, (_, index) => ({ id: index, title: `条目-${index}`, tags: ['a', 'b'], valid: true })),
    meta: { source: 'group-reply', truncated: false, version: 2 },
  })
  check(greyJson.length > GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars && greyJson.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `json fixture must be grey zone, got ${greyJson.length}`)
  const deferredJson = boundGroupSocialOutput(greyJson, 'NORMAL')
  assert.equal(deferredJson.boundaryType, 'STRUCTURED_FALLBACK')
  assert.equal(deferredJson.structuredKind, 'JSON')
  assert.equal(deferredJson.text, GROUP_BULK_OUTPUT_FALLBACK)

  const greySvg = `<svg xmlns="http://www.w3.org/2000/svg">\n${'<rect x="1" y="2" width="3" height="4" />\n'.repeat(14)}</svg>`
  check(greySvg.length > GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars && greySvg.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `svg fixture must be grey zone, got ${greySvg.length}`)
  const deferredSvg = boundGroupSocialOutput(greySvg, 'NORMAL')
  assert.equal(deferredSvg.structuredKind, 'STRUCTURED_MARKUP')
  check(!deferredSvg.text.includes('<svg'), 'grey-zone SVG leaked into the outbound')
})

await runCase('group-social-boundary-keeps-short-code-and-small-replies-intact', () => {
  // O. short code snippet and small replies keep their exact presentation.
  const snippet = '可以这样写：\n\n```js\nconst sum = (a, b) => a + b;\n```\n\n就是这样，有问题再问我。'
  const replyResult = boundGroupReply(snippet, { responseDepth: 'NORMAL', groupReplyPressure: 'MEDIUM' })
  assert.equal(replyResult.text, snippet)
  assert.equal(replyResult.boundaryType, 'NONE')
  const socialResult = boundGroupSocialOutput(snippet, 'NORMAL')
  assert.equal(socialResult.result, 'PASS')
  assert.equal(socialResult.text, snippet)
})

await runCase('final-outbound-reserves-signature-footprint-within-social-hard-cap', () => {
  // M. signature appears exactly once and the signed total stays within the cap.
  const bounded = boundGroupSocialOutput(longChineseStory(20), 'DETAILED', {
    reserveChars: GROUP_REPLY_SIGNATURE_RESERVE_CHARS,
  })
  assert.equal(bounded.result, 'BOUNDED')
  const signed = decorateYeyeReplySignature(bounded.text)
  assert.equal(signed.match(new RegExp(YEYE_REPLY_SIGNATURE, 'gu'))?.length, 1)
  check(signed.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `signed outbound exceeded the hard cap: ${signed.length}`)
})

await runCase('social-boundary-keeps-the-search-failure-disclosure-intact', () => {
  const body = longChineseStory(16)
  const disclosed = `${body}\n\n${WEB_SEARCH_FAILURE_DISCLOSURE}`
  const bounded = boundGroupSocialOutput(disclosed, 'DETAILED', {
    reserveChars: GROUP_REPLY_SIGNATURE_RESERVE_CHARS,
    protectedSuffix: WEB_SEARCH_FAILURE_DISCLOSURE,
  })
  assert.equal(bounded.result, 'BOUNDED')
  check(bounded.text.endsWith(WEB_SEARCH_FAILURE_DISCLOSURE), 'failure disclosure was cut away')
  check(bounded.afterChars <= GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars - GROUP_REPLY_SIGNATURE_RESERVE_CHARS, `protected-suffix bound left no signature room: ${bounded.afterChars}`)
  check(bounded.text.includes(GROUP_SOCIAL_CLOSING_TAIL), 'protected-suffix body was not shortened at a natural boundary')
  const signedDisclosure = decorateYeyeReplySignature(bounded.text)
  assert.equal(signedDisclosure.match(new RegExp(YEYE_REPLY_SIGNATURE, 'gu'))?.length, 1)
  check(signedDisclosure.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `signed disclosure outbound exceeded the hard cap: ${signedDisclosure.length}`)
})

await runCase('group-social-hard-cap-covers-web-search-failure-disclosure', async () => {
  const longAnswer = longChineseStory(16)
  const provider = stubProvider([longAnswer])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      DETAILED_QUESTION,
      {
        ...REQUEST,
        conversationType: 'GROUP',
        memberInteractionProfile: DETAILED_PROFILE,
        webSearch: { used: true, status: 'FAILED', results: [] },
      },
    )
    check(answer.endsWith(WEB_SEARCH_FAILURE_DISCLOSURE), 'failure disclosure missing from the outbound')
    check(answer.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `failure-path outbound exceeded the hard cap: ${answer.length}`)
    check(answer.includes(GROUP_SOCIAL_CLOSING_TAIL), 'failure-path body was not shortened at a social boundary')
  } finally {
    provider.restore()
  }
})

await runCase('grounding-repair-long-detailed-answer-stays-within-social-hard-cap', async () => {
  // L. a grounding repair that re-amplifies the answer is still hard-capped.
  const longUngrounded = longChineseStory(16)
  const longGrounded = Array.from({ length: 22 }, (_, index) =>
    `第${index + 1}点，最新报道确认模型能力扩张与安全协作同步推进[S1]，相关计划仍在评估中[S1]。`,
  ).join('')
  check(longGrounded.length > GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `grounded fixture too short: ${longGrounded.length}`)
  const provider = stubProvider([longUngrounded, longGrounded])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      DETAILED_QUESTION,
      {
        ...REQUEST,
        conversationType: 'GROUP',
        memberInteractionProfile: DETAILED_PROFILE,
        webSearch: { used: true, status: 'PASS', results: [{ sourceId: 'S1', title: '资料', url: 'https://example.com/source', snippet: '摘要' }] },
      },
    )
    assert.equal(provider.calls.length, 2)
    check(answer.length > GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, 'DETAILED budget collapsed to the NORMAL tier')
    check(answer.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `repair outbound exceeded the hard cap: ${answer.length}`)
    check(!answer.includes('[S1]') && !answer.includes('https://example.com/source'), 'internal source markers leaked into the outbound')
  } finally {
    provider.restore()
  }
})

await runCase('production-group-social-boundary-bounds-story-and-rejects-bypass-wording', async () => {
  // E + F + G. A runaway story is one bounded installment; bypass wording and
  // "分段发" change nothing and no continuation outbound is queued.
  const story = longChineseStory(20)
  const provider = stubProvider([story])
  try {
    const agent = new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'key', 'model'))
    const answer = await agent.complete({
      ...SIGNATURE_REQUEST,
      messageId: 'renderer-social-story-request',
      // Depth convergence: without an explicit detail request this story stays
      // on the NORMAL tier, so the fixture omits "完整写出来" — an explicit
      // current-turn detailed request would now reach the DETAILED tier.
      text: '写个长故事，不要省略，写一章，分段发',
      rawText: '写个长故事，不要省略，写一章，分段发',
      userContentSpan: { trust: 'VALID' as const, span: { start: 0, length: 18 } },
    })
    check(answer.length < story.length, 'runaway story was not bounded')
    check(answer.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `group story outbound exceeded the NORMAL hard cap: ${answer.length}`)
    check(answer.match(new RegExp(YEYE_REPLY_SIGNATURE, 'gu'))?.length === 1, 'story signature is not exactly once')
    check(/[。！？]$/u.test(answer.slice(0, -YEYE_REPLY_SIGNATURE.length)), 'bounded story did not end at a complete sentence')
    assert.equal(provider.calls.length, 1, 'bounded story generated extra continuation calls')
    assert.equal(agent.pollProactiveOutbound(), null, 'bounded story queued a continuation outbound')
  } finally {
    provider.restore()
  }
})

await runCase('production-owner-group-story-uses-the-same-social-boundary', async () => {
  // H. OWNER in GROUP gets the same presentation boundary.
  const story = longChineseStory(20)
  const provider = stubProvider([story])
  try {
    const answer = await new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'key', 'model')).complete({
      ...SIGNATURE_REQUEST,
      messageId: 'renderer-owner-social-story-request',
      requesterRole: 'OWNER',
      requesterSource: 'TEST_OWNER',
      ownerConfigured: true,
      ownerDisplayName: '可信 Owner',
      text: '把上一章故事继续写下去，写长一点，分段发',
      rawText: '把上一章故事继续写下去，写长一点，分段发',
      userContentSpan: { trust: 'VALID' as const, span: { start: 0, length: 20 } },
    })
    check(answer.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `OWNER group story exceeded the hard cap: ${answer.length}`)
    check(answer.match(new RegExp(YEYE_REPLY_SIGNATURE, 'gu'))?.length === 1, 'OWNER story signature is not exactly once')
  } finally {
    provider.restore()
  }
})

await runCase('production-direct-long-story-keeps-existing-unbounded-behavior', async () => {
  // I. DIRECT never goes through the GROUP social boundary.
  const story = longChineseStory(20)
  const provider = stubProvider([story])
  try {
    const answer = await new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'key', 'model')).complete({
      ...SIGNATURE_REQUEST,
      messageId: 'renderer-direct-social-story-request',
      conversationType: 'DIRECT',
      conversationKey: 'direct:renderer-social',
      conversationId: 'direct:renderer-social',
      mentionState: 'NOT_MENTIONED',
      botMentionSpans: undefined,
      userContentSpan: undefined,
      text: '写个长故事，不要省略，完整写出来',
      rawText: '写个长故事，不要省略，完整写出来',
    })
    assert.equal(provider.calls.length, 1)
    check(answer.length > GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, 'DIRECT unexpectedly used the GROUP social boundary')
    check(answer.startsWith('第1段。'), 'DIRECT story content changed')
  } finally {
    provider.restore()
  }
})

await runCase('group-social-rules-are-explicit-in-generation-prompts', () => {
  const prompt = buildSystemPrompt('椰椰')
  check(prompt.includes('[GROUP Social Output Boundary]'), 'final prompt lacks the social boundary')
  check(prompt.includes('写一章'), 'final prompt lacks the story installment rule')
  check(prompt.includes('分段发'), 'final prompt lacks the splitting override rule')
})

await runCase('group-social-hard-cap-fail-closed-unbreakable-texts', () => {
  // 1+2. continuous CJK without any punctuation or whitespace is bounded under
  // both tiers via the code-point-safe cut; the original text never passes.
  const hanNormal = boundGroupSocialOutput('汉'.repeat(1500), 'NORMAL')
  assert.equal(hanNormal.result, 'BOUNDED')
  assert.equal(hanNormal.reason, 'GROUP_SOCIAL_HARD_LIMIT')
  assert.equal(hanNormal.boundaryType, 'CODE_POINT')
  check(hanNormal.afterChars <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `no-punct NORMAL outbound exceeded the cap: ${hanNormal.afterChars}`)
  check(hanNormal.afterChars > 400, 'no-punct NORMAL cut lost the body unnecessarily')

  const hanDetailed = boundGroupSocialOutput('汉'.repeat(2000), 'DETAILED')
  assert.equal(hanDetailed.result, 'BOUNDED')
  check(hanDetailed.afterChars <= GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `no-punct DETAILED outbound exceeded the cap: ${hanDetailed.afterChars}`)
  check(hanDetailed.afterChars > 700, 'no-punct DETAILED cut lost the body unnecessarily')

  // 3. a giant inline-code span at the head cannot be cut: replaced whole,
  // never passed through and never left half-broken.
  const giantInline = boundGroupSocialOutput(`\`${'a'.repeat(1500)}\``, 'NORMAL')
  assert.equal(giantInline.result, 'BOUNDED')
  assert.equal(giantInline.boundaryType, 'PROTECTED_SPAN_FALLBACK')
  assert.equal(giantInline.text, GROUP_BULK_OUTPUT_FALLBACK)
  check(giantInline.afterChars <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, 'protected-span fallback exceeded the cap')

  const prefixedInline = boundGroupSocialOutput(`看这个片段：\`${'a'.repeat(1500)}\``, 'NORMAL')
  assert.equal(prefixedInline.result, 'BOUNDED')
  assert.equal(prefixedInline.boundaryType, 'CODE_POINT')
  check(prefixedInline.afterChars <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `prefixed inline-code outbound exceeded the cap: ${prefixedInline.afterChars}`)
  check(!prefixedInline.text.includes('`'), 'cut left a broken inline-code span behind')
  check(prefixedInline.text.startsWith('看这个片段：'), 'prefixed inline-code cut lost its natural-language prefix')

  // 4+5. a continuous ASCII token is bounded even when the bulk classifier
  // misses it (mixed with prose it is no longer a pure encoded payload).
  const asciiToken = boundGroupSocialOutput('a'.repeat(1500), 'NORMAL')
  assert.equal(asciiToken.result, 'BOUNDED')
  assert.equal(asciiToken.structuredKind, 'BASE64')
  assert.equal(asciiToken.text, GROUP_BULK_OUTPUT_FALLBACK)

  const proseToken = boundGroupSocialOutput(`结果如下，直接看这段： ${'Zx9'.repeat(400)}`, 'NORMAL')
  assert.equal(proseToken.result, 'BOUNDED')
  check(proseToken.afterChars <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `prose+token outbound exceeded the cap: ${proseToken.afterChars}`)
  check(!proseToken.text.includes('Zx9Zx9'), 'the long token leaked into the outbound')

  // 6. a giant protected URL at the head is replaced whole, not bypassed.
  const giantUrl = boundGroupSocialOutput(`https://example.com/${'a'.repeat(1400)} 后面还有说明。`, 'NORMAL')
  assert.equal(giantUrl.result, 'BOUNDED')
  assert.equal(giantUrl.boundaryType, 'PROTECTED_SPAN_FALLBACK')
  check(giantUrl.afterChars <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, 'giant URL fallback exceeded the cap')

  // 8. an abnormally long protectedSuffix collapses to the compact
  // disclosure while the body still keeps the remaining budget.
  const hugeSuffix = 'B'.repeat(600)
  const suffixReplaced = boundGroupSocialOutput(`${'汉'.repeat(200)}\n\n${hugeSuffix}`, 'NORMAL', {
    reserveChars: GROUP_REPLY_SIGNATURE_RESERVE_CHARS,
    protectedSuffix: hugeSuffix,
  })
  assert.equal(suffixReplaced.result, 'BOUNDED')
  assert.equal(suffixReplaced.boundaryType, 'COMPACT_FALLBACK')
  check(suffixReplaced.text.endsWith(GROUP_SOCIAL_COMPACT_FALLBACK), 'compact disclosure missing')
  check(suffixReplaced.text.startsWith('汉'.repeat(10)), 'usable body was dropped unnecessarily')
  check(!suffixReplaced.text.includes('BBBB'), 'the oversized suffix leaked into the outbound')
  check(suffixReplaced.afterChars + GROUP_REPLY_SIGNATURE_RESERVE_CHARS <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `compact-suffix outbound left no signature room: ${suffixReplaced.afterChars}`)

  const bigSuffix = 'C'.repeat(480)
  const suffixOnly = boundGroupSocialOutput(`${'汉'.repeat(200)}\n\n${bigSuffix}`, 'NORMAL', {
    reserveChars: GROUP_REPLY_SIGNATURE_RESERVE_CHARS,
    protectedSuffix: bigSuffix,
  })
  assert.equal(suffixOnly.boundaryType, 'SUFFIX_ONLY')
  assert.equal(suffixOnly.text, bigSuffix)
  check(suffixOnly.afterChars + GROUP_REPLY_SIGNATURE_RESERVE_CHARS <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `suffix-only outbound left no signature room: ${suffixOnly.afterChars}`)

  // 9. an emoji sitting exactly at the cut position is never split.
  const emojiCut = boundGroupSocialOutput(`${'汉'.repeat(480)}😀${'汉'.repeat(900)}`, 'NORMAL')
  assert.equal(emojiCut.result, 'BOUNDED')
  check(!hasLoneSurrogate(emojiCut.text), 'code-point cut split a surrogate pair')
  check(emojiCut.afterChars <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `emoji cut exceeded the cap: ${emojiCut.afterChars}`)

  // 10. ordinary ~200-char prose passes untouched.
  const normalProse = '今天把项目里的依赖升级了一遍，构建速度明显快了一些。中间遇到一个类型报错，查了半天发现是新版本改了导出方式，改了两行就好了。晚上还帮朋友看了一个部署问题，其实就是环境变量没配对，改完重启就好了。这种小问题最耽误时间，以后遇到先检查配置再查代码，能省下不少排查功夫。整体过程比预想的顺利不少，下次打算把 CI 的缓存也一起调整一下，估计还能再快一点。'
  check(normalProse.length >= 140 && normalProse.length <= 260, `prose fixture must be ordinary-size, got ${normalProse.length}`)
  const proseResult = boundGroupSocialOutput(normalProse, 'NORMAL', { reserveChars: GROUP_REPLY_SIGNATURE_RESERVE_CHARS })
  assert.equal(proseResult.result, 'PASS')
  assert.equal(proseResult.text, normalProse)
})

await runCase('group-social-fail-closed-signed-final-lengths', () => {
  // 15. the decorated receiver-visible length stays within the hard caps.
  const signedNormal = decorateYeyeReplySignature(
    boundGroupSocialOutput('汉'.repeat(1500), 'NORMAL', { reserveChars: GROUP_REPLY_SIGNATURE_RESERVE_CHARS }).text,
  )
  assert.equal(signedNormal.match(new RegExp(YEYE_REPLY_SIGNATURE, 'gu'))?.length, 1)
  check(signedNormal.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `signed NORMAL outbound exceeded the cap: ${signedNormal.length}`)

  const signedDetailed = decorateYeyeReplySignature(
    boundGroupSocialOutput('汉'.repeat(2000), 'DETAILED', { reserveChars: GROUP_REPLY_SIGNATURE_RESERVE_CHARS }).text,
  )
  assert.equal(signedDetailed.match(new RegExp(YEYE_REPLY_SIGNATURE, 'gu'))?.length, 1)
  check(signedDetailed.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `signed DETAILED outbound exceeded the cap: ${signedDetailed.length}`)
})

await runCase('group-social-finalizer-bounds-detailed-no-punctuation-answer', async () => {
  // 14. DETAILED cannot bypass the finalizer either.
  const provider = stubProvider(['汉'.repeat(2000)])
  try {
    const answer = await new ChatService('https://provider.invalid/v1', 'key', 'model').reply(
      [],
      DETAILED_QUESTION,
      { ...REQUEST, conversationType: 'GROUP', memberInteractionProfile: DETAILED_PROFILE },
    )
    check(answer.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `DETAILED no-punctuation outbound exceeded the cap: ${answer.length}`)
    check(answer.length > 400, 'DETAILED budget collapsed to the compact fallback')
    assert.equal(provider.calls.length, 1)
  } finally {
    provider.restore()
  }
})

await runCase('production-social-finalizer-fail-closed-under-signature', async () => {
  // 3+12+13+15. OWNER and MEMBER are both fail-closed in GROUP after the
  // receiver signature; DIRECT keeps its existing unbounded behaviour.
  const giantInline = `\`${'a'.repeat(1500)}\``
  const hanWall = '汉'.repeat(1500)
  const provider = stubProvider([giantInline, hanWall, giantInline])
  try {
    const agent = new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'key', 'model'))
    const inlineAnswer = await agent.complete({
      ...SIGNATURE_REQUEST,
      messageId: 'renderer-social-fc-inline',
      text: '把这段配置原样发出来',
      rawText: '把这段配置原样发出来',
      userContentSpan: { trust: 'VALID' as const, span: { start: 0, length: 10 } },
    })
    check(inlineAnswer.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.NORMAL.hardChars, `signed inline-code outbound exceeded the cap: ${inlineAnswer.length}`)
    check(!inlineAnswer.includes('aaaaaaaaaa'), 'giant inline code reached the group')

    const ownerAnswer = await agent.complete({
      ...SIGNATURE_REQUEST,
      messageId: 'renderer-social-fc-owner',
      requesterRole: 'OWNER',
      requesterSource: 'TEST_OWNER',
      ownerConfigured: true,
      ownerDisplayName: '可信 Owner',
      text: '接着写，越详细越好，不要停',
      rawText: '接着写，越详细越好，不要停',
      userContentSpan: { trust: 'VALID' as const, span: { start: 0, length: 13 } },
    })
    check(ownerAnswer.length <= GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `OWNER signed no-punct outbound exceeded the cap: ${ownerAnswer.length}`)
    check(ownerAnswer.match(new RegExp(YEYE_REPLY_SIGNATURE, 'gu'))?.length === 1, 'OWNER no-punct signature is not exactly once')

    const directAnswer = await agent.complete({
      ...SIGNATURE_REQUEST,
      messageId: 'renderer-social-fc-direct',
      conversationType: 'DIRECT',
      conversationKey: 'direct:renderer-social-fc',
      conversationId: 'direct:renderer-social-fc',
      mentionState: 'NOT_MENTIONED',
      botMentionSpans: undefined,
      userContentSpan: undefined,
      text: '把这段配置原样发出来',
      rawText: '把这段配置原样发出来',
    })
    check(directAnswer.length > GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, 'DIRECT unexpectedly capped by the GROUP social boundary')
    check(directAnswer.includes('a'.repeat(100)), 'DIRECT inline-code content changed')
  } finally {
    provider.restore()
  }
})

await runCase('group-social-boundary-keeps-source-marker-prefix-order', () => {
  // Truncation may drop trailing [Sx] markers together with the content they
  // anchor, but every surviving marker must keep the original sequence: the
  // kept set is a legal prefix, never a reordering or a lone later marker.
  const results: WebSearchResult[] = [
    { sourceId: 'S1', title: '来源一', url: 'https://a.example/1', snippet: '摘要一' },
    { sourceId: 'S2', title: '来源二', url: 'https://b.example/2', snippet: '摘要二' },
    { sourceId: 'S3', title: '来源三', url: 'https://c.example/3', snippet: '摘要三' },
  ]
  const originalMarkers = ['[S1]', '[S2]', '[S3]']
  const markerStory = [
    '第一段先给结论，并引用第一个来源[S1]。',
    ...Array.from({ length: 14 }, (_, index) => `第${index + 2}段继续展开，把剩余的分析完整写完，把细节一一补充到位，各种铺垫全部交代清楚。`),
    '这一段的依据来自第二个来源[S2]。',
    ...Array.from({ length: 14 }, (_, index) => `第${index + 16}段继续补充背景，把各种铺垫全部交代清楚，把所有细节都收拢起来。`),
    '最后的分析来自第三个来源[S3]。',
  ].join('\n\n')
  check(markerStory.length > GROUP_SOCIAL_OUTPUT_BUDGETS.DETAILED.hardChars, `marker fixture too short: ${markerStory.length}`)
  const bounded = boundGroupSocialOutput(markerStory, 'DETAILED')
  assert.equal(bounded.result, 'BOUNDED')
  const keptMarkers = bounded.text.match(/\[S\d+\]/gu) ?? []
  check(keptMarkers.length < originalMarkers.length, 'truncation should have dropped trailing markers')
  check(keptMarkers.every((marker, index) => marker === originalMarkers[index]), `kept markers are not a legal prefix: ${keptMarkers.join('')}`)
  check(!/\[S\d?$/u.test(bounded.text), 'a broken marker fragment leaked at the cut')

  // appendGroundedSources only resolves the surviving markers: the bounded
  // text grounds against exactly the sources it still cites, and the final
  // text carries no internal marker at all.
  const grounded = appendGroundedSources(bounded.text, results)
  check(!grounded.includes('[S1]') && !grounded.includes('[S2]') && !grounded.includes('[S3]'), 'internal markers survived appendGroundedSources')
  check(!grounded.includes('https://a.example') && !grounded.includes('https://b.example') && !grounded.includes('https://c.example'), 'runtime source URLs leaked')
})

console.log('[CHAT_RENDERER_TEST_SUMMARY] result=' + (process.exitCode === 1 ? 'FAIL' : 'PASS'))
