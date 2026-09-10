import { createServer, type Server, type Socket } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  runRawAgentPipeline,
  type AgentExecutor,
  type AgentPipelineResult,
  type OutboundCommand,
} from './agent-adapter.js'
import type { RawHookMessage } from './message-contract.js'
import {
  identityToken,
  logRequesterIdentity,
  observeRawInbound,
  type RequesterIdentityFields,
} from './identity-observer.js'
import {
  PersistentRuntimeLog,
  PersistentRuntimeLogSink,
} from './persistent-runtime-log.js'

export interface ProductionAgentTransportOptions {
  pipeName: string
  agent: AgentExecutor
  summaryPath?: string
  maxMessages?: number
  invalidOutboundMessageId?: string
  /** Persistent runtime log mirror. Defaults to a no-op sink when absent. */
  persistentLog?: PersistentRuntimeLog
}

export interface ProductionTransportSummaryEntry {
  messageId: string
  status: AgentPipelineResult['status']
  agentCalled: boolean
  outboundGenerated: boolean
  conversationType?: OutboundCommand['conversationType']
  conversationId?: string
  text?: string
}

interface InboundEnvelope {
  kind: 'INBOUND_MESSAGE'
  message: RawHookMessage
}

type AgentResponse =
  | { kind: 'NO_REPLY'; reason?: string }
  | { kind: 'ERROR'; code: string; message?: string }
  | ({ kind: 'OUTBOUND_COMMAND' } & OutboundCommand)

/**
 * Production Agent transport. It owns only the named-pipe protocol and
 * delegates normalization, mention policy, conversation keys, and Agent
 * execution to the existing adapter pipeline.
 */
export class ProductionAgentTransportServer {
  private readonly pipePath: string
  private readonly options: ProductionAgentTransportOptions
  private readonly sockets = new Set<Socket>()
  private readonly summary: ProductionTransportSummaryEntry[] = []
  private readonly persistentLog: PersistentRuntimeLog | null
  private readonly persistentSink: PersistentRuntimeLogSink | null
  private server: Server | undefined
  private stopTask: Promise<void> | undefined
  private messageCount = 0
  private stopping = false

  public constructor(options: ProductionAgentTransportOptions) {
    if (!options.pipeName.trim()) {
      throw new Error('pipeName is required')
    }
    if (options.maxMessages !== undefined && (!Number.isInteger(options.maxMessages) || options.maxMessages <= 0)) {
      throw new Error('maxMessages must be a positive integer')
    }

    this.options = options
    this.persistentLog = options.persistentLog ?? null
    this.persistentSink = this.persistentLog
      ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-transport')
      : null
    this.pipePath = `\\\\.\\pipe\\${options.pipeName.trim()}`
  }

  public get endpoint(): string {
    return this.pipePath
  }

  public get isRunning(): boolean {
    return this.server !== undefined
  }

  public get entries(): readonly ProductionTransportSummaryEntry[] {
    return this.summary
  }

  public async start(): Promise<void> {
    if (this.server) {
      return
    }

    this.stopping = false
    this.stopTask = undefined
    const server = createServer((socket) => this.accept(socket))
    server.on('error', (error) => {
      console.error(`[PRODUCTION_AGENT_TRANSPORT_ERROR] ${error.message}`)
    })
    this.server = server

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      server.once('listening', onListening)
      server.once('error', onError)
      server.listen(this.pipePath)
    })

    console.log(`[PRODUCTION_AGENT_TRANSPORT] lifecycle=STARTED endpoint=${this.pipePath}`)
    this.persistentSink?.writeStructured(
      'TRANSPORT_LIFECYCLE',
      { result: 'STARTED', phase: 'listen' },
      `endpoint=${this.pipePath}`,
    )
  }

  public async stop(): Promise<void> {
    if (this.stopping) {
      await this.stopTask
      return
    }
    this.stopping = true
    this.stopTask = this.stopCore()
    await this.stopTask
  }

  public async waitForStop(): Promise<void> {
    if (this.stopTask) {
      await this.stopTask
    }
  }

  private async stopCore(): Promise<void> {

    for (const socket of this.sockets) {
      socket.end()
    }

    const server = this.server
    this.server = undefined
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }

    await this.writeSummary()
    this.persistentSink?.writeStructured(
      'TRANSPORT_LIFECYCLE',
      { result: 'STOPPED', phase: 'shutdown' },
      `endpoint=${this.pipePath} messageCount=${this.messageCount}`,
    )
    this.persistentLog?.flush()
    console.log('[PRODUCTION_AGENT_TRANSPORT] lifecycle=STOPPED')
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    console.log('[PRODUCTION_AGENT_TRANSPORT] client=CONNECTED')
    this.persistentSink?.writeStructured(
      'TRANSPORT_CLIENT',
      { result: 'CONNECTED', phase: 'accept' },
    )
    let buffer = ''
    let processing = Promise.resolve()

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) {
          continue
        }
        processing = processing
          .then(() => this.processLine(socket, trimmed))
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[PRODUCTION_AGENT_TRANSPORT_ERROR] ${message}`)
            this.persistentSink?.writeStructured(
              'TRANSPORT_ERROR',
              { result: 'PROCESS_LINE_FAILED', phase: 'process-line', errorCode: 'PROCESS_LINE_FAILED' },
              message,
            )
          })
      }
    })
    socket.on('close', () => {
      this.sockets.delete(socket)
      console.log('[PRODUCTION_AGENT_TRANSPORT] client=DISCONNECTED')
      this.persistentSink?.writeStructured(
        'TRANSPORT_CLIENT',
        { result: 'DISCONNECTED', phase: 'accept' },
      )
    })
    socket.on('error', (error) => {
      console.error(`[PRODUCTION_AGENT_SOCKET_ERROR] ${error.message}`)
      this.persistentSink?.writeStructured(
        'TRANSPORT_ERROR',
        { result: 'SOCKET_ERROR', phase: 'accept', errorCode: 'SOCKET_ERROR' },
        error.message,
      )
    })
  }

  private async processLine(socket: Socket, line: string): Promise<void> {
    let envelope: InboundEnvelope
    try {
      envelope = parseInboundEnvelope(JSON.parse(line) as unknown)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid inbound envelope'
      await writeResponse(socket, { kind: 'ERROR', code: 'INVALID_INBOUND', message })
      this.persistentSink?.writeStructured(
        'INBOUND_INVALID',
        { result: 'INVALID_INBOUND', phase: 'parse', errorCode: 'INVALID_INBOUND' },
        message,
      )
      return
    }

    this.messageCount += 1
    observeRawInbound(envelope.message)
    const identity = requesterIdentityFields(envelope.message)
    // Formal identity diagnostic: reports the wire decision (tokens only) before
    // the pipeline consumes it, so a fail-closed normalization is still visible.
    // Its return value is deliberately discarded — the observer stays a pure
    // observation and never feeds the pipeline.
    logRequesterIdentity(identity)
    const result = await runRawAgentPipeline(envelope.message, this.options.agent)
    const entry = toSummaryEntry(envelope.message, result)
    this.summary.push(entry)

    let response: AgentResponse
    if (this.options.invalidOutboundMessageId === envelope.message.msgId.toString()) {
      response = {
        kind: 'OUTBOUND_COMMAND',
        conversationType: 'DIRECT',
        conversationId: envelope.message.from,
        text: '',
      }
    } else {
      response = toAgentResponse(result)
    }

    // Cross-process correlation envelope. The conversation and requester tokens
    // are derived with `identityToken`, the same single tokenization rule the
    // observer and the C# UI use (senderToken is intentionally omitted: it is
    // identical to requesterToken for an admitted GROUP message and would only
    // duplicate a field). With a shared WECHAT_LOG_TOKEN_SALT the UI writes the
    // same values for the same inbound, which is what lets an operator follow
    // one message across Receive, RuntimePolicy, AgentBridge, Agent, Provider
    // and Outbound.
    this.persistentSink?.writeStructured(
      'INBOUND_DISPATCHED',
      {
        result: response.kind,
        phase: 'pipeline',
        conversationType: identity.conversationType,
        msgIdToken: this.persistentLog?.shortIdFor(envelope.message.msgId) ?? 'NONE',
        conversationToken: identityToken(identity.conversationId),
        requesterToken: identityToken(identity.requesterId),
      },
      `status=${result.status}`,
    )
    await writeResponse(socket, response)
    if (this.options.maxMessages !== undefined && this.messageCount >= this.options.maxMessages) {
      socket.end()
      await this.stop()
    }
  }

  private async writeSummary(): Promise<void> {
    if (!this.options.summaryPath) {
      return
    }

    const path = this.options.summaryPath
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ endpoint: this.pipePath, entries: this.summary }, null, 2)}\n`, 'utf8')
  }
}

function parseInboundEnvelope(value: unknown): InboundEnvelope {
  if (!isRecord(value) || value.kind !== 'INBOUND_MESSAGE') {
    throw new Error('Inbound kind is invalid')
  }
  if (!isRecord(value.message)) {
    throw new Error('Inbound message is missing')
  }

  const raw = value.message
  if (!isStringOrNumber(raw.msgId) || typeof raw.type !== 'number' || !Number.isFinite(raw.type) ||
      typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp) ||
      typeof raw.from !== 'string' || typeof raw.wxid !== 'string' ||
      typeof raw.content !== 'string' || typeof raw.signature !== 'string') {
    throw new Error('Inbound message fields are invalid')
  }
  if (raw.senderName !== undefined && raw.senderName !== null && typeof raw.senderName !== 'string') {
    throw new Error('Inbound senderName is invalid')
  }
  if (raw.isMentioned !== undefined && raw.isMentioned !== null && typeof raw.isMentioned !== 'boolean') {
    throw new Error('Inbound isMentioned is invalid')
  }
  for (const name of WIRE_IDENTITY_FIELDS) {
    const field = raw[name]
    if (field !== undefined && field !== null && typeof field !== 'string') {
      throw new Error(`Inbound ${name} is invalid`)
    }
  }
  if (raw.ownerConfigured !== undefined && raw.ownerConfigured !== null && typeof raw.ownerConfigured !== 'boolean') {
    throw new Error('Inbound ownerConfigured is invalid')
  }

  return { kind: 'INBOUND_MESSAGE', message: raw as unknown as RawHookMessage }
}

/** Runtime identity decision fields carried by the C# wire contract. */
const WIRE_IDENTITY_FIELDS = [
  'conversationType',
  'conversationId',
  'senderId',
  'requesterId',
  'requesterSource',
  'requesterRole',
  'ownerDisplayName',
] as const

function requesterIdentityFields(raw: RawHookMessage): RequesterIdentityFields {
  const conversationId = (raw.conversationId ?? '').trim() || raw.from.trim()
  const wireType = (raw.conversationType ?? '').trim().toUpperCase()

  return {
    conversationType: wireType === 'GROUP' || wireType === 'DIRECT'
      ? wireType
      : conversationId.endsWith('@chatroom') ? 'GROUP' : 'DIRECT',
    source: (raw.requesterSource ?? '').trim(),
    senderId: (raw.senderId ?? '').trim(),
    requesterId: (raw.requesterId ?? '').trim(),
    conversationId,
  }
}

function toAgentResponse(result: AgentPipelineResult): AgentResponse {
  if (result.status !== 'AGENT_RESULT') {
    return result.status === 'IGNORED'
      ? { kind: 'NO_REPLY', reason: result.policy.reason }
      : { kind: 'NO_REPLY', reason: result.normalization.reason }
  }
  if (result.agentResult.kind === 'ERROR') {
    return { kind: 'ERROR', code: 'AGENT_ERROR', message: 'Agent execution failed' }
  }
  if (result.outboundCommand) {
    return { kind: 'OUTBOUND_COMMAND', ...result.outboundCommand }
  }
  return { kind: 'NO_REPLY' }
}

function toSummaryEntry(raw: RawHookMessage, result: AgentPipelineResult): ProductionTransportSummaryEntry {
  const agentResult = result.status === 'AGENT_RESULT' ? result : undefined
  const entry: ProductionTransportSummaryEntry = {
    messageId: raw.msgId.toString(),
    status: result.status,
    agentCalled: agentResult !== undefined,
    outboundGenerated: agentResult?.outboundCommand !== null && agentResult?.outboundCommand !== undefined,
  }
  if (agentResult?.outboundCommand) {
    entry.conversationType = agentResult.outboundCommand.conversationType
    entry.conversationId = agentResult.outboundCommand.conversationId
    entry.text = agentResult.outboundCommand.text
  }
  return entry
}

function writeResponse(socket: Socket, response: AgentResponse): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.write(`${JSON.stringify(response)}\n`, 'utf8', (error?: Error | null) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}

function isStringOrNumber(value: unknown): value is string | number {
  return (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isFinite(value))
}
