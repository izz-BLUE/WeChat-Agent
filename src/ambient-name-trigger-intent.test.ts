/**
 * AMBIENT_NAME_TRIGGERED_REPLY send-intent acceptance suite.
 *
 * The deterministic name trigger stays the single owner of the wake decision;
 * this suite pins the intent plumbing around it: the declared outboundIntent on
 * the proactive poll wire, the untouched reply path, the quoted-context
 * semantics and the serialization contract. No WeChat runtime, no real send.
 */
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { runRawAgentPipeline, runRawPassiveContextPipeline } from './agent-adapter.js'
import { ChatService } from './chat.js'
import type { MemoryService } from './memory-service.js'
import type { RawHookMessage } from './message-contract.js'
import { GroupAmbientContext } from './group-ambient-context.js'
import { RequesterLocalContext } from './requester-local-context.js'
import { detectOwnerAliasWake } from './owner-alias-wake.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import { ProductionAgentTransportServer } from './production-agent-transport.js'
import {
  AMBIENT_NAME_TRIGGERED_REPLY,
  OWNER_COMMANDED_DISPATCH,
  PROACTIVE_MESSAGE,
  PROACTIVE_OUTBOUND_INTENTS,
  ProactiveGroupQueue,
} from './proactive-group-queue.js'
import { readFileSync } from 'node:fs'

const GROUP = 'ambient-intent@chatroom'
const MEMBER = 'member-ambient-intent'
const BASE_TIME = 1_757_000_000_000

let cases = 0
let failures = 0

async function check(name: string, body: () => Promise<void> | void): Promise<void> {
  cases += 1
  try {
    await body()
    console.log(`[AMBIENT_INTENT_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(`[AMBIENT_INTENT_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
  }
}

interface ProviderStub {
  calls: Array<{ system: string; user: string }>
  restore(): void
}

function stubProvider(answer = '接上了，确实挺像他的。'): ProviderStub {
  const calls: Array<{ system: string; user: string }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role: string; content: string }>
    }
    const messages = body.messages ?? []
    calls.push({ system: messages[0]?.content ?? '', user: messages[1]?.content ?? '' })
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: answer } }] }),
    }
  }) as unknown as typeof fetch
  return {
    calls,
    restore: () => { globalThis.fetch = original },
  }
}

function raw(
  content: string,
  overrides: Partial<RawHookMessage> = {},
): RawHookMessage {
  const messageId = overrides.msgId ?? `ambient-${content}`
  const from = overrides.from ?? GROUP
  const signature = overrides.signature ?? MEMBER
  return {
    msgId: messageId,
    type: 1,
    timestamp: overrides.timestamp ?? BASE_TIME,
    from,
    wxid: 'shared-wxid',
    content,
    signature,
    senderName: null,
    isMentioned: false,
    conversationType: 'GROUP',
    conversationId: from,
    senderId: signature,
    requesterId: signature,
    requesterSource: 'Signature',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    ownerDisplayName: null,
    userContentSpan: { start: 0, length: content.length },
    ...overrides,
  }
}

/** Exact C# PASSIVE_CONTEXT_ONLY payload shape: no active authority fields. */
function realPassiveWire(
  content: string,
  overrides: Partial<RawHookMessage> = {},
): RawHookMessage {
  const messageId = overrides.msgId ?? `ambient-passive-${content}`
  const from = overrides.from ?? GROUP
  const signature = overrides.signature ?? MEMBER
  return {
    msgId: messageId,
    type: 1,
    timestamp: overrides.timestamp ?? BASE_TIME,
    from,
    wxid: 'shared-wxid',
    content,
    signature,
    conversationType: 'GROUP',
    conversationId: from,
    senderId: signature,
    requesterId: signature,
    requesterSource: 'Signature',
    publicDisplayName: null,
    isMentioned: false,
    userContentSpan: { start: 0, length: content.length },
    ...overrides,
  }
}

function makeMemory(counters: { selfAddress: number; explicit: number; observe: number; retrieve: number }): MemoryService {
  return {
    isEnabled: true,
    tryHandleSelfAddressPreference: () => {
      counters.selfAddress += 1
      return { handled: false, reply: '' }
    },
    tryHandleExplicit: async () => {
      counters.explicit += 1
      return { handled: false, reply: '' }
    },
    observeHumanMessage: () => { counters.observe += 1 },
    retrieveForChat: async () => {
      counters.retrieve += 1
      return []
    },
  } as unknown as MemoryService
}

function makeAgent(options: {
  provider?: ProviderStub
  proactiveQueue?: ProactiveGroupQueue
} = {}): ProductionChatAgent {
  const provider = options.provider ?? stubProvider()
  const counters = { selfAddress: 0, explicit: 0, observe: 0, retrieve: 0 }
  const chat = new ChatService('https://provider.invalid/v1', 'key', 'model')
  return new ProductionChatAgent(chat, {
    ambientContext: new GroupAmbientContext(),
    requesterLocalContext: new RequesterLocalContext(),
    memory: makeMemory(counters),
    runtimeClock: { now: () => new Date(BASE_TIME) },
    // Benign planner stubs: the reply path must produce its outbound command
    // without either planner contributing anything.
    webSearchPlanner: {
      plan: async () => ({
        result: 'FAIL' as const,
        decision: {
          action: 'DIRECT' as const,
          query: null,
          reasonCode: 'DIRECT_SUFFICIENT' as const,
          mode: 'GENERAL' as const,
          recencyWindow: 'NONE' as const,
        },
      }),
    },
    ownerDispatchPlanner: {
      plan: async () => ({
        result: 'FAIL' as const,
        decision: { action: 'CHAT' as const, message: null },
      }),
    },
    proactiveQueue: options.proactiveQueue,
  })
}

async function captureThenAliasWake(agent: ProductionChatAgent, message: RawHookMessage): Promise<void> {
  const captured = await runRawPassiveContextPipeline(message, agent)
  assert.equal(captured.status, 'PASSIVE_CONTEXT')
  const match = detectOwnerAliasWake(captured.context.text)
  assert(match, 'expected the deterministic trigger to match')
  assert(agent.handleOwnerAliasWake)
  await agent.handleOwnerAliasWake({ ...captured.context, matchedAliasClass: match.matchedAliasClass })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

async function readLine(socket: ReturnType<typeof createConnection>): Promise<Record<string, unknown>> {
  let buffer = ''
  while (!buffer.includes('\n')) {
    const chunk = await new Promise<string>((resolve, reject) => {
      const onData = (value: Buffer | string): void => {
        socket.off('error', onError)
        resolve(value.toString())
      }
      const onError = (error: Error): void => {
        socket.off('data', onData)
        reject(error)
      }
      socket.once('data', onData)
      socket.once('error', onError)
    })
    buffer += chunk
  }
  return JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as Record<string, unknown>
}

async function main(): Promise<void> {
  const nameTrigger = async (content: string, messageId: string): Promise<void> => {
    const provider = stubProvider()
    const queue = new ProactiveGroupQueue()
    try {
      const agent = makeAgent({ provider, proactiveQueue: queue })
      await captureThenAliasWake(agent, realPassiveWire(content, { msgId: messageId }))
      assert.equal(provider.calls.length, 1)
      assert.equal(queue.size, 1)
      const command = agent.pollProactiveOutbound()
      assert(command, 'expected one queued proactive command')
      assert.equal(command.outboundIntent, AMBIENT_NAME_TRIGGERED_REPLY)
      assert.equal(command.conversationType, 'GROUP')
      assert.equal(command.conversationId, GROUP)
      assert.equal(command.requestMessageId.startsWith('proactive:'), true)
      // One command only: the wake is consumed by the first poll.
      assert.equal(agent.pollProactiveOutbound(), null)
    } finally {
      provider.restore()
    }
  }

  await check('ci-laoshi-wake-declares-ambient-intent', async () => {
    await nameTrigger('辞老师昨天说的那个事儿挺有意思', 'ambient-ci-laoshi')
  })

  await check('ci-lao-wake-declares-ambient-intent', async () => {
    await nameTrigger('辞老今天怎么没来', 'ambient-ci-lao')
  })

  await check('ci-shanshi-wake-declares-ambient-intent', async () => {
    await nameTrigger('问下辞山时这个怎么看', 'ambient-ci-shanshi')
  })

  await check('non-matching-message-produces-no-proactive-outbound', async () => {
    const provider = stubProvider()
    const queue = new ProactiveGroupQueue()
    try {
      const agent = makeAgent({ provider, proactiveQueue: queue })
      const captured = await runRawPassiveContextPipeline(
        realPassiveWire('老师今天没来，题目也难', { msgId: 'ambient-no-match' }),
        agent,
      )
      assert.equal(captured.status, 'PASSIVE_CONTEXT')
      assert.equal(provider.calls.length, 0)
      assert.equal(queue.size, 0)
      assert.equal(agent.pollProactiveOutbound(), null)
    } finally {
      provider.restore()
    }
  })

  await check('mention-reply-keeps-runtime-assigned-intent', async () => {
    const provider = stubProvider()
    try {
      const agent = makeAgent({ provider })
      const result = await runRawAgentPipeline(
        raw('@椰椰 辞老师昨天说了什么', { msgId: 'ambient-mention', isMentioned: true }),
        agent,
      )
      assert.equal(result.status, 'AGENT_RESULT')
      assert(result.outboundCommand, 'a mentioned reply must produce an outbound command')
      // The reply intent is assigned by the runtime per transport path; the
      // Agent reply command carries no declaration at all.
      assert.equal(result.outboundCommand.outboundIntent, undefined)
      assert.equal(!JSON.stringify(result.outboundCommand).includes('outboundIntent'), true)
    } finally {
      provider.restore()
    }
  })

  await check('quoted-context-only-name-does-not-wake', async () => {
    const provider = stubProvider()
    const queue = new ProactiveGroupQueue()
    try {
      const agent = makeAgent({ provider, proactiveQueue: queue })
      // Quoted messages are type 49: the passive ambient path has always
      // rejected them before any trigger scan, so a name living only in the
      // quote never wakes. Existing product semantics, pinned here.
      const passive = await runRawPassiveContextPipeline(
        realPassiveWire('看看这段', {
          msgId: 'ambient-quote-passive',
          type: 49,
          quotedContext: { text: '辞老师：这个方案不错' },
        }),
        agent,
      )
      assert.equal(passive.status, 'UNSUPPORTED')
      assert.equal(provider.calls.length, 0)
      assert.equal(queue.size, 0)

      // An active quoted mention stays a normal runtime-assigned reply.
      const active = await runRawAgentPipeline(
        raw('@椰椰 看看上面那段', {
          msgId: 'ambient-quote-active',
          isMentioned: true,
          type: 49,
          quotedContext: { text: '辞老师：这个方案不错' },
        }),
        agent,
      )
      assert.equal(active.status, 'AGENT_RESULT')
      assert(active.outboundCommand)
      assert.equal(active.outboundCommand.outboundIntent, undefined)
      assert.equal(queue.size, 0)
    } finally {
      provider.restore()
    }
  })

  await check('trigger-ownership-is-not-a-model-decision', async () => {
    const provider = stubProvider('辞老师觉得这个主意不错。')
    const queue = new ProactiveGroupQueue()
    try {
      const agent = makeAgent({ provider, proactiveQueue: queue })
      // The model output contains a trigger name, the group message does not:
      // no wake may be scheduled from generated text.
      const captured = await runRawPassiveContextPipeline(
        realPassiveWire('大家觉得这个方案怎么样', { msgId: 'ambient-model-output' }),
        agent,
      )
      assert.equal(captured.status, 'PASSIVE_CONTEXT')
      assert.equal(queue.size, 0)
      assert.equal(agent.pollProactiveOutbound(), null)
      // Conversely, when the deterministic trigger does fire, the intent is
      // stamped by the producer no matter what the model answered.
      await captureThenAliasWake(agent, realPassiveWire('辞老师思路清楚', { msgId: 'ambient-model-output-2' }))
      const command = agent.pollProactiveOutbound()
      assert(command)
      assert.equal(command.outboundIntent, AMBIENT_NAME_TRIGGERED_REPLY)
    } finally {
      provider.restore()
    }
  })

  await check('queue-rejects-undeclared-intents', () => {
    const queue = new ProactiveGroupQueue()
    assert.equal(queue.enqueue({
      conversationType: 'GROUP',
      conversationId: GROUP,
      text: 'text',
      intent: OWNER_COMMANDED_DISPATCH,
    }).accepted, true)
    const forged = queue.enqueue({
      conversationType: 'GROUP',
      conversationId: GROUP,
      text: 'text',
      intent: 'USER_TRIGGERED_REPLY' as never,
    })
    assert.equal(forged.accepted, false)
    const reserved = queue.enqueue({
      conversationType: 'GROUP',
      conversationId: GROUP,
      text: 'text',
      intent: PROACTIVE_MESSAGE,
    })
    // The wire contract still carries the reserved value; no production
    // producer may use it (see the producer census below).
    assert.equal(reserved.accepted, true)
    assert.deepEqual([...PROACTIVE_OUTBOUND_INTENTS], [
      'AMBIENT_NAME_TRIGGERED_REPLY',
      'OWNER_COMMANDED_DISPATCH',
      'PROACTIVE_MESSAGE',
    ])
  })

  await check('no-producer-emits-proactive-message', () => {
    // Structural census over the production sources. PROACTIVE_MESSAGE is a
    // reserved contract value, so the only legitimate occurrence is the closed
    // enum definition in the queue module. Every producer stamps its own
    // intent; none may claim the autonomous semantics. Paths run from the
    // compiled dist back to the sibling src tree of the repository layout.
    for (const file of ['production-agent-receiver.ts', 'production-agent-transport.ts', 'agent-adapter.ts']) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      assert.equal(!source.includes('PROACTIVE_MESSAGE'), true, `${file} must not reference the reserved intent`)
    }
    const queueSource = readFileSync(new URL('../src/proactive-group-queue.ts', import.meta.url), 'utf8')
    assert.equal(queueSource.includes("export const PROACTIVE_MESSAGE: ProactiveOutboundIntent = 'PROACTIVE_MESSAGE'"), true)
  })

  await check('poll-wire-serializes-the-declared-intent', async () => {
    const provider = stubProvider()
    const queue = new ProactiveGroupQueue()
    const agent = makeAgent({ provider, proactiveQueue: queue })
    const pipeName = `ambient-intent-${process.pid}-${Date.now()}`
    const server = new ProductionAgentTransportServer({ pipeName, agent })
    let socket: ReturnType<typeof createConnection> | undefined
    try {
      await server.start()
      socket = createConnection(`\\\\.\\pipe\\${pipeName}`)
      await new Promise<void>((resolve, reject) => {
        socket?.once('connect', resolve)
        socket?.once('error', reject)
      })
      socket.write(`${JSON.stringify({ kind: 'PASSIVE_CONTEXT_ONLY', message: realPassiveWire('辞老师来了', { msgId: 'ambient-wire' }) })}\n`)
      const response = await readLine(socket)
      assert.equal(response.kind, 'CONTEXT_ACCEPTED')
      await waitFor(() => queue.size === 1)
      socket.write('{"kind":"PROACTIVE_OUTBOUND_POLL","pollId":"poll-1"}\n')
      const proactive = await readLine(socket)
      assert.equal(proactive.kind, 'PROACTIVE_OUTBOUND_COMMAND')
      assert.equal(proactive.outboundIntent, AMBIENT_NAME_TRIGGERED_REPLY)
      // Round trip through JSON keeps the declaration intact.
      const roundTrip = JSON.parse(JSON.stringify(proactive)) as Record<string, unknown>
      assert.equal(roundTrip.outboundIntent, AMBIENT_NAME_TRIGGERED_REPLY)
      socket.write('{"kind":"PROACTIVE_OUTBOUND_POLL","pollId":"poll-2"}\n')
      const secondPoll = await readLine(socket)
      assert.equal(secondPoll.kind, 'NO_PROACTIVE_OUTBOUND')

      // The owner dispatch producers declare their own proactive-class intent.
      queue.enqueue({
        conversationType: 'GROUP',
        conversationId: GROUP,
        text: 'dispatch text',
        intent: OWNER_COMMANDED_DISPATCH,
      })
      socket.write('{"kind":"PROACTIVE_OUTBOUND_POLL","pollId":"poll-3"}\n')
      const dispatch = await readLine(socket)
      assert.equal(dispatch.kind, 'PROACTIVE_OUTBOUND_COMMAND')
      assert.equal(dispatch.outboundIntent, OWNER_COMMANDED_DISPATCH)
    } finally {
      socket?.destroy()
      await server.stop()
      provider.restore()
    }
  })

  console.log(`[AMBIENT_INTENT_SUMMARY] cases=${cases} failures=${failures}`)
  if (failures > 0) process.exit(1)
}

void main()
