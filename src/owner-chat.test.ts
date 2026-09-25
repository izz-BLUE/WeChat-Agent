import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { ChatService, buildSystemPrompt, buildUserPrompt } from './chat.js'
import { createTrustedAssistantRuntimeFacts } from './assistant-identity.js'
import { ProductionAgentTransportServer } from './production-agent-transport.js'
import { OwnerChatHandler } from './owner-chat-handler.js'
import type { PersistentRuntimeLogSink } from './persistent-runtime-log.js'
import {
  OWNER_CHAT_CONVERSATION_ID,
  OWNER_CHAT_REQUEST_KIND,
  OWNER_CHAT_RESPONSE_KIND,
  parseOwnerChatEnvelope,
  type OwnerChatRequest,
  type OwnerChatRecentMessage,
} from './owner-chat-contract.js'
import type { AgentExecutor } from './agent-adapter.js'

const validRequest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: OWNER_CHAT_REQUEST_KIND,
  requestId: randomUUID(),
  conversationId: OWNER_CHAT_CONVERSATION_ID,
  timestamp: Date.now(),
  authority: {
    source: 'LOCAL_UI_OWNER_CONFIGURATION',
    requesterRole: 'OWNER',
    ownerConfigured: true,
    scope: 'OWNER_CHAT',
    ownerDisplayName: 'Owner',
    creatorDisplayName: 'Creator',
  },
  text: '当前问题',
  recentContext: [{ role: 'user', text: 'ui-transcript-sentinel' }],
  attachments: [],
  ...overrides,
})

async function transportExchange(
  envelope: unknown,
  ownerChatHandler: { handle(request: OwnerChatRequest): Promise<string> } | undefined,
): Promise<{ response: Record<string, unknown>; normalCalls: number; polls: number; summaries: number }> {
  let normalCalls = 0
  let polls = 0
  const agent: AgentExecutor = {
    complete: async () => {
      normalCalls += 1
      return 'unexpected normal pipeline'
    },
    pollProactiveOutbound: () => {
      polls += 1
      return null
    },
  }
  const server = new ProductionAgentTransportServer({
    pipeName: 'owner-chat-test-' + process.pid + '-' + randomUUID(),
    agent,
    ownerChatHandler,
  })
  await server.start()
  const socket = createConnection(server.endpoint)
  socket.setEncoding('utf8')
  let buffer = ''
  let resolveResponse: ((response: Record<string, unknown>) => void) | undefined
  const responsePromise = new Promise<Record<string, unknown>>((resolve) => {
    resolveResponse = resolve
  })
  socket.on('data', (chunk: string) => {
    buffer += chunk
    const newline = buffer.indexOf('\n')
    if (newline >= 0) {
      resolveResponse?.(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write(JSON.stringify(envelope) + '\n')
  const response = await responsePromise
  socket.destroy()
  await server.stop()
  return { response, normalCalls, polls, summaries: server.entries.length }
}

async function testProtocolValidationAndCorrelation(): Promise<void> {
  const parsed = parseOwnerChatEnvelope(validRequest())
  assert.equal('request' in parsed, true)
  if (!('request' in parsed)) return
  assert.equal(parsed.request.conversationId, OWNER_CHAT_CONVERSATION_ID)
  assert.deepEqual(parsed.request.attachments, [])
  assert.equal(parsed.request.authority.requesterRole, 'OWNER')
  assert.equal(JSON.stringify(parsed.request).includes('wxid'), false)

  const invalid = parseOwnerChatEnvelope(validRequest({ conversationId: 'group@chatroom' }))
  assert.equal('errorCode' in invalid && invalid.errorCode, 'INVALID_REQUEST')
  const invalidAuthority = parseOwnerChatEnvelope(validRequest({
    authority: { source: 'LOCAL_UI_OWNER_CONFIGURATION', requesterRole: 'OWNER', ownerConfigured: false, scope: 'OWNER_CHAT' },
  }))
  assert.equal('errorCode' in invalidAuthority && invalidAuthority.errorCode, 'INVALID_AUTHORITY')
  const attachments = parseOwnerChatEnvelope(validRequest({ attachments: [{ path: 'secret.png' }] }))
  assert.equal('errorCode' in attachments && attachments.errorCode, 'ATTACHMENTS_UNSUPPORTED')
}

async function testTransportRoutesBeforeInboundPipeline(): Promise<void> {
  let calls = 0
  const wire = validRequest()
  const result = await transportExchange(wire, {
    handle: async (request) => {
      calls += 1
      assert.equal(request.requestId, wire.requestId)
      assert.equal(request.recentContext[0]?.text, 'ui-transcript-sentinel')
      return 'Owner Chat answer'
    },
  })
  assert.equal(result.response.kind, OWNER_CHAT_RESPONSE_KIND)
  assert.equal(result.response.requestId, wire.requestId)
  assert.equal(result.response.status, 'OK')
  assert.equal(result.response.text, 'Owner Chat answer')
  assert.equal(calls, 1)
  assert.equal(result.normalCalls, 0)
  assert.equal(result.polls, 0)
  assert.equal(result.summaries, 0)
}

async function testTransportErrorsFailClosed(): Promise<void> {
  const invalidAuthority = validRequest({
    authority: { source: 'LOCAL_UI_OWNER_CONFIGURATION', requesterRole: 'OWNER', ownerConfigured: false, scope: 'OWNER_CHAT' },
  })
  const rejected = await transportExchange(invalidAuthority, { handle: async () => 'must not run' })
  assert.equal(rejected.response.kind, OWNER_CHAT_RESPONSE_KIND)
  assert.equal(rejected.response.status, 'ERROR')
  assert.equal(rejected.response.errorCode, 'INVALID_AUTHORITY')

  const unavailable = await transportExchange(validRequest(), undefined)
  assert.equal(unavailable.response.errorCode, 'UNAVAILABLE')

  const providerFailed = await transportExchange(validRequest(), {
    handle: async () => { throw new Error('provider detail must not be returned') },
  })
  assert.equal(providerFailed.response.errorCode, 'PROVIDER_ERROR')
  assert.equal(providerFailed.response.message, undefined)
}

async function testOwnerChatHandlerUsesTrustedFactsAndNoMemoryService(): Promise<void> {
  class RecordingChatService extends ChatService {
    public call?: {
      text: string
      recentContext: readonly OwnerChatRecentMessage[]
      runtime: ReturnType<typeof createTrustedAssistantRuntimeFacts>
      requestId: string
    }
    public override async replyOwnerChat(
      text: string,
      recentContext: readonly OwnerChatRecentMessage[],
      runtime: ReturnType<typeof createTrustedAssistantRuntimeFacts>,
      requestId: string,
    ): Promise<string> {
      this.call = { text, recentContext, runtime, requestId }
      return 'answer'
    }
  }
  const chat = new RecordingChatService('', '', '')
  const handler = new OwnerChatHandler(chat, '椰椰')
  const parsed = parseOwnerChatEnvelope(validRequest())
  assert.equal('request' in parsed, true)
  if (!('request' in parsed)) return
  assert.equal(await handler.handle(parsed.request), 'answer')
  assert.equal(chat.call?.runtime.ownerConfigured, true)
  assert.equal(chat.call?.runtime.ownerDisplayName, 'Owner')
  assert.equal(chat.call?.runtime.creatorDisplayName, 'Creator')
  assert.equal(chat.call?.requestId, parsed.request.requestId)
  assert.equal(chat.call?.recentContext[0]?.text, 'ui-transcript-sentinel')
}

async function testOwnerChatPromptGuardAndGroupIsolation(): Promise<void> {
  const originalFetch = globalThis.fetch
  const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const drafts = [
    '我已经记住了你住在上海。',
    '这段内容只出现在当前 UI 对话里，我没有保存到长期记忆。',
  ]
  let callCount = 0
  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> })
    const content = drafts[callCount++] ?? '最终回答'
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const assistantRuntime = createTrustedAssistantRuntimeFacts('椰椰', true, 'Owner', 'Creator')
    const service = new ChatService('http://owner-chat.test/v1', 'test-key', 'test-model')
    const result = await service.replyOwnerChat(
      '当前问题',
      [{ role: 'user', text: 'ui-transcript-sentinel' }],
      assistantRuntime,
      randomUUID(),
    )
    assert.equal(result, drafts[1])
    assert.equal(callCount, 2, 'Answer Guard should regenerate an unsupported memory-write claim')
    const allContent = payloads.flatMap((payload) => payload.messages.map((message) => message.content)).join('\n')
    assert.match(allContent, /OWNER_CHAT/i)
    assert.match(allContent, /ui-transcript-sentinel/)
    assert.match(allContent, /LONG_TERM_MEMORY_READ_THIS_TURN=false/)
    assert.match(allContent, /LONG_TERM_MEMORY_WRITE_THIS_TURN=false/)
    const ownerSystemPrompt = payloads[0]?.messages.find((message) => message.role === 'system')?.content ?? ''
    assert.doesNotMatch(ownerSystemPrompt, /GROUP_REPLY_PRESSURE|GROUP_CONVERSATIONAL_RESTRAINT|GROUP_SOCIAL_OUTPUT/)
    assert.match(buildSystemPrompt('椰椰'), /GROUP_REPLY_PRESSURE/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testOwnerChatSkipsGroupFinalizationAndGroupStillUsesIt(): Promise<void> {
  const originalFetch = globalThis.fetch
  const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const ownerEvents: string[] = []
  const groupEvents: string[] = []
  const answer = `\`\`\`ts\n${Array.from({ length: 30 }, (_, index) =>
    `const sample${index} = "${'x'.repeat(36)}";`,
  ).join('\n')}\n\`\`\``
  const sinkFor = (events: string[]): PersistentRuntimeLogSink => ({
    writeStructured: (event: string) => events.push(event),
  } as unknown as PersistentRuntimeLogSink)

  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> })
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const assistantRuntime = createTrustedAssistantRuntimeFacts('椰椰', true, 'Owner', 'Creator')
    const ownerService = new ChatService('http://owner-chat.test/v1', 'test-key', 'test-model', sinkFor(ownerEvents))
    const ownerResult = await ownerService.reply(
      [],
      {
        senderId: '',
        senderName: 'OWNER_CHAT_OPERATOR',
        text: '请解释这段代码。',
        timestamp: Date.now(),
        messageId: randomUUID(),
      },
      {
        surface: 'OWNER_CHAT',
        conversationType: 'GROUP',
        botDisplayName: '椰椰',
        assistantRuntime,
        mention: 'NOT_APPLICABLE',
        requesterRole: 'OWNER',
        ownerConfigured: true,
        groupReplyPressure: 'HIGH',
        memory: [],
        persistentMemoryAvailable: false,
        memoryMutationThisTurn: 'NONE',
        ownerChatRecentContext: [],
      },
      [],
      sinkFor(ownerEvents),
      randomUUID(),
    )
    assert.equal(ownerResult, answer, 'Owner Chat must preserve a long structured answer')
    const ownerGroupStages = [
      'GROUP_REPLY_LENGTH',
      'GROUP_CONVERSATIONAL_RESTRAINT',
      'GROUP_SOCIAL_OUTPUT_BOUNDARY',
      'GROUP_BULK_OUTPUT_BOUNDARY',
    ]
    for (const stage of ownerGroupStages) {
      assert.equal(ownerEvents.includes(stage), false, `Owner Chat invoked ${stage}`)
    }
    assert(ownerEvents.includes('ANSWER_GUARD'), 'generic Answer Guard was skipped')
    assert(ownerEvents.includes('CHAT_RENDERER'), 'surface-neutral chat renderer was skipped')
    const ownerPrompt = payloads[0]?.messages.map((message) => message.content).join('\n') ?? ''
    assert.doesNotMatch(ownerPrompt, /GROUP_REPLY_PRESSURE|GROUP_CONVERSATIONAL_RESTRAINT|GROUP_SOCIAL_OUTPUT_BOUNDARY|GROUP_BULK_OUTPUT_BOUNDARY/)

    const groupService = new ChatService('http://owner-chat.test/v1', 'test-key', 'test-model', sinkFor(groupEvents))
    const groupResult = await groupService.reply(
      [],
      {
        senderId: 'member-1',
        senderName: 'Member',
        text: '请解释这段代码。',
        timestamp: Date.now(),
        messageId: randomUUID(),
      },
      {
        surface: 'GROUP',
        conversationType: 'GROUP',
        botDisplayName: '椰椰',
        assistantRuntime,
        mention: 'NOT_MENTIONED',
        requesterRole: 'MEMBER',
        ownerConfigured: false,
        groupReplyPressure: 'HIGH',
        memory: [],
      },
      [],
      sinkFor(groupEvents),
      randomUUID(),
    )
    assert.notEqual(groupResult, answer, 'GROUP bulk boundary no longer bounds the original path')
    for (const stage of [
      'GROUP_REPLY_LENGTH',
      'GROUP_CONVERSATIONAL_RESTRAINT',
      'GROUP_SOCIAL_OUTPUT_BOUNDARY',
      'GROUP_BULK_OUTPUT_BOUNDARY',
    ]) {
      assert(groupEvents.includes(stage), `GROUP request skipped ${stage}`)
    }
    const groupPrompt = payloads[1]?.messages.map((message) => message.content).join('\n') ?? ''
    assert.match(groupPrompt, /GROUP_REPLY_PRESSURE=HIGH/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testOwnerChatProviderControlRepairIsRetained(): Promise<void> {
  const originalFetch = globalThis.fetch
  const payloads: Array<{ messages: Array<{ role: string; content: string }> }> = []
  const events: string[] = []
  let calls = 0
  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> })
    const content = calls++ === 0 ? '<|minimax|>tool_call' : '修复后的安全答复。'
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const sink = {
      writeStructured: (event: string) => events.push(event),
    } as unknown as PersistentRuntimeLogSink
    const service = new ChatService('http://owner-chat.test/v1', 'test-key', 'test-model', sink)
    const answer = await service.replyOwnerChat(
      '测试 provider repair',
      [],
      createTrustedAssistantRuntimeFacts('椰椰', true, 'Owner', 'Creator'),
      randomUUID(),
    )
    assert.equal(answer, '修复后的安全答复。')
    assert.equal(calls, 2, 'provider-control repair must remain enabled for Owner Chat')
    assert(events.includes('PROVIDER_CONTROL_BOUNDARY'))
    const repairSystem = payloads[1]?.messages.find((message) => message.role === 'system')?.content ?? ''
    assert.match(repairSystem, /Owner Chat/)
    assert.doesNotMatch(repairSystem, /GROUP_REPLY_PRESSURE|GROUP_CONVERSATIONAL_RESTRAINT|GROUP_SOCIAL_OUTPUT_BOUNDARY|GROUP_BULK_OUTPUT_BOUNDARY/)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testOwnerChatPromptCarriesTrustedRelationshipQueryFact(): Promise<void> {
  const assistantRuntime = createTrustedAssistantRuntimeFacts('椰椰', true, 'Owner', 'Creator')
  const prompt = buildUserPrompt(
    [],
    {
      senderId: '',
      senderName: 'OWNER_CHAT_OPERATOR',
      text: '椰椰的创建者是谁？',
      timestamp: Date.now(),
      messageId: 'owner-chat-relationship-query',
    },
    {
      surface: 'OWNER_CHAT',
      botDisplayName: '椰椰',
      assistantRuntime,
      mention: 'NOT_APPLICABLE',
      requesterRole: 'OWNER',
      ownerConfigured: true,
      memory: [],
      persistentMemoryAvailable: false,
      memoryMutationThisTurn: 'NONE',
      ownerChatRecentContext: [],
    },
  )
  assert.match(prompt, /ASSISTANT_RELATIONSHIP_QUERY=CREATOR/)
}

async function main(): Promise<void> {
  await testProtocolValidationAndCorrelation()
  await testTransportRoutesBeforeInboundPipeline()
  await testTransportErrorsFailClosed()
  await testOwnerChatHandlerUsesTrustedFactsAndNoMemoryService()
  await testOwnerChatPromptGuardAndGroupIsolation()
  await testOwnerChatSkipsGroupFinalizationAndGroupStillUsesIt()
  await testOwnerChatProviderControlRepairIsRetained()
  await testOwnerChatPromptCarriesTrustedRelationshipQueryFact()
  console.log('OWNER_CHAT_TESTS=PASS cases=8')
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
