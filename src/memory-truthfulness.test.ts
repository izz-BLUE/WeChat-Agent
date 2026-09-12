/**
 * Red-capable regression seam for the final-answer Memory truthfulness boundary.
 *
 * The first draft deliberately claims a successful persistent-memory mutation.
 * The runtime has no mutation evidence for this ordinary Chat turn, so the
 * outbound boundary must regenerate once and then fail closed if the repair is
 * still an unsupported claim.
 */
import { guardFinalAnswer, type AnswerGuardFacts } from './answer-guard.js'
import { ChatService, type ChatRequestContext } from './chat.js'
import type { GroupMessage } from './context.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function ordinaryRequest(): ChatRequestContext {
  return {
    botDisplayName: '椰椰',
    mention: 'MENTIONED',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    memory: [],
    memoryMutationThisTurn: 'NONE',
  }
}

function question(): GroupMessage {
  return {
    senderId: 'requester-a',
    senderName: 'MEMBER_1',
    text: '我不吃香菜',
    timestamp: 1,
    messageId: 'memory-truthfulness-1',
  }
}

async function testUnsupportedClaimsAreBlocked(): Promise<void> {
  const facts: AnswerGuardFacts = { memoryMutationThisTurn: 'NONE' }
  const cases = [
    '记住了。',
    '记下了。',
    '已经记好了。',
    '我已经帮你保存好了。',
    '这个我已经存进记忆了。',
    '以后我都会记得。',
    '下次我还会记得这件事。',
    '已经从记忆里删掉了。',
    '已经从词库删了。',
    '这条记忆已经删除。',
    '我已经忘掉了这条记录。',
    '你的这个偏好已经移除了。',
    '我已经把你的称呼更新到长期记忆。',
    '记忆已经改成新的了。',
    '我已经修改了你的长期记忆。',
    '你的偏好已经更新到记忆里。',
  ]

  for (const draft of cases) {
    const result = guardFinalAnswer(draft, facts)
    assert(result.outcome === 'BLOCKED', `unsupported claim was not blocked: ${draft}`)
    assert(result.regenerable, `unsupported claim was not regenerable: ${draft}`)
    assert(result.detections.some((entry) => String(entry.kind) === 'UNSUPPORTED_MEMORY_MUTATION_CLAIM'),
      `missing memory mutation detection: ${draft}`)
  }
}

async function testExplanationsAndQuotesStayClean(): Promise<void> {
  const facts: AnswerGuardFacts = { memoryMutationThisTurn: 'NONE' }
  const cases = [
    '“记住了”这句话容易让人误以为真的保存了长期记忆。',
    '如果保存成功，系统应该明确返回成功状态。',
    '你刚才问的是怎么删除记忆。',
    '这段代码里的 delete 是删除数据库记录。',
    '我把你发来的这段文案改好了：已经保存成功。',
    '我已经保存好了这个文件。',
  ]

  for (const draft of cases) {
    const result = guardFinalAnswer(draft, facts)
    assert(result.outcome === 'CLEAN', `ordinary explanation was blocked: ${draft}`)
  }
}

async function testOneBoundedRegeneration(): Promise<void> {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const calls: string[] = []
  const users: string[] = []
  const logs: string[] = []
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> }
    calls.push(body.messages?.[0]?.content ?? '')
    users.push(body.messages?.[1]?.content ?? '')
    const content = calls.length === 1 ? '好嘞，记下了！以后不会忘。' : '知道了，你这次说的是不吃香菜。'
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }
  }) as unknown as typeof fetch
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '))

  try {
    const chat = new ChatService('https://provider.invalid/v1', 'test-key', 'test-model')
    const answer = await chat.reply([], question(), ordinaryRequest(), [], undefined, 'memory-truthfulness-1')
    assert(answer === '知道了，你这次说的是不吃香菜。', `unsafe first draft escaped: ${answer}`)
    assert(calls.length === 2, `expected one bounded regeneration, got ${calls.length} calls`)
    assert(users[1]?.includes('MEMORY_MUTATION_THIS_TURN=NONE'),
      'regeneration did not receive the trusted Memory mutation fact')
    assert(logs.some((line) => line.includes('[MEMORY_TRUTHFULNESS_BOUNDARY]') &&
      line.includes('mutationThisTurn=NONE') && line.includes('claimDetected=true') &&
      line.includes('result=REGENERATED') && line.includes('reason=UNSUPPORTED_MEMORY_MUTATION_CLAIM')),
      'regenerated Memory truthfulness result was not observable')
  } finally {
    console.log = originalLog
    globalThis.fetch = originalFetch
  }
}

async function testRepeatedViolationFailsClosed(): Promise<void> {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const calls: string[] = []
  const logs: string[] = []
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> }
    calls.push(body.messages?.[0]?.content ?? '')
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '还是记住了。' } }] }) }
  }) as unknown as typeof fetch
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '))

  try {
    const chat = new ChatService('https://provider.invalid/v1', 'test-key', 'test-model')
    let failed = false
    try {
      await chat.reply([], question(), ordinaryRequest(), [], undefined, 'memory-truthfulness-2')
    } catch {
      failed = true
    }
    assert(failed, 'repeated unsupported Memory claim was sent')
    assert(calls.length === 2, `repeated violation used ${calls.length} provider calls`)
    assert(logs.some((line) => line.includes('[MEMORY_TRUTHFULNESS_BOUNDARY]') &&
      line.includes('mutationThisTurn=NONE') && line.includes('claimDetected=true') &&
      line.includes('result=FAIL_CLOSED') && line.includes('reason=UNSUPPORTED_MEMORY_MUTATION_CLAIM')),
      'failed-closed Memory truthfulness result was not observable')
  } finally {
    console.log = originalLog
    globalThis.fetch = originalFetch
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => Promise<void>]> = [
    ['unsupported-claims-are-blocked', testUnsupportedClaimsAreBlocked],
    ['explanations-and-quotes-stay-clean', testExplanationsAndQuotesStayClean],
    ['one-bounded-regeneration', testOneBoundedRegeneration],
    ['repeated-violation-fails-closed', testRepeatedViolationFailsClosed],
  ]
  let failures = 0
  for (const [name, run] of cases) {
    try {
      await run()
      console.log(`[MEMORY_TRUTHFULNESS_CASE] name=${name} result=PASS`)
    } catch (error) {
      failures += 1
      console.log(`[MEMORY_TRUTHFULNESS_CASE] name=${name} result=FAIL message=${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(`[MEMORY_TRUTHFULNESS_TEST_SUMMARY] cases=${cases.length} failures=${failures}`)
  if (failures > 0) process.exitCode = 1
}

void main()
