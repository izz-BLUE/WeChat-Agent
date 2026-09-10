/**
 * Explicit remember provider-boundary regression tests.
 *
 * The response fixture mirrors an OpenAI-compatible DeepSeek-style response:
 * content is the only final-answer carrier, reasoning_content is a sibling
 * diagnostic carrier, and finish_reason is present on the choice.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatService } from './chat.js'
import { MemoryExtractor } from './memory-extractor.js'
import { MemoryService, mutationSystemPrompt, parseMemoryMutation } from './memory-service.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const REQUESTER = 'requester-internal-001'
const CONVERSATION = 'room-internal-001'
const temporaryDirectories: string[] = []

interface DeepSeekFixture {
  content: string
  reasoning_content?: string
  finish_reason?: string
}

interface ProviderStub {
  calls: Array<{ system: string; user: string }>
  restore(): void
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-agent-mutation-provider-'))
  temporaryDirectories.push(directory)
  return directory
}

function installProvider(fixture: DeepSeekFixture): ProviderStub {
  const original = globalThis.fetch
  const calls: Array<{ system: string; user: string }> = []
  const stub = async (_url: unknown, init?: { body?: unknown }): Promise<unknown> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role: string; content: string }>
    }
    const messages = body.messages ?? []
    calls.push({ system: messages[0]?.content ?? '', user: messages[1]?.content ?? '' })

    const message: Record<string, unknown> = {
      role: 'assistant',
      content: fixture.content,
    }
    if (fixture.reasoning_content !== undefined) {
      message.reasoning_content = fixture.reasoning_content
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message, finish_reason: fixture.finish_reason ?? 'stop' }],
      }),
    }
  }
  globalThis.fetch = stub as unknown as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

function deepSeekAddFixture(): DeepSeekFixture {
  return {
    content: '<think>需要确认是新增个人事实。</think>\n```json\n{"type":"ADD","target":null,"content":"我叫辞老师","scope":"OWNER"}\n```',
    reasoning_content: '确认后只在 content 中返回结构化 mutation。',
    finish_reason: 'stop',
  }
}

async function runExplicit(fixture: DeepSeekFixture, question: string): Promise<{
  reply: string
  records: ReturnType<MemoryStore['retrieve']>
  logs: string[]
  calls: Array<{ system: string; user: string }>
}> {
  const directory = tempDirectory()
  const logs: string[] = []
  const providerLogs: string[] = []
  const provider = installProvider(fixture)
  const store = new MemoryStore({ filePath: memoryFileIn(directory), log: (line) => logs.push(line), pathSource: 'TEST' })
  const chat = new ChatService('https://provider.invalid/v1', 'test-key', 'test-model')
  const originalConsoleLog = console.log
  console.log = (...args: unknown[]) => {
    providerLogs.push(args.map((value) => String(value)).join(' '))
  }
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: (system, user) => chat.completeStructured(system, user),
    idFactory: () => 'memory-001',
    now: () => 1_757_000_000_000,
    log: (line) => logs.push(line),
  })

  try {
    const result = await service.tryHandleExplicit({
      conversationType: 'GROUP',
      conversationId: CONVERSATION,
      requesterId: REQUESTER,
      requesterRole: 'OWNER',
      question,
      // A persistent memory side effect needs the runtime's own mention verdict;
      // the boundary itself (absent / invalid / non-bot mention) is covered by
      // `bot-mention-span.test.ts`.
      mentionState: 'MENTIONED',
      botMentionSpanTrust: 'VALID',
      botMentionSpanCount: 1,
    })
    const records = store.retrieve([{ scopeType: 'OWNER', scopeId: REQUESTER, visibility: 'SHARED' }], 4)
    return { reply: result.reply, records, logs: [...logs, ...providerLogs], calls: provider.calls }
  } finally {
    console.log = originalConsoleLog
    service.close()
    provider.restore()
  }
}

/** Red test: the prompt must describe the semantic ADD mapping explicitly. */
async function testPromptMapsRememberFormsToAdd(): Promise<void> {
  const prompt = mutationSystemPrompt()
  assert(prompt.includes('记住我叫'), 'mutation prompt does not name the natural name form')
  assert(prompt.includes('记住我是'), 'mutation prompt does not name the natural self form')
  assert(prompt.includes('记住我的代号是'), 'mutation prompt does not name the natural codename form')
  assert(prompt.includes('"operation":"ADD"'), 'mutation prompt does not require a top-level ADD operation')
}

/** Cases 1-3. A DeepSeek-shaped final content must write all three expressions. */
async function testRememberForm(question: string): Promise<void> {
  const result = await runExplicit(deepSeekAddFixture(), question)
  assert(result.reply === '记住了。', `${question} did not return written semantics: ${result.reply}`)
  assert(result.records.length === 1, `${question} wrote ${result.records.length} records`)
  assert(result.records[0]?.content === '我叫辞老师', `${question} wrote unexpected content`)
  assert(result.logs.some((line) => line.includes('[MEMORY_WRITE]') && line.includes('result=WRITTEN')), `${question} did not emit WRITTEN`)
  assert(result.calls[0]?.system.includes('记住'), `${question} did not reach mutation system prompt`)
  assert(result.calls[0]?.user.includes(question), `${question} did not reach mutation user prompt`)
}

/** Case 4-5. Reasoning is present, while valid final JSON is fenced and preceded by <think>. */
async function testReasoningCarrierIsIgnoredButFinalContentIsUsed(): Promise<void> {
  const result = await runExplicit(deepSeekAddFixture(), '记住我叫辞老师')
  assert(result.logs.some((line) => line.includes('reasoningFields=reasoning_content')), 'reasoning_content was not observed at the provider boundary')
  assert(result.logs.some((line) => line.includes('removedThinkingBlocks=1')), 'thinking block was not stripped at the provider boundary')
  assert(result.records.length === 1, 'valid final content was not used when reasoning_content was present')
}

/** Case 6. JSON in reasoning_content alone must never become a mutation. */
async function testReasoningOnlyFailsClosed(): Promise<void> {
  const result = await runExplicit({
    content: '',
    reasoning_content: '{"operation":"ADD","target":null,"content":"我叫辞老师","scope":"OWNER"}',
    finish_reason: 'stop',
  }, '记住我叫辞老师')
  assert(result.reply === '这条记忆没有保存成功。', 'reasoning-only response returned a success reply')
  assert(result.records.length === 0, 'reasoning-only JSON was persisted')
  assert(!result.logs.some((line) => line.includes('[MEMORY_WRITE]')), 'reasoning-only response reached MEMORY_WRITE')
}

/** Case 7. Non-JSON content remains fail closed and receives safe parse diagnostics. */
async function testInvalidStructureFailsClosedWithSafeDiagnostics(): Promise<void> {
  const result = await runExplicit({
    content: '<think>字段结构不符合约定。</think>\n```json\n{"type":"ADD","target":null,"content":{"text":"我叫辞老师"},"scope":"OWNER"}\n```',
    reasoning_content: '模型内部推理',
    finish_reason: 'stop',
  }, '记住我叫辞老师')
  assert(result.reply === '这条记忆没有保存成功。', 'invalid structured response returned a success reply')
  assert(result.records.length === 0, 'invalid structured response was persisted')
  const trigger = result.logs.find((line) => line.includes('[MEMORY_TRIGGER]') && line.includes('reason=MUTATION_NONE')) ?? ''
  assert(trigger.includes('mutationParseResult='), 'MUTATION_NONE did not include parse result')
  assert(trigger.includes('mutationType=NONE'), 'MUTATION_NONE did not include mutation type')
  assert(trigger.includes('schemaValid=false'), 'invalid schema was not diagnosed as invalid')
  assert(trigger.includes('contentPresent=true'), 'present provider content was not diagnosed')
  assert(/contentChars=\d+/.test(trigger), 'content character count was not diagnosed')
  assert(!trigger.includes('我叫辞老师'), 'raw provider content leaked into diagnostics')
}

/** A schema-valid NONE is diagnosed separately from malformed provider output. */
async function testModelNoneIsDistinguishable(): Promise<void> {
  const result = await runExplicit({
    content: '<think>无法确认变更。</think>\n{"operation":"NONE","target":null,"content":null,"scope":null}',
    reasoning_content: '模型内部推理',
    finish_reason: 'stop',
  }, '记住我叫辞老师')
  assert(result.reply === '这条记忆没有保存成功。', 'model NONE returned a success reply')
  assert(result.records.length === 0, 'model NONE was persisted')
  const trigger = result.logs.find((line) => line.includes('[MEMORY_TRIGGER]') && line.includes('reason=MUTATION_NONE')) ?? ''
  assert(trigger.includes('mutationParseResult=MODEL_NONE'), 'schema-valid model NONE was not diagnosed')
  assert(trigger.includes('schemaValid=true'), 'schema-valid model NONE was diagnosed as invalid')
  assert(trigger.includes('mutationType=NONE'), 'model NONE did not carry mutation type')
}

/** Case 8. The raw-identity guard remains the final fail-closed boundary. */
async function testRawIdentityGuardRegression(): Promise<void> {
  const result = await runExplicit({
    ...deepSeekAddFixture(),
    content: '<think>确认新增。</think>\n```json\n{"type":"ADD","target":null,"content":"wxid_other 的代号是辞老师","scope":"OWNER"}\n```',
  }, '记住我叫辞老师')
  assert(result.reply === '这条记忆没有保存成功。', 'raw identity candidate returned a success reply')
  assert(result.records.length === 0, 'raw identity candidate was persisted')
  assert(result.logs.some((line) => line.includes('[MEMORY_WRITE]') && line.includes('RAW_IDENTITY_IN_CONTENT')), 'raw identity guard did not reject the candidate')
}

/** A parser-level sanity check keeps arbitrary natural language from becoming ADD. */
async function testFreeTextDoesNotGuessMutation(): Promise<void> {
  const mutation = parseMemoryMutation('请记住这件事：我叫辞老师。')
  assert(mutation.operation === 'NONE', 'free text was guessed as a mutation')
}

async function main(): Promise<void> {
  let failures = 0
  const cases: Array<[string, () => Promise<void>]> = [
    ['prompt-add-contract', testPromptMapsRememberFormsToAdd],
    ['remember-name-form', () => testRememberForm('记住我叫辞老师')],
    ['remember-is-form', () => testRememberForm('记住我是辞老师')],
    ['remember-codename-form', () => testRememberForm('记住我的代号是辞老师')],
    ['reasoning-content-fence', testReasoningCarrierIsIgnoredButFinalContentIsUsed],
    ['reasoning-only-fail-closed', testReasoningOnlyFailsClosed],
    ['invalid-structure-diagnostics', testInvalidStructureFailsClosedWithSafeDiagnostics],
    ['model-none-diagnostics', testModelNoneIsDistinguishable],
    ['raw-identity-guard', testRawIdentityGuardRegression],
    ['free-text-fail-closed', testFreeTextDoesNotGuessMutation],
  ]

  try {
    for (const [name, run] of cases) {
      try {
        await run()
        console.log(`[MUTATION_PROVIDER_CASE] name=${name} result=PASS`)
      } catch (error) {
        failures += 1
        console.error(`[MUTATION_PROVIDER_CASE] name=${name} result=FAIL error=${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    for (const directory of temporaryDirectories) {
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch {
        // Cleanup must not hide the case result.
      }
    }
  }

  console.log(`[MUTATION_PROVIDER_SUMMARY] cases=${cases.length} failures=${failures}`)
  if (failures > 0) {
    process.exitCode = 1
  }
}

void main()
