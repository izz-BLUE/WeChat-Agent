/**
 * BOT_MENTION_SPAN — the contract-level regression for the P0 found by the audit:
 * the Agent removed EVERY `@name` + U+2005 token it could find, which deleted real
 * mentions of other members and could turn a sentence addressed to a member into a
 * persistent-memory command.
 *
 * The fix is a wire fact: the runtime publishes the spans of the BOT's own mention
 * tokens (`botMentionSpans`), produced by the same single mention scan that decides
 * the mention state. The Agent removes exactly those spans, so:
 *
 *  - a mention of another member survives into the transcript and the final prompt;
 *  - a non-command cannot become a command by losing someone else's framing;
 *  - an older runtime that publishes no spans can still chat, but cannot cause a
 *    persistent-memory side effect.
 *
 * Every case drives the real stages:
 *
 *   RawHookMessage -> normalizeRawHookMessage -> toAgentRequest
 *     -> ProductionChatAgent.complete -> canonicalUserText(spans)
 *     -> MemoryService.tryHandleExplicit -> the mutation structured completion
 *
 * Synthetic fixtures only. The runtime's own scan is covered by the C# suite
 * `BotMentionSpan`; here the spans are supplied exactly as that scan produces them.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toAgentRequest } from './agent-adapter.js'
import {
  canonicalUserText,
  resolveBotMentionSpans,
  MENTION_SEPARATOR,
  type BotMentionSpan,
} from './canonical-user-text.js'
import { ChatService } from './chat.js'
import { GroupAmbientContext } from './group-ambient-context.js'
import { MemoryExtractor } from './memory-extractor.js'
import { isExplicitMemoryCommand, MemoryService } from './memory-service.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'
import { normalizeRawHookMessage, type RawHookMessage } from './message-contract.js'
import { ProductionChatAgent } from './production-agent-receiver.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

// --------------------------------------------------------------- test harness

const BOT_NAME = '测试助手'
const MEMBER_NAME = '张三'
const BOT_TOKEN = `@${BOT_NAME}${MENTION_SEPARATOR}`
const MEMBER_TOKEN = `@${MEMBER_NAME}${MENTION_SEPARATOR}`
const ROOM = 'room-span-contract@chatroom'
const OWNER = 'requester-span-contract-owner'
const NOW = 1_757_000_000_000

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-agent-span-contract-'))
  temporaryDirectories.push(directory)
  return directory
}

function cleanup(): void {
  for (const directory of temporaryDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Temp cleanup must never fail the suite.
    }
  }
}

/** Exactly what the runtime's scan publishes: every bot token, nothing else. */
function botSpansFor(text: string): BotMentionSpan[] {
  const spans: BotMentionSpan[] = []
  let index = text.indexOf(BOT_TOKEN)
  while (index >= 0) {
    spans.push({ start: index, length: BOT_TOKEN.length })
    index = text.indexOf(BOT_TOKEN, index + BOT_TOKEN.length)
  }
  return spans
}

interface ProviderCall {
  system: string
  user: string
}

function completion(content: string): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }),
  }
}

interface Harness {
  agent: ProductionChatAgent
  store: MemoryStore
  finalCalls: ProviderCall[]
  mutationCalls: ProviderCall[]
  logs: string[]
  restore(): void
}

function createHarness(): Harness {
  const finalCalls: ProviderCall[] = []
  const mutationCalls: ProviderCall[] = []
  const logs: string[] = []
  const originalLog = console.log
  console.log = (message?: unknown) => {
    logs.push(typeof message === 'string' ? message : String(message))
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role: string; content: string }>
    }
    const messages = body.messages ?? []
    const system = messages[0]?.content ?? ''
    if (system.includes('记忆变更解析器')) {
      mutationCalls.push({ system, user: messages[1]?.content ?? '' })
      return completion('{"operation":"NONE","target":null,"content":null,"scope":null}')
    }
    finalCalls.push({ system, user: messages[1]?.content ?? '' })
    return completion('收到。')
  }) as unknown as typeof fetch

  const store = new MemoryStore({ filePath: memoryFileIn(tempDir()), log: (m) => logs.push(m), pathSource: 'TEST' })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: (system, user) => new ChatService('https://provider.invalid/v1', 'k', 'm').completeStructured(system, user),
    log: (m) => logs.push(m),
  })
  const agent = new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'k', 'm'), {
    memory: service,
    ambientContext: new GroupAmbientContext({ sink: undefined, now: () => NOW }),
  })
  return {
    agent,
    store,
    finalCalls,
    mutationCalls,
    logs,
    restore: () => {
      globalThis.fetch = originalFetch
      console.log = originalLog
    },
  }
}

interface Turn {
  content: string
  msgId: string
  /** undefined = publish the spans the runtime would compute; null = old wire. */
  spans?: BotMentionSpan[] | null
  isMentioned?: boolean
}

async function ask(harness: Harness, turn: Turn): Promise<string> {
  const raw: RawHookMessage = {
    msgId: turn.msgId,
    type: 1,
    timestamp: NOW,
    from: ROOM,
    wxid: 'shared-account-synthetic',
    content: turn.content,
    signature: OWNER,
    senderName: 'Synthetic Sender',
    isMentioned: turn.isMentioned ?? true,
    conversationType: 'GROUP',
    conversationId: ROOM,
    senderId: OWNER,
    requesterId: OWNER,
    requesterSource: 'Signature',
    requesterRole: 'OWNER',
    ownerConfigured: true,
    botMentionSpans: turn.spans === undefined ? botSpansFor(turn.content) : turn.spans,
  }
  const normalized = normalizeRawHookMessage(raw)
  assert(normalized.status === 'VALID', `the synthetic contract message was rejected: ${normalized.status}`)
  return harness.agent.complete(toAgentRequest(normalized.message))
}

const realLog = console.log.bind(console)

function admissionLine(harness: Harness): string {
  return harness.logs.filter((line) => line.includes('[MEMORY_ADMISSION]')).pop() ?? ''
}

function report(label: string, harness: Harness): void {
  realLog(`[SPAN_ADMISSION] case=${label} ${admissionLine(harness)}`)
}

function finalCallCount(harness: Harness): number {
  return harness.finalCalls.length
}

function mutationCallCount(harness: Harness): number {
  return harness.mutationCalls.length
}

function seedOwnerMemory(harness: Harness): void {
  const status = harness.store.add({
    memoryId: 'span-seed',
    scopeType: 'OWNER',
    scopeId: OWNER,
    content: '我叫辞老师',
    contentHash: '',
    visibility: 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: ROOM,
    sourceSenderId: OWNER,
    createdAt: NOW,
    updatedAt: NOW,
    isDeleted: false,
  })
  assert(status === 'WRITTEN', `seed write failed: ${status}`)
}

// ---------------------------------------------------------------- the cases

/** Case A: bot only. The span removes the envelope and the command is admitted. */
async function testCaseABotOnly(): Promise<void> {
  const harness = createHarness()
  try {
    seedOwnerMemory(harness)
    const content = `${BOT_TOKEN}记住我不吃香菜`
    await ask(harness, { content, msgId: 'span-a' })

    report('A/bot-only', harness)
    assert(canonicalUserText(content, resolveBotMentionSpans(content, botSpansFor(content))) === '记住我不吃香菜', 'the bot envelope was not removed')
    assert(mutationCallCount(harness) === 1, `mutation provider calls=${mutationCallCount(harness)}`)
    assert(finalCallCount(harness) === 0, `final provider calls=${finalCallCount(harness)}`)
    assert(admissionLine(harness).includes('result=ADMITTED'), `the command was not admitted: ${admissionLine(harness)}`)
  } finally {
    harness.restore()
  }
}

/** Case B: another member only. The mention must survive into the final prompt. */
async function testCaseBOtherOnly(): Promise<void> {
  const harness = createHarness()
  try {
    seedOwnerMemory(harness)
    const content = `${MEMBER_TOKEN}你怎么看？`
    await ask(harness, { content, msgId: 'span-b' })

    report('B/other-only', harness)
    assert(mutationCallCount(harness) === 0, 'a member-addressed question entered the mutation path')
    assert(finalCallCount(harness) === 1, `final provider calls=${finalCallCount(harness)}`)
    const prompt = harness.finalCalls[0] as ProviderCall
    assert(prompt.user.includes(MEMBER_NAME), 'the member mention was deleted from the prompt')
    assert(prompt.user.includes(MEMBER_TOKEN), 'the member mention token was deleted from the prompt')
    assert(!prompt.user.includes(BOT_TOKEN), 'a bot token appeared in the prompt')
  } finally {
    harness.restore()
  }
}

/** Case C: other + bot. Both rules at once. */
async function testCaseCOtherAndBot(): Promise<void> {
  const harness = createHarness()
  try {
    seedOwnerMemory(harness)
    const content = `${MEMBER_TOKEN}你先看\n${BOT_TOKEN}你也说说`
    await ask(harness, { content, msgId: 'span-c' })

    report('C/other+bot', harness)
    const canonical = canonicalUserText(content, resolveBotMentionSpans(content, botSpansFor(content)))
    assert(canonical.includes(MEMBER_TOKEN), `the member mention was removed: ${JSON.stringify(canonical)}`)
    assert(!canonical.includes(BOT_TOKEN), `the bot envelope survived: ${JSON.stringify(canonical)}`)
    assert(mutationCallCount(harness) === 0, 'a two-addressee sentence entered the mutation path')
    assert(finalCallCount(harness) === 1, `final provider calls=${finalCallCount(harness)}`)
    const prompt = harness.finalCalls[0] as ProviderCall
    assert(prompt.user.includes(MEMBER_NAME), 'the member mention was deleted from the prompt')
    assert(!prompt.user.includes(BOT_TOKEN), 'a bot token appeared in the prompt')
  } finally {
    harness.restore()
  }
}

/** Case D: the P0 shape, multi-line. Not a command, and it must not become one. */
async function testCaseDMultiLineP0(): Promise<void> {
  const harness = createHarness()
  try {
    seedOwnerMemory(harness)
    const content = `${MEMBER_TOKEN}记住我不吃香菜\n${BOT_TOKEN}你怎么看`
    await ask(harness, { content, msgId: 'span-d' })

    report('D/p0-multiline', harness)
    const canonical = canonicalUserText(content, resolveBotMentionSpans(content, botSpansFor(content)))
    assert(canonical.startsWith(MEMBER_TOKEN), `the canonical text lost its member addressee: ${JSON.stringify(canonical)}`)
    assert(!isExplicitMemoryCommand(canonical), `the canonical text was read as a command: ${JSON.stringify(canonical)}`)
    assert(mutationCallCount(harness) === 0, 'the P0 multi-line shape reached the mutation path')
    assert(finalCallCount(harness) === 1, `final provider calls=${finalCallCount(harness)}`)
    const prompt = harness.finalCalls[0] as ProviderCall
    assert(prompt.user.includes(MEMBER_NAME), 'the member mention was deleted from the prompt')
  } finally {
    harness.restore()
  }
}

/** Case E: the P0 shape on one line, so no single-line rule could have saved it. */
async function testCaseESingleLineP0(): Promise<void> {
  const harness = createHarness()
  try {
    seedOwnerMemory(harness)
    const content = `${MEMBER_TOKEN}记住我不吃香菜 ${BOT_TOKEN}你怎么看`
    await ask(harness, { content, msgId: 'span-e' })

    report('E/p0-single-line', harness)
    const canonical = canonicalUserText(content, resolveBotMentionSpans(content, botSpansFor(content)))
    assert(canonical.startsWith(MEMBER_TOKEN), `the canonical text lost its member addressee: ${JSON.stringify(canonical)}`)
    assert(!isExplicitMemoryCommand(canonical), `the canonical text was read as a command: ${JSON.stringify(canonical)}`)
    assert(mutationCallCount(harness) === 0, 'the P0 single-line shape reached the mutation path')
    assert(finalCallCount(harness) === 1, `final provider calls=${finalCallCount(harness)}`)
  } finally {
    harness.restore()
  }
}

/** Case F: two bot tokens. Both removed; no other text touched. */
async function testCaseFTwoBotTokens(): Promise<void> {
  const harness = createHarness()
  try {
    seedOwnerMemory(harness)
    const content = `${BOT_TOKEN}记住我不吃香菜 ${BOT_TOKEN}`
    await ask(harness, { content, msgId: 'span-f' })

    report('F/two-bot-tokens', harness)
    const facts = resolveBotMentionSpans(content, botSpansFor(content))
    assert(facts.trust === 'VALID' && facts.spans.length === 2, `expected two trusted spans, got ${facts.spans.length}`)
    const canonical = canonicalUserText(content, facts)
    assert(canonical === '记住我不吃香菜', `two bot tokens did not collapse cleanly: ${JSON.stringify(canonical)}`)
    assert(mutationCallCount(harness) === 1, `mutation provider calls=${mutationCallCount(harness)}`)
    assert(finalCallCount(harness) === 0, `final provider calls=${finalCallCount(harness)}`)
    assert(
      !(harness.mutationCalls[0]?.user ?? '').includes(MENTION_SEPARATOR),
      'a bot token reached the mutation prompt',
    )
  } finally {
    harness.restore()
  }
}

/**
 * Case F2: the SAME shape with padding the contract trims.
 *
 * Spans index the wire body, so a body whose last character is the picker separator
 * (which `trim()` removes, because U+2005 is Unicode whitespace) moves every offset
 * if the trimmed view is used. This case is why the raw body is carried: with the
 * trimmed view the claim would look out of range, the side effect would fail closed
 * forever, and the failure would look exactly like a grammar miss.
 */
async function testCaseFPaddedBody(): Promise<void> {
  const shapes: Array<[string, string]> = [
    ['trailing separator', `${BOT_TOKEN}记住我不吃香菜 ${BOT_TOKEN}`],
    ['trailing newline', `${BOT_TOKEN}记住我不吃香菜 \n`],
    ['leading whitespace', `  ${BOT_TOKEN}记住我不吃香菜`],
    ['leading newline', `\n${BOT_TOKEN}记住我不吃香菜`],
  ]
  for (const [name, content] of shapes) {
    const harness = createHarness()
    try {
      seedOwnerMemory(harness)
      await ask(harness, { content, msgId: `span-f2-${name.length}` })

      report(`F2/padded/${name}`, harness)
      const admission = admissionLine(harness)
      assert(admission.includes('botMentionSpanValid=true'), `${name}: the claim was invalidated by padding: ${admission}`)
      assert(admission.includes('result=ADMITTED'), `${name}: a padded command was not admitted: ${admission}`)
      assert(mutationCallCount(harness) === 1, `${name}: mutation provider calls=${mutationCallCount(harness)}`)
      assert(finalCallCount(harness) === 0, `${name}: final provider calls=${finalCallCount(harness)}`)
    } finally {
      harness.restore()
    }
  }
}

/** Case G: old wire. Chat works; the memory side effect fails closed. */
async function testCaseGOldWire(): Promise<void> {
  const harness = createHarness()
  try {
    seedOwnerMemory(harness)
    const content = '记住我不吃香菜'
    await ask(harness, { content, msgId: 'span-g', spans: null })

    report('G/old-wire', harness)
    const admission = admissionLine(harness)
    assert(admission.includes('botMentionSpanAbsent=true'), `the absent claim was not reported: ${admission}`)
    assert(admission.includes('result=CHAT'), `an old-wire command was admitted: ${admission}`)
    assert(
      admission.includes('reason=UNTRUSTED_BOT_MENTION_SPAN'),
      `the refusal reason is wrong: ${admission}`,
    )
    assert(mutationCallCount(harness) === 0, 'an old-wire message reached the mutation path')
    assert(finalCallCount(harness) === 1, `final provider calls=${finalCallCount(harness)}`)
    const prompt = harness.finalCalls[0] as ProviderCall
    assert(prompt.user.includes(content), 'the old-wire text did not reach the final prompt')
    assert(
      prompt.system.includes('普通聊天生成绝对不能声称本轮已经写入、删除或修改了长期记忆'),
      'the persistence grounding rule is missing under the old-wire fallback',
    )
  } finally {
    harness.restore()
  }
}

/** Case H: invalid spans. Chat works; the memory side effect fails closed. */
async function testCaseHInvalidSpans(): Promise<void> {
  const cases: Array<[string, BotMentionSpan[]]> = [
    ['out of range', [{ start: 0, length: 9999 }]],
    ['negative start', [{ start: -1, length: 4 }]],
    ['zero length', [{ start: 0, length: 0 }]],
    ['overlapping', [{ start: 0, length: 6 }, { start: 3, length: 6 }]],
    ['not a token', [{ start: 0, length: 3 }]],
  ]
  for (const [name, spans] of cases) {
    const harness = createHarness()
    try {
      seedOwnerMemory(harness)
      const content = `${BOT_TOKEN}记住我不吃香菜`
      await ask(harness, { content, msgId: `span-h-${name.length}`, spans })

      report(`H/invalid/${name}`, harness)
      const admission = admissionLine(harness)
      assert(admission.includes('botMentionSpanValid=false'), `${name}: an invalid claim was trusted: ${admission}`)
      assert(admission.includes('result=CHAT'), `${name}: an invalid claim admitted a command: ${admission}`)
      assert(mutationCallCount(harness) === 0, `${name}: an invalid claim reached the mutation path`)
      assert(finalCallCount(harness) === 1, `${name}: final provider calls=${finalCallCount(harness)}`)
      // No global fallback: the raw text is passed through untouched.
      const prompt = harness.finalCalls[0] as ProviderCall
      assert(prompt.user.includes(BOT_TOKEN), `${name}: an invalid claim still removed framing`)
    } finally {
      harness.restore()
    }
  }
}

// ------------------------------------------------------------------ execution

const CASES: Array<[string, () => Promise<void>]> = [
  ['case-a-bot-only-admits', testCaseABotOnly],
  ['case-b-other-only-preserved', testCaseBOtherOnly],
  ['case-c-other-and-bot', testCaseCOtherAndBot],
  ['case-d-p0-multiline-cannot-mutate', testCaseDMultiLineP0],
  ['case-e-p0-single-line-cannot-mutate', testCaseESingleLineP0],
  ['case-f-two-bot-tokens', testCaseFTwoBotTokens],
  ['case-f2-padded-body-keeps-span-valid', testCaseFPaddedBody],
  ['case-g-old-wire-fails-closed', testCaseGOldWire],
  ['case-h-invalid-spans-fail-closed', testCaseHInvalidSpans],
]

let failures = 0
for (const [name, run] of CASES) {
  try {
    await run()
    console.log(`[SPAN_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(`[SPAN_CASE] name=${name} result=FAIL message=${error instanceof Error ? error.message : String(error)}`)
  }
}

cleanup()
console.log(`[SPAN_SUMMARY] cases=${CASES.length} failures=${failures}`)
if (failures > 0) {
  console.log('[BOT_MENTION_SPAN] result=BLOCKED')
  process.exitCode = 1
} else {
  console.log('[BOT_MENTION_SPAN] result=PASS')
}
