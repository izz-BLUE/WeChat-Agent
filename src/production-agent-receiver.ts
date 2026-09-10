import { ChatService, type ChatMentionFact } from './chat.js'
import { GroupContext, type GroupMessage } from './context.js'
import { config, validateChatConfig } from './config.js'
import type { AgentExecutor, AgentRequest } from './agent-adapter.js'
import { ProductionAgentTransportServer } from './production-agent-transport.js'
import { MemoryExtractor } from './memory-extractor.js'
import { MemoryService } from './memory-service.js'
import { MemoryStore } from './memory-store.js'
import { SpeakerLabelRegistry } from './speaker-labels.js'
import {
  emitDiagnostic,
  PersistentRuntimeLog,
  PersistentRuntimeLogSink,
  type TokenCorrelationState,
} from './persistent-runtime-log.js'

/**
 * The mention fact handed to the model. A group message only reaches the Agent
 * after the runtime admitted it as mentioned, so the model is told that fact
 * instead of re-reading the text to decide whether it was addressed.
 */
function mentionFact(request: AgentRequest): ChatMentionFact {
  if (request.conversationType === 'DIRECT') {
    return 'NOT_APPLICABLE'
  }
  return request.mentionState
}

/**
 * Runtime-only values a final answer must never carry. They are handed to the
 * final-answer guard (never to the prompt), so a provider that echoed one fails
 * closed instead of sending an internal identity to the group.
 */
function guardValues(request: AgentRequest): string[] {
  return [request.requesterId, request.conversationId, request.senderId]
}

export interface ProductionChatAgentOptions {
  /** Persistent memory. Absent means memory is disabled (tests, fake mode). */
  memory?: MemoryService | null
  speakerLabels?: SpeakerLabelRegistry
  /**
   * Optional persistent runtime log. When absent the agent falls back to a
   * silent no-op sink so the call sites stay identical for tests.
   */
  persistentLog?: PersistentRuntimeLog
}

export class ProductionChatAgent implements AgentExecutor {
  private readonly context: GroupContext
  private readonly speakerLabels: SpeakerLabelRegistry
  private readonly memory: MemoryService | null
  private readonly persistentLog: PersistentRuntimeLog | null

  public constructor(
    private readonly chatService: ChatService,
    options: ProductionChatAgentOptions = {},
  ) {
    this.speakerLabels = options.speakerLabels ?? new SpeakerLabelRegistry()
    this.memory = options.memory ?? null
    this.persistentLog = options.persistentLog ?? null
    this.context = new GroupContext(
      config.maxContextMessages,
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
    )
  }

  public async complete(request: AgentRequest): Promise<string> {
    const label = this.speakerLabels.labelFor({
      conversationType: request.conversationType,
      conversationId: request.conversationId,
      requesterId: request.requesterId,
      requesterRole: request.requesterRole,
      ownerDisplayName: request.ownerDisplayName,
      senderName: request.senderName,
      senderId: request.senderId,
    })

    const question: GroupMessage = {
      senderId: request.senderId,
      // Never the raw runtime identity: the label is role/pseudonym based.
      senderName: label,
      text: request.text,
      timestamp: request.timestamp,
    }
    const recent = this.context.recent(
      request.conversationId,
      config.contextMessageLimit,
      config.maxContextChars,
      request.messageId,
    )
    this.context.append(request.conversationId, question, request.messageId)

    if (this.memory) {
      // Historical order: explicit memory intent short-circuits the chat turn,
      // then the message feeds the automatic extractor, then retrieval.
      const explicit = await this.memory.tryHandleExplicit({
        conversationType: request.conversationType,
        conversationId: request.conversationId,
        requesterId: request.requesterId,
        requesterRole: request.requesterRole,
        question: request.text,
      })
      if (explicit.handled) {
        return explicit.reply
      }

      this.memory.observeHumanMessage({
        messageId: request.messageId,
        conversationType: request.conversationType,
        conversationId: request.conversationId,
        requesterId: request.requesterId,
        requesterRole: request.requesterRole,
        speakerLabel: label,
        text: request.text,
        timestamp: request.timestamp,
        chatTriggered: true,
      })
    }

    const memory = this.memory
      ? await this.memory.retrieveForChat({
          conversationType: request.conversationType,
          conversationId: request.conversationId,
          requesterId: request.requesterId,
          requesterRole: request.requesterRole,
          question: request.text,
        })
      : []

    return this.chatService.reply(
      recent,
      question,
      {
        botDisplayName: config.botDisplayName,
        mention: mentionFact(request),
        requesterRole: request.requesterRole,
        ownerConfigured: request.ownerConfigured,
        memory,
        currentSpeakerLabel: request.conversationType === 'GROUP' ? label : undefined,
        // A disabled or absent store is a runtime fact: the model may not claim a
        // long-term memory that this process does not have.
        persistentMemoryAvailable: this.memory !== null && this.memory.isEnabled,
      },
      guardValues(request),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-chat') : undefined,
      request.messageId,
    )
  }
}

export class Stage14SFakeAgent implements AgentExecutor {
  public async complete(request: AgentRequest): Promise<string | null> {
    if (request.messageId === '14005') {
      return null
    }
    if (request.messageId === '14006') {
      throw new Error('stage14s synthetic Agent failure')
    }
    return `stage14s-reply:${request.conversationType}:${request.conversationId}`
  }
}

export interface ProductionReceiverOptions {
  pipeName: string
  mode: 'real' | 'fake'
  summaryPath?: string
  maxMessages?: number
  invalidOutboundMessageId?: string
  /**
   * Persistent runtime log override. Production uses the default
   * `%LOCALAPPDATA%\WeChatAgent\logs\agent-*.log` path; tests inject a temp
   * directory to keep noise out of the operator's profile.
   */
  persistentLog?: PersistentRuntimeLog
  /**
   * Returns the correlation mode resolved by the persistent log so the
   * receiver can record it once at boot without owning the log instance.
   */
  correlationState?: TokenCorrelationState
}

export function createProductionAgent(options: ProductionReceiverOptions): AgentExecutor {
  if (options.mode === 'fake') {
    return new Stage14SFakeAgent()
  }

  validateChatConfig()
  const chatService = new ChatService(config.openAiApiBase, config.openAiApiKey, config.openAiModel)
  return new ProductionChatAgent(chatService, {
    memory: createMemoryService(chatService, options.persistentLog),
    persistentLog: options.persistentLog,
  })
}

/**
 * Persistent memory runtime. A disabled or broken store degrades to "no memory"
 * with an explicit `[MEMORY_STORE]` diagnostic instead of failing chat.
 *
 * The same persistent sink the receiver, transport and chat already use is
 * injected here, so every memory decision is durable as well as visible on
 * stdout: one sink, one component (`agent-memory`), no second logger.
 */
export function createMemoryService(
  chatService: ChatService,
  persistentLog?: PersistentRuntimeLog,
): MemoryService | null {
  const sink = persistentLog ? new PersistentRuntimeLogSink(persistentLog, 'agent-memory') : undefined
  if (!config.memoryEnabled) {
    emitDiagnostic(
      (line: string) => console.log(line),
      sink,
      'MEMORY_STORE',
      {
        operation: 'INIT',
        result: 'FAIL',
        reason: 'DISABLED_BY_CONFIG',
        source: 'WECHAT_MEMORY_ENABLED',
        enabled: false,
      },
    )
    return null
  }

  const store = new MemoryStore({
    filePath: config.memoryFilePath,
    pathSource: config.memoryPathSource,
    sink,
  })
  return new MemoryService({
    store,
    extractor: new MemoryExtractor((system, user) => chatService.completeStructured(system, user)),
    mutate: (system, user) => chatService.completeStructured(system, user),
    enableTimer: true,
    sink,
  })
}

export async function runProductionReceiver(options: ProductionReceiverOptions): Promise<void> {
  const persistentLog = options.persistentLog ?? new PersistentRuntimeLog({ fileBaseName: 'agent' })
  const correlation = persistentLog.correlationState
  persistentLog.write(
    'agent-receiver',
    'TOKEN_CORRELATION',
    {
      mode: correlation.sharedSalt ? 'SHARED' : 'PROCESS_LOCAL',
      saltBytes: correlation.saltBytes,
    },
  )
  persistentLog.write(
    'agent-receiver',
    'RECEIVER_LIFECYCLE',
    { result: 'STARTED', phase: 'boot' },
    `pipeName=${options.pipeName} mode=${options.mode}`,
  )

  const agent = createProductionAgent({ ...options, persistentLog })
  const transport = new ProductionAgentTransportServer({
    pipeName: options.pipeName,
    agent,
    summaryPath: options.summaryPath,
    maxMessages: options.maxMessages,
    invalidOutboundMessageId: options.invalidOutboundMessageId,
    persistentLog,
  })

  await transport.start()
  const maxMessages = options.maxMessages
  if (maxMessages !== undefined) {
    while (transport.isRunning) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await transport.waitForStop()
    persistentLog.write(
      'agent-receiver',
      'RECEIVER_LIFECYCLE',
      { result: 'STOPPED', phase: 'shutdown' },
      `pipeName=${options.pipeName} reason=max-messages-reached`,
    )
    persistentLog.flush()
    persistentLog.dispose()
    return
  }

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      persistentLog.write(
        'agent-receiver',
        'RECEIVER_LIFECYCLE',
        { result: 'STOPPED', phase: 'shutdown' },
        `pipeName=${options.pipeName} reason=signal`,
      )
      persistentLog.flush()
      persistentLog.dispose()
      void transport.stop().finally(resolve)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}

function parseOptions(argv: string[]): ProductionReceiverOptions {
  const [pipeName, mode = 'real', summaryPath, maxMessagesText, invalidOutboundMessageId] = argv
  if (!pipeName || (mode !== 'real' && mode !== 'fake')) {
    throw new Error('Usage: production-agent-receiver <pipeName> [real|fake] [summaryPath] [maxMessages] [invalidOutboundMessageId]')
  }

  const parsedMaxMessages = maxMessagesText ? Number.parseInt(maxMessagesText, 10) : undefined
  if (maxMessagesText && (parsedMaxMessages === undefined || !Number.isInteger(parsedMaxMessages))) {
    throw new Error('maxMessages must be a positive integer')
  }
  if (maxMessagesText && parsedMaxMessages !== undefined && parsedMaxMessages <= 0) {
    throw new Error('maxMessages must be a positive integer')
  }

  return {
    pipeName,
    mode,
    summaryPath,
    maxMessages: parsedMaxMessages,
    invalidOutboundMessageId,
  }
}

if (process.argv[1]?.endsWith('production-agent-receiver.js')) {
  runProductionReceiver(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(`[PRODUCTION_AGENT_RECEIVER_ERROR] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
