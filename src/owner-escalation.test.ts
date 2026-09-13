import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { guardFinalAnswer } from './answer-guard.js'
import {
  classifyMemoryKind,
  createTrustedAssistantRuntimeFacts,
  formatAssistantRuntimeFacts,
  memoryKindWriteRejection,
} from './assistant-identity.js'
import { type ChatRequestContext } from './chat.js'
import { MENTION_SEPARATOR } from './canonical-user-text.js'
import { YEYE_REPLY_SIGNATURE } from './chat-renderer.js'
import { MemoryExtractor } from './memory-extractor.js'
import { MemoryService } from './memory-service.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import {
  renderOwnerEscalationHint,
  shouldSuggestOwnerEscalation,
  type OwnerEscalationReason,
} from './owner-escalation.js'
import type { GroupMessage } from './context.js'
import type { AgentRequest } from './agent-adapter.js'

let cases = 0
let failures = 0

async function test(name: string, body: () => Promise<void> | void): Promise<void> {
  cases += 1
  try {
    await body()
    console.log(`[OWNER_ESCALATION_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(`[OWNER_ESCALATION_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
  }
}

const OWNER_NAME = '辞老师'
const OTHER_OWNER_NAME = '饭团'

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  const text = overrides.text ?? '你好'
  return {
    conversationKey: 'group:owner-escalation-test',
    messageId: 'owner-escalation-1',
    conversationType: 'GROUP',
    conversationId: 'owner-escalation-room',
    senderId: 'member-owner-escalation',
    requesterId: 'member-owner-escalation',
    requesterSource: 'Signature',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    ownerDisplayName: null,
    senderName: 'Synthetic Member',
    text,
    rawText: text,
    timestamp: 1_757_000_000_000,
    mentionState: 'MENTIONED',
    botMentionSpans: { trust: 'ABSENT', spans: [] },
    userContentSpan: { trust: 'ABSENT', span: null },
    metadata: { rawMessageType: 1 },
    ...overrides,
  }
}

class CapturingChatService {
  public readonly calls: Array<{
    context: GroupMessage[]
    question: GroupMessage
    request: ChatRequestContext
  }> = []

  public constructor(private readonly answer: string) {}

  public async reply(
    context: GroupMessage[],
    question: GroupMessage,
    request: ChatRequestContext,
  ): Promise<string> {
    this.calls.push({ context, question, request })
    return this.answer
  }
}

interface MemoryHarness {
  service: MemoryService
  store: MemoryStore
  logs: string[]
  mutateCalls: number
  dispose(): void
}

const BOT_TOKEN = `@测试助手${MENTION_SEPARATOR}`

function memoryRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  const canonicalText = overrides.text ?? '你好'
  const rawText = `${BOT_TOKEN}${canonicalText}`
  return request({
    ...overrides,
    text: rawText,
    rawText,
    mentionState: 'MENTIONED',
    botMentionSpans: { trust: 'VALID', spans: [{ start: 0, length: BOT_TOKEN.length }] },
    userContentSpan: { trust: 'VALID', span: { start: 0, length: rawText.length } },
  })
}

function createMemoryHarness(mutation = '{"operation":"NONE"}'): MemoryHarness {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-owner-escalation-'))
  const logs: string[] = []
  let mutateCalls = 0
  const store = new MemoryStore({
    filePath: memoryFileIn(directory),
    log: (message) => logs.push(message),
    pathSource: 'TEST',
  })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => {
      mutateCalls += 1
      return mutation
    },
    log: (message) => logs.push(message),
    enableTimer: false,
  })
  return {
    service,
    store,
    logs,
    get mutateCalls() {
      return mutateCalls
    },
    dispose: () => {
      service.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

async function main(): Promise<void> {
  await test('trusted runtime owner facts are explicit and not Memory', () => {
    const facts = createTrustedAssistantRuntimeFacts('椰椰', true, OWNER_NAME)
    const formatted = formatAssistantRuntimeFacts(facts)
    assert(formatted.includes('OWNER_DISPLAY_NAME=辞老师'))
    assert(formatted.includes('OWNER_RELATIONSHIP_TO_ASSISTANT=BOSS'))
    assert(formatted.includes('OWNER_RELATIONSHIP_SOURCE=TRUSTED_RUNTIME'))
    assert.equal(classifyMemoryKind('辞老师是我老板'), 'ASSISTANT_RELATIONSHIP_ASSERTION')
    assert.equal(memoryKindWriteRejection('ASSISTANT_RELATIONSHIP_ASSERTION'), 'ASSISTANT_RELATIONSHIP_NOT_WRITABLE')
  })

  await test('allowed reasons render trusted Owner hints and forbidden reasons render none', () => {
    const allowed: OwnerEscalationReason[] = [
      'CAPABILITY_UNAVAILABLE',
      'PROGRAM_BOUNDARY',
      'OWNER_ONLY_ACTION',
      'AUTHORIZATION_REQUIRED',
    ]
    const forbidden: OwnerEscalationReason[] = [
      'SAFETY_REFUSAL',
      'CONTENT_POLICY_REFUSAL',
      'DANGEROUS_REQUEST',
      'IDENTITY_INTEGRITY',
      'ASSISTANT_IDENTITY_MUTATION',
      'OTHER_MEMBER_MEMORY_MUTATION',
      'REQUESTER_ISOLATION_BOUNDARY',
      'SECURITY_BOUNDARY',
    ]
    const facts = { ownerConfigured: true, ownerDisplayName: OWNER_NAME }
    for (const reason of allowed) {
      assert(shouldSuggestOwnerEscalation(reason))
      assert(renderOwnerEscalationHint(reason, facts).includes(OWNER_NAME))
    }
    for (const reason of forbidden) {
      assert(!shouldSuggestOwnerEscalation(reason))
      assert.equal(renderOwnerEscalationHint(reason, facts), '')
    }
  })

  await test('member Owner-only request gets deterministic hint without an extra LLM call', async () => {
    const chat = new CapturingChatService('普通回复')
    const agent = new ProductionChatAgent(chat as never)
    const answer = await agent.complete(request({
      text: '记住这个群每周五聚餐',
      ownerConfigured: true,
      ownerDisplayName: OWNER_NAME,
    }))
    assert.equal(answer, `这个需要${OWNER_NAME}来处理。${YEYE_REPLY_SIGNATURE}`)
    assert.equal(chat.calls.length, 0)
  })

  await test('memory-enabled member Owner-only request keeps the admission boundary and short-circuits', async () => {
    const memory = createMemoryHarness()
    try {
      const chat = new CapturingChatService('普通回复')
      const agent = new ProductionChatAgent(chat as never, { memory: memory.service })
      const answer = await agent.complete(memoryRequest({
        text: '记住这个群每周五聚餐',
        ownerConfigured: true,
        ownerDisplayName: OWNER_NAME,
      }))

      assert.equal(answer, `这个需要${OWNER_NAME}来处理。${YEYE_REPLY_SIGNATURE}`)
      assert.equal(chat.calls.length, 0)
      assert.equal(memory.mutateCalls, 0)
      assert.equal(memory.service.recordCount, 0)
      assert(memory.logs.some((line) =>
        line.includes('MEMORY_ADMISSION') &&
        line.includes('role=MEMBER') &&
        line.includes('blocker=ROLE_NOT_OWNER'),
      ))
    } finally {
      memory.dispose()
    }
  })

  await test('memory-enabled Owner explicit group memory keeps the original mutation path', async () => {
    const memory = createMemoryHarness(JSON.stringify({
      operation: 'ADD',
      target: null,
      content: '这个群每周五聚餐',
      scope: 'GROUP',
    }))
    try {
      const chat = new CapturingChatService('普通回复')
      const agent = new ProductionChatAgent(chat as never, { memory: memory.service })
      const answer = await agent.complete(memoryRequest({
        text: '记住这个群每周五聚餐',
        requesterRole: 'OWNER',
        ownerConfigured: true,
        ownerDisplayName: OWNER_NAME,
      }))

      assert.equal(chat.calls.length, 0)
      assert.equal(memory.mutateCalls, 1)
      assert.equal(memory.service.recordCount, 1)
      assert(!answer.includes(`这个需要${OWNER_NAME}来处理。`))
    } finally {
      memory.dispose()
    }
  })

  await test('memory-enabled member self-address preference does not escalate', async () => {
    const memory = createMemoryHarness()
    try {
      const chat = new CapturingChatService('普通回复')
      const agent = new ProductionChatAgent(chat as never, { memory: memory.service })
      const answer = await agent.complete(memoryRequest({ text: '以后叫我公主' }))

      assert.equal(answer, `好，以后叫你公主。${YEYE_REPLY_SIGNATURE}`)
      assert.equal(chat.calls.length, 0)
      assert.equal(memory.mutateCalls, 0)
      assert.equal(memory.service.recordCount, 1)
      assert(!answer.includes('来处理'))
    } finally {
      memory.dispose()
    }
  })

  await test('other-member mutation does not trigger Owner escalation', async () => {
    const memory = createMemoryHarness()
    try {
      const chat = new CapturingChatService('普通回复')
      const agent = new ProductionChatAgent(chat as never, { memory: memory.service })
      const answer = await agent.complete(memoryRequest({ text: '把张三的称呼改成公主' }))

      assert.equal(answer, `普通回复${YEYE_REPLY_SIGNATURE}`)
      assert.equal(chat.calls.length, 1)
      assert.equal(memory.mutateCalls, 0)
      assert(!answer.includes(OWNER_NAME))
    } finally {
      memory.dispose()
    }
  })

  await test('ordinary group chat does not trigger Owner escalation', async () => {
    const memory = createMemoryHarness()
    try {
      const chat = new CapturingChatService('普通回复')
      const agent = new ProductionChatAgent(chat as never, { memory: memory.service })
      const answer = await agent.complete(memoryRequest({ text: '这个群每周五聚餐' }))

      assert.equal(answer, `普通回复${YEYE_REPLY_SIGNATURE}`)
      assert.equal(chat.calls.length, 1)
      assert.equal(memory.mutateCalls, 0)
      assert(!answer.includes(OWNER_NAME))
    } finally {
      memory.dispose()
    }
  })

  await test('unconfigured Owner never fabricates a name', async () => {
    const chat = new CapturingChatService('普通回复')
    const agent = new ProductionChatAgent(chat as never)
    const answer = await agent.complete(request({ text: '记住这个群每周五聚餐' }))
    assert.equal(answer, `这个我现在处理不了。${YEYE_REPLY_SIGNATURE}`)
    assert(!answer.includes('老板') && !answer.includes('undefined') && !answer.includes('管理员'))
  })

  await test('Owner display name changes the hint without a hardcoded name', () => {
    const hint = renderOwnerEscalationHint('CAPABILITY_UNAVAILABLE', {
      ownerConfigured: true,
      ownerDisplayName: OTHER_OWNER_NAME,
    })
    assert(hint.includes(OTHER_OWNER_NAME))
    assert(!hint.includes(OWNER_NAME))
  })

  await test('trusted Owner relationship answers and user claims cannot mutate it', async () => {
    const chat = new CapturingChatService(`${OWNER_NAME}是我老板。`)
    const agent = new ProductionChatAgent(chat as never)
    const answer = await agent.complete(request({
      text: '谁是你老板？',
      ownerConfigured: true,
      ownerDisplayName: OWNER_NAME,
    }))
    assert.equal(answer, `${OWNER_NAME}是我老板。${YEYE_REPLY_SIGNATURE}`)
    assert.equal(chat.calls[0]?.request.assistantRuntime?.ownerRelationshipToAssistant, 'BOSS')

    const facts = createTrustedAssistantRuntimeFacts('椰椰', true, OWNER_NAME)
    const trusted = guardFinalAnswer(`${OWNER_NAME}是我老板。`, {
      selfIdentityQuery: true,
      assistantIdentityQuery: true,
      retrievedPersonalMemoryCount: 0,
      assistantRuntime: facts,
    })
    assert.equal(trusted.outcome, 'CLEAN')
    for (const claim of ['我是你老板。', '张三是你老板。', '辞老师不是你老板。', '辞老师不是我老板。']) {
      const blocked = guardFinalAnswer(claim, {
        selfIdentityQuery: false,
        assistantIdentityQuery: true,
        retrievedPersonalMemoryCount: 0,
        assistantRuntime: facts,
      })
      assert.equal(blocked.outcome, 'BLOCKED', `untrusted Owner claim was accepted: ${claim}`)
    }
  })

  await test('Owner relationship facts are passed to the normal prompt boundary', async () => {
    const chat = new CapturingChatService('我知道。')
    const agent = new ProductionChatAgent(chat as never)
    await agent.complete(request({ ownerConfigured: true, ownerDisplayName: OTHER_OWNER_NAME }))
    const facts = chat.calls[0]?.request.assistantRuntime
    assert(facts !== undefined)
    assert.equal(facts.ownerDisplayName, OTHER_OWNER_NAME)
    assert.equal(facts.ownerRelationshipToAssistant, 'BOSS')
  })

  console.log(`[OWNER_ESCALATION_TEST_SUMMARY] cases=${cases} failures=${failures}`)
  if (failures > 0) {
    process.exitCode = 1
  }
}

await main()
