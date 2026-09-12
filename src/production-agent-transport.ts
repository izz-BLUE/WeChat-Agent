import { createServer, type Server, type Socket } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  runRawAgentPipeline,
  runRawPassiveContextPipeline,
  type AgentExecutor,
  type AgentPipelineResult,
  type OutboundCommand,
  type PassivePipelineResult,
} from './agent-adapter.js'
import {
  OUTBOUND_DELIVERY_ACK_KIND,
  sha256Utf8,
  type OutboundDeliveryAck,
  type DeliveryAckResult,
  type DeliveryAckRejectReason,
} from './outbound-delivery.js'
import { PASSIVE_CONTEXT_KIND, type RawHookMessage } from './message-contract.js'
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
  status: AgentPipelineResult['status'] | PassivePipelineResult['status']
  agentCalled: boolean
  outboundGenerated: boolean
  conversationType?: OutboundCommand['conversationType']
  conversationId?: string
  text?: string
  /** True for a passive ambient event. Such an entry never carries an outbound. */
  passiveContext?: boolean
}

/**
 * Two envelope kinds, two authorities.
 *
 * `INBOUND_MESSAGE` is the active request the runtime admitted. The additive
 * `PASSIVE_CONTEXT_ONLY` kind is group ambience: no admission, no request and no
 * reply — an older Agent that does not know the kind rejects it instead of
 * treating group chatter as something it was asked.
 */
type InboundEnvelope =
  | { kind: 'INBOUND_MESSAGE'; message: RawHookMessage }
  | { kind: typeof PASSIVE_CONTEXT_KIND; message: RawHookMessage }
  | { kind: typeof PROACTIVE_OUTBOUND_POLL_KIND; pollId: string }
  | { kind: typeof OUTBOUND_DELIVERY_ACK_KIND; payload: OutboundDeliveryAck }

type AgentResponse =
  | { kind: 'NO_REPLY'; reason?: string }
  | { kind: 'ERROR'; code: string; message?: string }
  | { kind: 'CONTEXT_ACCEPTED' }
  | { kind: 'CONTEXT_NOT_ACCEPTED'; reason?: string }
  | { kind: 'NO_PROACTIVE_OUTBOUND' }
  | ({ kind: 'PROACTIVE_OUTBOUND_COMMAND' } & OutboundCommand)
  | { kind: 'DELIVERY_ACK_ACCEPTED'; reason: 'SENT_COMMITTED' | 'FAILED_DISCARDED' }
  | { kind: 'DELIVERY_ACK_REJECTED'; reason: DeliveryAckRejectReason }
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

    if (envelope.kind === OUTBOUND_DELIVERY_ACK_KIND) {
      await this.processDeliveryAck(socket, envelope.payload)
      return
    }

    if (envelope.kind === PROACTIVE_OUTBOUND_POLL_KIND) {
      await this.processProactivePoll(socket)
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

    if (envelope.kind === PASSIVE_CONTEXT_KIND) {
      await this.processPassiveContext(socket, envelope.message, identity)
      if (this.options.maxMessages !== undefined && this.messageCount >= this.options.maxMessages) {
        socket.end()
        await this.stop()
      }
      return
    }

    const result = await runRawAgentPipeline(envelope.message, this.options.agent)
    const entry = toSummaryEntry(envelope.message, result)
    this.summary.push(entry)

    let response: AgentResponse
    if (this.options.invalidOutboundMessageId === envelope.message.msgId.toString()) {
      response = {
        kind: 'OUTBOUND_COMMAND',
        outboundId: `invalid-${envelope.message.msgId.toString()}`,
        requestMessageId: envelope.message.msgId.toString(),
        contentSha256: sha256Utf8(''),
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

  private async processDeliveryAck(socket: Socket, ack: OutboundDeliveryAck): Promise<void> {
    let result: DeliveryAckResult
    if (!this.options.agent.observeOutboundDelivery) {
      result = { accepted: false, reason: 'UNKNOWN_OUTBOUND' }
    } else {
      try {
        result = await this.options.agent.observeOutboundDelivery(ack)
      } catch {
        result = { accepted: false, reason: 'INVALID_ACK' }
      }
    }

    const response: AgentResponse = result.accepted
      ? { kind: 'DELIVERY_ACK_ACCEPTED', reason: result.reason }
      : { kind: 'DELIVERY_ACK_REJECTED', reason: result.reason }
    this.persistentSink?.writeStructured(
      'OUTBOUND_DELIVERY_ACK',
      {
        result: response.kind,
        status: ack.status,
        reason: result.accepted ? '' : result.reason,
      },
      `outboundToken=${this.persistentLog?.shortIdFor(ack.outboundId) ?? 'NONE'}`,
    )
    await writeResponse(socket, response)
  }

  private async processProactivePoll(socket: Socket): Promise<void> {
    let command: OutboundCommand | null = null
    try {
      command = this.options.agent.pollProactiveOutbound?.() ?? null
    } catch {
      command = null
    }
    if (command === null) {
      await writeResponse(socket, { kind: 'NO_PROACTIVE_OUTBOUND' })
      return
    }
    this.persistentSink?.writeStructured(
      'PROACTIVE_POLL',
      { result: 'COMMAND' },
      `outboundToken=${this.persistentLog?.shortIdFor(command.outboundId) ?? 'NONE'}`,
    )
    await writeResponse(socket, { kind: 'PROACTIVE_OUTBOUND_COMMAND', ...command })
  }

  /**
   * One passive ambient event.
   *
   * Structurally separate from the active path: it never consults
   * `invalidOutboundMessageId`, never reaches `toAgentResponse` and has no
   * response shape that carries an outbound command. Delivery and model
   * invocation are therefore separable facts — `CONTEXT_ACCEPTED` means "the
   * ambience was stored", not "the Agent was asked anything".
   */
  private async processPassiveContext(
    socket: Socket,
    raw: RawHookMessage,
    identity: RequesterIdentityFields,
  ): Promise<void> {
    const result = await runRawPassiveContextPipeline(raw, this.options.agent)
    const entry: ProductionTransportSummaryEntry = {
      messageId: raw.msgId.toString(),
      status: result.status,
      agentCalled: false,
      outboundGenerated: false,
      passiveContext: true,
    }
    this.summary.push(entry)

    const response: AgentResponse = result.status === 'PASSIVE_CONTEXT'
      ? { kind: 'CONTEXT_ACCEPTED' }
      : { kind: 'CONTEXT_NOT_ACCEPTED', reason: passiveDropReason(result) }

    this.persistentSink?.writeStructured(
      'INBOUND_DISPATCHED',
      {
        result: response.kind,
        phase: 'passive-context',
        conversationType: identity.conversationType,
        msgIdToken: this.persistentLog?.shortIdFor(raw.msgId) ?? 'NONE',
        conversationToken: identityToken(identity.conversationId),
        requesterToken: identityToken(identity.requesterId),
      },
      `status=${result.status} agentInvoked=false outbound=false`,
    )
    await writeResponse(socket, response)
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
  if (!isRecord(value)) {
    throw new Error('Inbound kind is invalid')
  }
  const kind = value.kind
  if (kind === PROACTIVE_OUTBOUND_POLL_KIND) {
    if (typeof value.pollId !== 'string' || value.pollId.trim().length === 0 || value.pollId.length > 128) {
      throw new Error('Proactive poll id is invalid')
    }
    return { kind, pollId: value.pollId }
  }
  if (kind === OUTBOUND_DELIVERY_ACK_KIND) {
    if (!isRecord(value.payload)) {
      throw new Error('Delivery ACK payload is missing')
    }
    const payload = value.payload
    if (typeof payload.outboundId !== 'string' || payload.outboundId.trim().length === 0 ||
        typeof payload.requestMessageId !== 'string' || payload.requestMessageId.trim().length === 0 ||
        (payload.status !== 'SENT' && payload.status !== 'FAILED') ||
        typeof payload.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(payload.contentSha256) ||
        typeof payload.errorCode !== 'string' || payload.errorCode.length > 128) {
      throw new Error('Delivery ACK fields are invalid')
    }
    return {
      kind,
      payload: {
        outboundId: payload.outboundId,
        requestMessageId: payload.requestMessageId,
        status: payload.status,
        contentSha256: payload.contentSha256,
        errorCode: payload.errorCode,
      },
    }
  }
  if (kind !== 'INBOUND_MESSAGE' && kind !== PASSIVE_CONTEXT_KIND) {
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

  return { kind, message: raw as unknown as RawHookMessage }
}

/**
 * Why a passive event was not captured. A closed set of enum-like codes: the
 * operator needs to know that ambience was lost, and the reason must never be the
 * message body, a conversation id or a sender id.
 */
function passiveDropReason(result: PassivePipelineResult): string {
  switch (result.status) {
    case 'INVALID':
    case 'UNSUPPORTED':
      return result.normalization.reason
    case 'PASSIVE_CONTEXT_UNSUPPORTED':
      return 'PASSIVE_CONTEXT_SINK_UNSUPPORTED'
    case 'PASSIVE_CONTEXT_ERROR':
      return 'PASSIVE_CONTEXT_APPEND_FAILED'
    default:
      return 'PASSIVE_CONTEXT_NOT_CAPTURED'
  }
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
  'privateDispatchTargetConversationId',
] as const

const PROACTIVE_OUTBOUND_POLL_KIND = 'PROACTIVE_OUTBOUND_POLL' as const

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
