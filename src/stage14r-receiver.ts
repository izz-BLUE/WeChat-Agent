import { writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import {
  runRawAgentPipeline,
  type AgentExecutor,
  type AgentRequest,
  type AgentPipelineResult,
} from './agent-adapter.js'
import type { RawHookMessage } from './message-contract.js'

const pipeName = process.argv[2] ?? 'WeChat-Agent-Stage14R'
const summaryPath = process.argv[3]
const pipePath = pipeName.startsWith('\\\\.\\pipe\\') ? pipeName : `\\\\.\\pipe\\${pipeName}`

interface ReceivedEntry {
  ordinal: number
  status: string
  reason?: string
  messageId?: string
  senderId?: string
  timestamp?: number
  text?: string
  rawMessageType?: number
  agentCalled: boolean
  outboundGenerated: boolean
  conversationType?: string
  conversationId?: string
  conversationKey?: string
  outboundConversationId?: string
  outboundText?: string
}

interface ReceiverSummary {
  transport: 'ndjson-named-pipe'
  encoding: 'utf8'
  framing: 'newline-delimited-json'
  receivedCount: number
  entries: ReceivedEntry[]
  receiverErrors: number
}

const summary: ReceiverSummary = {
  transport: 'ndjson-named-pipe',
  encoding: 'utf8',
  framing: 'newline-delimited-json',
  receivedCount: 0,
  entries: [],
  receiverErrors: 0,
}

let server: ReturnType<typeof createServer>
let closed = false

class Stage14RFakeAgent implements AgentExecutor {
  public readonly requests: AgentRequest[] = []

  public async complete(request: AgentRequest): Promise<string> {
    this.requests.push(request)
    return 'STAGE14R_AGENT_REPLY'
  }
}

function invalidEntry(reason: string): ReceivedEntry {
  return {
    ordinal: summary.receivedCount,
    status: 'INVALID',
    reason,
    agentCalled: false,
    outboundGenerated: false,
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function deserializeRawMessage(value: unknown): RawHookMessage | { invalid: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { invalid: 'PAYLOAD_NOT_OBJECT' }
  }

  const object = value as Record<string, unknown>
  const required = ['msgId', 'type', 'timestamp', 'from', 'wxid', 'content', 'signature']
  const missing = required.find((key) => !hasOwn(object, key))
  if (missing) {
    return { invalid: `REQUIRED_FIELD_MISSING:${missing}` }
  }

  if ((typeof object.msgId !== 'string' && typeof object.msgId !== 'number') ||
      typeof object.type !== 'number' || !Number.isInteger(object.type) ||
      typeof object.timestamp !== 'number' || !Number.isFinite(object.timestamp) ||
      typeof object.from !== 'string' || typeof object.wxid !== 'string' ||
      typeof object.content !== 'string' || typeof object.signature !== 'string') {
    return { invalid: 'FIELD_TYPE_INVALID' }
  }

  if (hasOwn(object, 'senderName') && object.senderName !== null && typeof object.senderName !== 'string') {
    return { invalid: 'SENDER_NAME_TYPE_INVALID' }
  }
  if (hasOwn(object, 'isMentioned') && object.isMentioned !== null && typeof object.isMentioned !== 'boolean') {
    return { invalid: 'IS_MENTIONED_TYPE_INVALID' }
  }
  if (hasOwn(object, 'ownerConfigured') &&
      object.ownerConfigured !== null &&
      typeof object.ownerConfigured !== 'boolean') {
    return { invalid: 'OWNER_CONFIGURED_TYPE_INVALID' }
  }
  for (const key of ['conversationType', 'conversationId', 'senderId', 'requesterId', 'requesterSource',
    'requesterRole', 'ownerDisplayName']) {
    const field = object[key]
    if (hasOwn(object, key) && field !== null && typeof field !== 'string') {
      return { invalid: `IDENTITY_FIELD_TYPE_INVALID:${key}` }
    }
  }

  return {
    msgId: object.msgId,
    type: object.type,
    timestamp: object.timestamp,
    from: object.from,
    wxid: object.wxid,
    content: object.content,
    signature: object.signature,
    senderName: object.senderName as string | null | undefined,
    isMentioned: object.isMentioned as boolean | null | undefined,
    // Runtime identity decision; GROUP payloads must carry it to be admitted.
    conversationType: object.conversationType as string | null | undefined,
    conversationId: object.conversationId as string | null | undefined,
    senderId: object.senderId as string | null | undefined,
    requesterId: object.requesterId as string | null | undefined,
    requesterSource: object.requesterSource as string | null | undefined,
    // Runtime owner decision; consumed as a fact, never re-derived.
    requesterRole: object.requesterRole as string | null | undefined,
    ownerConfigured: object.ownerConfigured as boolean | null | undefined,
    ownerDisplayName: object.ownerDisplayName as string | null | undefined,
  }
}

function resultEntry(agent: Stage14RFakeAgent, result: AgentPipelineResult): ReceivedEntry {
  if (result.status === 'AGENT_RESULT') {
    return {
      ordinal: summary.receivedCount,
      status: result.agentResult.kind,
      agentCalled: agent.requests.length > 0,
      outboundGenerated: result.outboundCommand !== null,
      messageId: result.request.messageId,
      senderId: result.request.senderId,
      timestamp: result.request.timestamp,
      text: result.request.text,
      rawMessageType: result.request.metadata.rawMessageType,
      conversationType: result.request.conversationType,
      conversationId: result.request.conversationId,
      conversationKey: result.request.conversationKey,
      outboundConversationId: result.outboundCommand?.conversationId,
      outboundText: result.outboundCommand?.text,
    }
  }

  if (result.status === 'IGNORED') {
    return {
      ordinal: summary.receivedCount,
      status: result.status,
      reason: result.policy.reason,
      agentCalled: false,
      outboundGenerated: false,
      messageId: result.normalization.message.messageId,
      senderId: result.normalization.message.senderId,
      timestamp: result.normalization.message.timestamp,
      text: result.normalization.message.text,
      rawMessageType: result.normalization.message.rawMessageType,
      conversationType: result.normalization.message.conversationType,
      conversationId: result.normalization.message.conversationId,
      conversationKey: `${result.normalization.message.conversationType.toLowerCase()}:${result.normalization.message.conversationId}`,
    }
  }

  return {
    ordinal: summary.receivedCount,
    status: result.status,
    reason: result.normalization.reason,
    agentCalled: false,
    outboundGenerated: false,
  }
}

function writeAck(socket: Socket, payload: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(payload)}\n`)
}

async function processLine(socket: Socket, line: string): Promise<void> {
  summary.receivedCount += 1
  const ordinal = summary.receivedCount
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    const entry = invalidEntry('INVALID_JSON')
    entry.ordinal = ordinal
    summary.entries.push(entry)
    console.log(`[TRANSPORT_RECEIVED] ordinal=${ordinal} status=${entry.status} reason=${entry.reason}`)
    writeAck(socket, { status: entry.status, reason: entry.reason, agentCalled: false, outboundGenerated: false })
    return
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
      (value as Record<string, unknown>).control === 'shutdown') {
    writeAck(socket, { status: 'SHUTDOWN' })
    return
  }

  const raw = deserializeRawMessage(value)
  if ('invalid' in raw) {
    const entry = invalidEntry(raw.invalid)
    entry.ordinal = ordinal
    summary.entries.push(entry)
    console.log(`[TRANSPORT_RECEIVED] ordinal=${ordinal} status=${entry.status} reason=${entry.reason}`)
    writeAck(socket, { status: entry.status, reason: entry.reason, agentCalled: false, outboundGenerated: false })
    return
  }

  const agent = new Stage14RFakeAgent()
  const result = await runRawAgentPipeline(raw, agent)
  const entry = resultEntry(agent, result)
  entry.ordinal = ordinal
  summary.entries.push(entry)
  console.log(`[TRANSPORT_RECEIVED] ordinal=${ordinal} status=${entry.status} agentCalled=${entry.agentCalled} outboundGenerated=${entry.outboundGenerated}`)
  writeAck(socket, {
    status: entry.status,
    reason: entry.reason,
    agentCalled: entry.agentCalled,
    outboundGenerated: entry.outboundGenerated,
    conversationType: entry.conversationType,
    conversationId: entry.conversationId,
    conversationKey: entry.conversationKey,
    outboundConversationId: entry.outboundConversationId,
    outboundText: entry.outboundText,
    senderId: entry.senderId,
    timestamp: entry.timestamp,
    text: entry.text,
    rawMessageType: entry.rawMessageType,
  })
}

function persistSummary(): void {
  if (summaryPath) {
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  }
}

function closeServer(): void {
  if (closed) return
  closed = true
  persistSummary()
  server.close(() => {
    console.log(`[TRANSPORT_SUMMARY] received=${summary.receivedCount} receiverErrors=${summary.receiverErrors}`)
    process.exitCode = summary.receiverErrors === 0 ? 0 : 1
  })
}

server = createServer((socket) => {
  let buffer = ''
  let chain = Promise.resolve()

  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      chain = chain
        .then(() => processLine(socket, line))
        .catch((error: unknown) => {
          summary.receiverErrors += 1
          writeAck(socket, { status: 'RECEIVER_ERROR', agentCalled: false, outboundGenerated: false })
          console.error(`[TRANSPORT_ERROR] message=${error instanceof Error ? error.message : String(error)}`)
        })
    }
  })
  socket.on('end', () => {
    chain.finally(() => {
      closeServer()
    })
  })
})

server.on('error', (error) => {
  summary.receiverErrors += 1
  console.error(`[TRANSPORT_ERROR] message=${error.message}`)
  persistSummary()
  process.exitCode = 1
})

server.listen(pipePath, () => {
  console.log(`[TRANSPORT_READY] pipe=${pipePath} framing=ndjson encoding=utf8`)
})
