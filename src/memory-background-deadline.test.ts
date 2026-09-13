import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatService } from './chat.js'
import type { AgentRequest } from './agent-adapter.js'
import { MemoryExtractor, type StructuredCompletion } from './memory-extractor.js'
import {
  MEMORY_AUTO_FLUSH_BATCH_SIZE,
  MemoryService,
  type ExplicitMemoryRequest,
} from './memory-service.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import { RequestDeadline } from './request-deadline.js'

const ROOM = 'memory-background-room@chatroom'
const REQUESTER = 'memory-background-requester'

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-memory-background-deadline-'))
  temporaryDirectories.push(directory)
  return directory
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createService(
  complete: StructuredCompletion,
  options: { backgroundTimeoutMs?: number; mutate?: StructuredCompletion } = {},
): { service: MemoryService; logs: string[] } {
  const logs: string[] = []
  const store = new MemoryStore({
    filePath: memoryFileIn(tempDir()),
    log: (message) => logs.push(message),
    pathSource: 'TEST',
  })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(complete),
    mutate: options.mutate ?? (async () => '{"operation":"NONE"}'),
    log: (message) => logs.push(message),
    enableTimer: false,
    backgroundTimeoutMs: options.backgroundTimeoutMs,
  })
  return { service, logs }
}

function observe(
  service: MemoryService,
  count: number,
  options: { chatTriggered?: boolean; deadline?: RequestDeadline; prefix?: string } = {},
): void {
  for (let index = 0; index < count; index += 1) {
    service.observeHumanMessage(
      {
        messageId: `${options.prefix ?? 'message'}-${index}`,
        conversationType: 'GROUP',
        conversationId: ROOM,
        requesterId: REQUESTER,
        requesterRole: 'MEMBER',
        speakerLabel: 'MEMBER_1',
        text: `第 ${index} 条消息`,
        timestamp: index,
        chatTriggered: options.chatTriggered ?? true,
      },
      options.deadline,
      'MEMORYBG',
    )
  }
}

function completionResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function foregroundRequest(messageId: string): AgentRequest {
  return {
    conversationKey: `group:${ROOM}`,
    messageId,
    conversationType: 'GROUP',
    conversationId: ROOM,
    senderId: REQUESTER,
    requesterId: REQUESTER,
    requesterSource: 'TEST',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    ownerDisplayName: null,
    publicDisplayName: '测试成员',
    senderName: '测试成员',
    text: '你好',
    timestamp: Date.now(),
    mentionState: 'MENTIONED',
    botMentionSpans: { trust: 'VALID', spans: [] },
    userContentSpan: { trust: 'VALID', span: { start: 0, length: 2 } },
    metadata: { rawMessageType: 1 },
  }
}

async function testAutoChatThresholdUsesIndependentDeadline(): Promise<void> {
  let extractorDeadline: RequestDeadline | undefined
  const harness = createService(async (_system, _user, deadline) => {
    extractorDeadline = deadline
    await delay(35)
    return '[]'
  }, { backgroundTimeoutMs: 150 })
  const foregroundDeadline = new RequestDeadline(10)

  observe(harness.service, 3, { deadline: foregroundDeadline, prefix: 'threshold' })
  await delay(20)
  assert.equal(foregroundDeadline.expired(), true, 'foreground deadline did not expire in the fixture')
  await harness.service.flushAll()

  assert.notEqual(extractorDeadline, foregroundDeadline, 'AUTO threshold reused foreground deadline')
  assert.equal(extractorDeadline?.budgetMs, 150, 'AUTO threshold did not use the configured background timeout')
  assert.match(harness.logs.join('\n'), /trigger=AUTO_CHAT_THRESHOLD.*result=PASS/u)
}

async function testAutoBatchUsesIndependentDeadline(): Promise<void> {
  let extractorDeadline: RequestDeadline | undefined
  const harness = createService(async (_system, _user, deadline) => {
    extractorDeadline = deadline
    return '[]'
  }, { backgroundTimeoutMs: 125 })
  const foregroundDeadline = new RequestDeadline(10)

  observe(harness.service, MEMORY_AUTO_FLUSH_BATCH_SIZE, {
    chatTriggered: false,
    deadline: foregroundDeadline,
    prefix: 'batch',
  })
  await harness.service.flushAll()

  assert.notEqual(extractorDeadline, foregroundDeadline, 'AUTO batch reused foreground deadline')
  assert.equal(extractorDeadline?.budgetMs, 125, 'AUTO batch did not use the configured background timeout')
  assert.match(harness.logs.join('\n'), /trigger=AUTO_BATCH.*result=PASS/u)
}

async function testTimerFlushUsesBoundedBackgroundDeadline(): Promise<void> {
  let extractorDeadline: RequestDeadline | undefined
  const harness = createService(async (_system, _user, deadline) => {
    extractorDeadline = deadline
    return '[]'
  }, { backgroundTimeoutMs: 100 })

  observe(harness.service, 3, { chatTriggered: false, prefix: 'timer' })
  harness.service.flushPendingBuffers()
  await harness.service.flushAll()

  assert.equal(extractorDeadline?.budgetMs, 100, 'timer flush did not use the bounded background timeout')
  assert.match(harness.logs.join('\n'), /trigger=AUTO_TIMER.*result=PASS/u)
}

async function testBackgroundTimeoutAbortsProviderAndRestoresBuffer(): Promise<void> {
  const originalFetch = globalThis.fetch
  let aborted = false
  const abortError = (): Error => Object.assign(new Error('background provider aborted'), { name: 'AbortError' })
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const abort = (): void => {
        aborted = true
        reject(abortError())
      }
      if (signal?.aborted) {
        abort()
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }) as typeof fetch

  try {
    const chat = new ChatService('https://provider.invalid/v1', 'test-key', 'test-model')
    const harness = createService(
      (system, user, deadline, msgIdToken) => chat.completeStructured(system, user, deadline, msgIdToken),
      { backgroundTimeoutMs: 25 },
    )
    observe(harness.service, 3, { prefix: 'timeout' })
    await harness.service.flushAll()

    assert.equal(aborted, true, 'background timeout did not abort the provider fetch')
    assert.match(harness.logs.join('\n'), /MEMORY_BACKGROUND_TIMEOUT.*result=TIMEOUT/u)
    assert.match(harness.logs.join('\n'), /trigger=AUTO_CHAT_THRESHOLD.*result=FAIL/u)

    globalThis.fetch = (async () => completionResponse('[]')) as typeof fetch
    harness.service.flushPendingBuffers()
    await harness.service.flushAll()
    assert.match(harness.logs.join('\n'), /trigger=AUTO_TIMER.*result=PASS/u)
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function testForegroundReplySurvivesBackgroundCompletion(): Promise<void> {
  const harness = createService(async () => {
    await delay(55)
    return '[]'
  }, { backgroundTimeoutMs: 200 })
  observe(harness.service, 2, { chatTriggered: false, prefix: 'foreground' })

  const chat = {
    async reply(): Promise<string> {
      await delay(5)
      return '前台回复'
    },
  } as unknown as ChatService
  const agent = new ProductionChatAgent(chat, {
    memory: harness.service,
    requestDeadlineMs: 100,
  })

  const result = await agent.complete(foregroundRequest('foreground-2'))
  assert.equal(result, '前台回复', 'background extraction changed a successful foreground reply')
  await delay(25)
  await harness.service.flushAll()
  assert.match(harness.logs.join('\n'), /trigger=AUTO_CHAT_THRESHOLD.*result=PASS/u)
}

async function testBackgroundFailureHasNoUnhandledRejection(): Promise<void> {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    const harness = createService(async () => {
      throw new Error('background extractor failure')
    })
    observe(harness.service, 3, { prefix: 'unhandled' })
    await harness.service.flushAll()
    await delay(0)

    assert.equal(unhandled.length, 0, 'background failure created an unhandled rejection')
    assert.match(harness.logs.join('\n'), /trigger=AUTO_CHAT_THRESHOLD.*result=FAIL/u)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}

async function testExplicitMemoryKeepsForegroundDeadline(): Promise<void> {
  let mutationDeadline: RequestDeadline | undefined
  const harness = createService(async () => '[]', {
    mutate: async (_system, _user, deadline) => {
      mutationDeadline = deadline
      return '{"operation":"NONE"}'
    },
  })
  const foregroundDeadline = new RequestDeadline(500)
  const request: ExplicitMemoryRequest = {
    conversationType: 'GROUP',
    conversationId: ROOM,
    requesterId: REQUESTER,
    requesterRole: 'OWNER',
    question: '记住我喜欢喝茶',
    mentionState: 'MENTIONED',
    botMentionSpanTrust: 'VALID',
    botMentionSpanCount: 1,
    userContentSpanTrust: 'VALID',
    requestDeadline: foregroundDeadline,
    msgIdToken: 'MEMORYBG',
  }

  const result = await harness.service.tryHandleExplicit(request)
  assert.equal(result.handled, true, 'explicit memory command was not handled')
  assert.equal(mutationDeadline, foregroundDeadline, 'explicit memory stopped using foreground deadline')
}

async function run(): Promise<void> {
  await testAutoChatThresholdUsesIndependentDeadline()
  await testAutoBatchUsesIndependentDeadline()
  await testTimerFlushUsesBoundedBackgroundDeadline()
  await testBackgroundTimeoutAbortsProviderAndRestoresBuffer()
  await testForegroundReplySurvivesBackgroundCompletion()
  await testBackgroundFailureHasNoUnhandledRejection()
  await testExplicitMemoryKeepsForegroundDeadline()
  console.log('[MEMORY_BACKGROUND_DEADLINE_TEST_SUMMARY] cases=7 failures=0 result=PASS')
}

try {
  await run()
} finally {
  for (const directory of temporaryDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Test cleanup must never mask the assertion result.
    }
  }
}
