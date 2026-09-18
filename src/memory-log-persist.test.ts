/**
 * Cross-process acceptance for the persistent runtime log on the memory chain.
 *
 * Requirement under test: `MEMORY_STORE` / `MEMORY_TRIGGER` / `MEMORY_READ` /
 * `MEMORY_WRITE` must be **durable**, and the short-term transcript must live in
 * its own `CONTEXT_*` namespace.
 *
 * The Agent's in-process suites (`memory-runtime-log.test.ts`) drive the real
 * components but share the process, which proves nothing about survival. This
 * suite therefore starts the real production receiver
 * (`dist/production-agent-receiver.js`) as a separate process with a temp
 * `WECHAT_LOG_PATH` and a temp `WECHAT_MEMORY_PATH`, points it at a local
 * OpenAI-compatible fake provider, drives admitted GROUP mentions through the real
 * named pipe, **stops the process**, and only then reads the file the receiver
 * wrote. A line can therefore only be asserted if it survived on disk.
 *
 * Privacy: the synthetic raw values are test fixtures, and the assertions prove
 * they never appear in the file.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const RECEIVER = join(HERE, 'production-agent-receiver.js')

// --------------------------------------------------------------- test harness

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-memory-log-persist-'))
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

const ROOM = 'room-log-persist@chatroom'
const REQUESTER = 'sig-log-persist-a'
const SENDER_NAME = 'Sender One'
const ACCOUNT_WXID = 'shared-account-wxid'
const API_KEY = 'test-key'
const QUESTION = '@椰椰 我的代号是什么？'
const CHATTER = '@椰椰 我们约定周五发版'
/** The fact the fake extractor returns; it must never reach the durable log. */
const MEMORY_FACT = 'A 的代号是 Alpha'
const REPLY_TEXT = '收到。'

/** Markers that route one structured completion inside the fake provider. */
const EXTRACTOR_PROMPT_MARKER = '长期记忆候选提取器'
const MUTATION_PROMPT_MARKER = '长期记忆变更解析器'

interface FakeProvider {
  baseUrl: string
  requestCount(): number
  close(): Promise<void>
}

/**
 * A local OpenAI-compatible endpoint. The reply path, the memory extractor and the
 * explicit-memory mutation parser all POST to the same `/chat/completions`, so the
 * fake routes on the system prompt it was given.
 */
function startFakeProvider(): Promise<FakeProvider> {
  let requests = 0
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests += 1
      let content = REPLY_TEXT
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages?: Array<{ role?: string; content?: string }>
        }
        const system = body.messages?.find((message) => message.role === 'system')?.content ?? ''
        if (system.includes(MUTATION_PROMPT_MARKER)) {
          content = '{"operation":"NONE"}'
        } else if (system.includes(EXTRACTOR_PROMPT_MARKER)) {
          content = `[{"scope":"MEMBER","content":"${MEMORY_FACT}","evidenceType":"EXPLICIT_SELF_STATEMENT","evidence":["M1"]}]`
        }
      } catch {
        // A body that does not parse still gets the plain reply: the test asserts
        // on the durable log, not on this endpoint.
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    })
  })

  return new Promise<FakeProvider>((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('the fake provider did not bind a TCP port'))
        return
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requestCount: () => requests,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

interface RawMessage {
  msgId: string
  type: number
  timestamp: number
  from: string
  wxid: string
  content: string
  signature: string
  senderName: string
  isMentioned: boolean
  conversationType: string
  conversationId: string
  senderId: string
  requesterId: string
  requesterSource: string
  requesterRole: string
  ownerConfigured: boolean
  userContentSpan: { start: number; length: number }
}

function inbound(raw: RawMessage): string {
  return `${JSON.stringify({ kind: 'INBOUND_MESSAGE', message: raw })}\n`
}

function groupMessage(msgId: string, content: string, isMentioned = true): RawMessage {
  return {
    msgId,
    type: 1,
    timestamp: 1_757_000_000_000,
    from: ROOM,
    wxid: ACCOUNT_WXID,
    content,
    signature: REQUESTER,
    senderName: SENDER_NAME,
    isMentioned,
    conversationType: 'GROUP',
    conversationId: ROOM,
    senderId: REQUESTER,
    requesterId: REQUESTER,
    requesterSource: 'Signature',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    userContentSpan: { start: 0, length: content.length },
  }
}

/** One durable line, split into the envelope and its `key=value` fields. */
interface DurableLine {
  component: string
  event: string
  fields: string[]
  raw: string
}

function parseDurable(text: string): DurableLine[] {
  const lines: DurableLine[] = []
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.length === 0) {
      continue
    }
    const parts = raw.split('|')
    if (parts.length < 5) {
      continue
    }
    lines.push({ component: parts[2] ?? '', event: parts[3] ?? '', fields: parts.slice(5), raw })
  }
  return lines
}

function fieldOf(line: DurableLine, name: string): string {
  const prefix = `${name}=`
  const found = line.fields.find((field) => field.startsWith(prefix))
  return found === undefined ? '' : found.slice(prefix.length)
}

function ofEvent(lines: readonly DurableLine[], event: string): DurableLine[] {
  return lines.filter((line) => line.event === event)
}

interface Receiver {
  child: ChildProcess
  pipeName: string
  logDirectory: string
  memoryDirectory: string
  /** The receiver's own stdout/stderr, captured for diagnostics only. */
  stdout: string[]
  stop(): Promise<void>
}

async function startReceiver(options: {
  logPath: string
  memoryDirectory: string
  apiBase: string
}): Promise<Receiver> {
  assert(existsSync(RECEIVER), `the receiver bundle is missing: ${RECEIVER}`)
  const pipeName = `dsh-memory-log-persist-${process.pid}-${Date.now().toString(36)}`
  const stdout: string[] = []

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WECHAT_LOG_PATH: options.logPath,
    WECHAT_MEMORY_PATH: options.memoryDirectory,
    BOT_MODE: 'chat',
    OPENAI_API_BASE: options.apiBase,
    OPENAI_API_KEY: API_KEY,
    OPENAI_MODEL: 'test-model',
  }
  // This suite asserts the documented unset-salt mode (`PROCESS_LOCAL`), so the
  // ambient salt is removed instead of inherited. No salt value is ever written.
  delete env.WECHAT_LOG_TOKEN_SALT

  const child = spawn(process.execPath, [RECEIVER, pipeName, 'real'], {
    cwd: HERE,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout.push(chunk)
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stdout.push(chunk)
  })

  const receiver: Receiver = {
    child,
    pipeName,
    logDirectory: options.logPath,
    memoryDirectory: options.memoryDirectory,
    stdout,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return
      }
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill()
        setTimeout(() => resolve(), 4000).unref()
      })
    },
  }

  // Wait for the transport to listen before connecting.
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (stdout.join('').includes('lifecycle=STARTED') || child.exitCode !== null) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return receiver
}

/** One request/response against the receiver's named pipe. */
function send(pipeName: string, payload: string, timeoutMs = 10_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket: Socket = connect(`\\\\.\\pipe\\${pipeName}`)
    const chunks: string[] = []
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('the receiver did not answer in time'))
    }, timeoutMs)

    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(payload, 'utf8')
    })
    socket.on('data', (chunk: string) => {
      chunks.push(chunk)
      if (chunk.includes('\n')) {
        clearTimeout(timer)
        socket.end()
        resolve(chunks.join(''))
      }
    })
    socket.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(chunks.join(''))
    })
  })
}

/** Every `agent-*.log` the receiver wrote, concatenated. */
function readReceiverLog(receiver: Receiver): string {
  if (!existsSync(receiver.logDirectory)) {
    return ''
  }
  const files = readdirSync(receiver.logDirectory)
    .filter((name) => name.startsWith('agent-') && name.endsWith('.log'))
    .sort()
  return files.map((name) => readFileSync(join(receiver.logDirectory, name), 'utf8')).join('')
}

/** Waits until the receiver's own file contains an event, or gives up. */
async function waitForDurableEvent(receiver: Receiver, event: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ofEvent(parseDurable(readReceiverLog(receiver)), event).length > 0) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

/** Drives the three admitted mentions that reach the chat flush threshold. */
async function driveAutomaticWrite(receiver: Receiver): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    const reply = await send(receiver.pipeName, inbound(groupMessage(`log-persist-chatter-${index}`, CHATTER)))
    assert(reply.includes('OUTBOUND_COMMAND'), `the receiver did not answer mention ${index}: ${reply}`)
  }
  assert(
    await waitForDurableEvent(receiver, 'MEMORY_WRITE'),
    `the automatic memory write never became durable: ${readReceiverLog(receiver)}`,
  )
}

// ------------------------------------------------------------------ the cases

/**
 * The four memory events survive the receiver process, with the fields a field RCA
 * needs: store load/save/enabled, the trigger and its result, the read scope and
 * counts, and the write scope/visibility/result.
 *
 * The write is driven for real: three admitted mentions reach the chat flush
 * threshold, the fake provider answers the extractor, and the record is persisted.
 * A fourth turn then asks the question the record answers.
 */
async function testMemoryRuntimeEventsSurviveTheProcess(): Promise<void> {
  const provider = await startFakeProvider()
  const receiver = await startReceiver({
    logPath: tempDir(),
    memoryDirectory: tempDir(),
    apiBase: provider.baseUrl,
  })
  try {
    assert(receiver.child.exitCode === null, `the receiver failed to start: ${receiver.stdout.join('')}`)
    await driveAutomaticWrite(receiver)

    const answer = await send(receiver.pipeName, inbound(groupMessage('log-persist-question', QUESTION)))
    assert(answer.includes('OUTBOUND_COMMAND'), `the receiver did not answer the question: ${answer}`)
    await receiver.stop()

    const text = readReceiverLog(receiver)
    assert(text.length > 0, 'the receiver wrote no persistent log at all')
    const lines = parseDurable(text)
    const events = [...new Set(lines.map((line) => line.event))]
    console.log(`[MEMORY_PERSIST_PROBE] durableEvents=${events.join(',')}`)
    console.log(`[MEMORY_PERSIST_PROBE] providerRequests=${provider.requestCount()}`)

    for (const event of ['MEMORY_STORE', 'MEMORY_TRIGGER', 'MEMORY_READ', 'MEMORY_WRITE']) {
      assert(events.includes(event), `the durable log has no ${event} event: ${events.join(',')}`)
    }

    const store = ofEvent(lines, 'MEMORY_STORE')
    assert(
      store.some((line) => fieldOf(line, 'operation') === 'LOAD' && fieldOf(line, 'result') === 'PASS'),
      'no durable MEMORY_STORE LOAD pass',
    )
    assert(
      store.some((line) => fieldOf(line, 'operation') === 'SAVE' && fieldOf(line, 'result') === 'PASS'),
      'no durable MEMORY_STORE SAVE pass',
    )
    assert(
      store.some((line) => fieldOf(line, 'operation') === 'INIT' && fieldOf(line, 'enabled') === 'true'),
      'the enabled store decision was not durable',
    )
    assert(
      store.every((line) => line.component === 'agent-memory'),
      `a store event was attributed to another component: ${store.map((line) => line.raw).join(' | ')}`,
    )

    const triggers = ofEvent(lines, 'MEMORY_TRIGGER')
    assert(
      triggers.some((line) => fieldOf(line, 'trigger') === 'AUTO_CHAT_THRESHOLD' && fieldOf(line, 'result') === 'PASS'),
      `the automatic threshold trigger was not durable: ${triggers.map((line) => line.raw).join(' | ')}`,
    )

    const reads = ofEvent(lines, 'MEMORY_READ')
    assert(
      reads.some((line) => fieldOf(line, 'scope') === 'MEMBER'),
      `no durable read reported the requester scope enum: ${reads.map((line) => line.raw).join(' | ')}`,
    )
    assert(
      reads.some(
        (line) =>
          fieldOf(line, 'result') === 'PASS' &&
          fieldOf(line, 'candidateCount') === '1' &&
          fieldOf(line, 'selectedCount') === '1',
      ),
      `the read that selected the written fact was not durable: ${reads.map((line) => line.raw).join(' | ')}`,
    )

    const writes = ofEvent(lines, 'MEMORY_WRITE')
    assert(
      writes.some(
        (line) =>
          fieldOf(line, 'scope') === 'MEMBER' &&
          fieldOf(line, 'visibility') === 'SHARED' &&
          fieldOf(line, 'result') === 'WRITTEN',
      ),
      `the durable write does not carry scope/visibility/result: ${writes.map((line) => line.raw).join(' | ')}`,
    )
  } finally {
    await receiver.stop()
    await provider.close()
  }
}

/**
 * The namespace split, measured on the receiver's own file: the transcript uses
 * `CONTEXT_READ` / `CONTEXT_APPEND`, the persistent memory uses `MEMORY_*`, and
 * each event is attributed to its own component. A log search for a memory read
 * can no longer return a transcript read.
 */
async function testContextEventsDoNotImpersonateMemoryEvents(): Promise<void> {
  const provider = await startFakeProvider()
  const receiver = await startReceiver({
    logPath: tempDir(),
    memoryDirectory: tempDir(),
    apiBase: provider.baseUrl,
  })
  try {
    await send(receiver.pipeName, inbound(groupMessage('log-persist-context-1', QUESTION)))
    // A group message that is not mentioned never enters the transcript or chat.
    await send(receiver.pipeName, inbound(groupMessage('log-persist-context-2', '无关聊天', false)))
    await receiver.stop()

    const lines = parseDurable(readReceiverLog(receiver))
    const contextEvents = ofEvent(lines, 'CONTEXT_APPEND').concat(ofEvent(lines, 'CONTEXT_READ'))
    console.log(`[MEMORY_PERSIST_PROBE] contextEvents=${contextEvents.length}`)

    assert(ofEvent(lines, 'CONTEXT_APPEND').length >= 1, 'the transcript append was not durable as CONTEXT_APPEND')
    assert(ofEvent(lines, 'CONTEXT_READ').length >= 1, 'the transcript read was not durable as CONTEXT_READ')
    assert(
      contextEvents.every((line) => line.component === 'agent-receiver'),
      `a transcript event was attributed to another component: ${contextEvents.map((line) => line.raw).join(' | ')}`,
    )
    assert(
      contextEvents.some((line) => fieldOf(line, 'phase') === 'context-append') &&
        contextEvents.some((line) => fieldOf(line, 'phase') === 'context-read'),
      'the transcript phases were not preserved',
    )
    assert(
      ofEvent(lines, 'MEMORY_READ')
        .concat(ofEvent(lines, 'MEMORY_WRITE'))
        .every((line) => !line.raw.includes('phase=context-')),
      'a MEMORY_READ / MEMORY_WRITE line still carries a transcript phase',
    )
    assert(
      ofEvent(lines, 'MEMORY_READ')
        .concat(ofEvent(lines, 'MEMORY_WRITE'), ofEvent(lines, 'MEMORY_TRIGGER'), ofEvent(lines, 'MEMORY_STORE'))
        .every((line) => line.component === 'agent-memory'),
      'a memory event was attributed to another component',
    )
  } finally {
    await receiver.stop()
    await provider.close()
  }
}

/**
 * The privacy contract and the token correlation mode on the receiver's file. The
 * raw ids, the member name, the message body, the extracted fact and the API key
 * are all fixtures here, and none of them may appear.
 */
async function testDurableLogPrivacyAndTokenMode(): Promise<void> {
  const provider = await startFakeProvider()
  const receiver = await startReceiver({
    logPath: tempDir(),
    memoryDirectory: tempDir(),
    apiBase: provider.baseUrl,
  })
  try {
    await driveAutomaticWrite(receiver)
    await send(receiver.pipeName, inbound(groupMessage('log-persist-privacy', QUESTION)))
    await receiver.stop()

    const text = readReceiverLog(receiver)
    assert(text.length > 0, 'the receiver wrote no persistent log at all')
    for (const forbidden of [
      REQUESTER,
      ROOM,
      SENDER_NAME,
      ACCOUNT_WXID,
      CHATTER,
      QUESTION,
      MEMORY_FACT,
      'Alpha',
      API_KEY,
      'wxid_',
    ]) {
      assert(!text.includes(forbidden), `the durable log carries a raw value: ${forbidden}`)
    }
    assert(!receiver.stdout.join('').includes(API_KEY), 'the API key reached stdout')

    const correlation = ofEvent(parseDurable(text), 'TOKEN_CORRELATION')
    assert(correlation.length === 1, `expected one TOKEN_CORRELATION line, got ${correlation.length}`)
    const line = correlation[0] as DurableLine
    console.log(`[MEMORY_PERSIST_PROBE] tokenCorrelation=${line.raw}`)
    assert(
      fieldOf(line, 'mode') === 'PROCESS_LOCAL',
      `the unset-salt boot mode is not PROCESS_LOCAL: ${line.raw}`,
    )
  } finally {
    await receiver.stop()
    await provider.close()
  }
}

/**
 * Requirement: a logging failure must not break chat. `WECHAT_LOG_PATH` points at a
 * regular file, so the persistent log can never create its directory; the receiver
 * must still admit the mention, reach the provider and answer.
 */
async function testLoggingFailureDoesNotBreakTheReceiver(): Promise<void> {
  const provider = await startFakeProvider()
  const blockedRoot = tempDir()
  const blockedPath = join(blockedRoot, 'not-a-directory')
  writeFileSync(blockedPath, 'occupied', 'utf8')

  const receiver = await startReceiver({
    logPath: blockedPath,
    memoryDirectory: tempDir(),
    apiBase: provider.baseUrl,
  })
  try {
    assert(receiver.child.exitCode === null, `the receiver failed to start: ${receiver.stdout.join('')}`)
    const reply = await send(receiver.pipeName, inbound(groupMessage('log-persist-blocked', QUESTION)))
    console.log(`[MEMORY_PERSIST_PROBE] blockedLogPathReply=${reply.trim().slice(0, 120)}`)
    assert(
      reply.includes('OUTBOUND_COMMAND') && reply.includes(REPLY_TEXT),
      `a broken log path broke the chat path: ${reply}`,
    )
    await receiver.stop()
    assert(
      readdirSync(blockedRoot).length === 1,
      'the fail-open path created something next to the blocking file',
    )
  } finally {
    await receiver.stop()
    await provider.close()
  }
}

// ------------------------------------------------------------------ execution

const CASES: Array<[string, () => Promise<void>]> = [
  ['memory-runtime-events-survive-the-process', testMemoryRuntimeEventsSurviveTheProcess],
  ['context-events-do-not-impersonate-memory-events', testContextEventsDoNotImpersonateMemoryEvents],
  ['durable-log-privacy-and-token-mode', testDurableLogPrivacyAndTokenMode],
  ['logging-failure-does-not-break-the-receiver', testLoggingFailureDoesNotBreakTheReceiver],
]

let failures = 0
for (const [name, run] of CASES) {
  try {
    await run()
    console.log(`[MEMORY_LOG_PERSIST_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    const message = error instanceof Error ? error.message : String(error)
    console.log(`[MEMORY_LOG_PERSIST_CASE] name=${name} result=FAIL message=${message}`)
  }
}

cleanup()
console.log(`[MEMORY_LOG_PERSIST_TEST_SUMMARY] cases=${CASES.length} failures=${failures}`)
if (failures > 0) {
  console.log('[MEMORY_LOG_PERSIST] result=FAIL')
  process.exitCode = 1
} else {
  console.log('[MEMORY_LOG_PERSIST] result=PASS')
}
