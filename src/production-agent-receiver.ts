import { ChatService, type ChatMentionFact } from './chat.js'
import {
  ABSENT_BOT_MENTION_SPANS,
  ABSENT_USER_CONTENT_SPAN,
  canonicalUserText,
  describeUserText,
} from './canonical-user-text.js'
import { GroupContext, type GroupMessage } from './context.js'
import { GroupAmbientContext, type AmbientLine } from './group-ambient-context.js'
import { config, validateChatConfig } from './config.js'
import type { AgentExecutor, AgentPassiveContext, AgentRequest } from './agent-adapter.js'
import { ProductionAgentTransportServer } from './production-agent-transport.js'
import { MemoryExtractor } from './memory-extractor.js'
import { MemoryService } from './memory-service.js'
import { MemoryStore } from './memory-store.js'
import { SpeakerLabelRegistry } from './speaker-labels.js'
import {
  buildWebSearchContext,
  normalizeWebSearchResults,
  TavilyWebSearchProvider,
  WebSearchError,
  type WebSearchFailureReason,
  type WebSearchProvider,
  type WebSearchResult,
} from './web-search.js'
import {
  formatWebSearchDecisionProtocol,
  WebSearchPlanner,
  parseWebSearchDecisionProtocol,
  type WebSearchPlannerLike,
} from './web-search-planner.js'
import {
  emitDiagnostic,
  PersistentRuntimeLog,
  PersistentRuntimeLogSink,
  type TokenCorrelationState,
} from './persistent-runtime-log.js'
import { createRuntimeTimeFacts, type RuntimeClock, type RuntimeTimeFacts } from './runtime-time.js'

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

const UNTRUSTED_GROUP_ID_PLACEHOLDER = '[REDACTED_ID]'

/**
 * Privacy-only fallback for an older/invalid GROUP user-content claim.
 * This replaces exact runtime-known identity values without attempting to
 * infer where the user's body starts or interpreting any framing syntax.
 */
function redactUntrustedGroupIds(text: string, request: AgentRequest): string {
  const values = [request.requesterId, request.senderId, request.conversationId]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length)
  let redacted = text
  for (const value of values) {
    redacted = redacted.split(value).join(UNTRUSTED_GROUP_ID_PLACEHOLDER)
  }
  return redacted
}

export interface ProductionChatAgentOptions {
  /** Persistent memory. Absent means memory is disabled (tests, fake mode). */
  memory?: MemoryService | null
  speakerLabels?: SpeakerLabelRegistry
  /**
   * Group ambient context (passive group chatter). Injectable so a test can pin
   * the clock or the bounds; production gets the configured singleton per Agent.
   */
  ambientContext?: GroupAmbientContext
  /**
   * Optional persistent runtime log. When absent the agent falls back to a
   * silent no-op sink so the call sites stay identical for tests.
   */
  persistentLog?: PersistentRuntimeLog
  /** Optional autonomous web-search seam. Absent means zero planner/provider calls. */
  webSearchPlanner?: WebSearchPlannerLike | null
  webSearchProvider?: WebSearchProvider | null
  webSearchMaxResults?: number
  webSearchTimeoutMs?: number
  webSearchMaxContextChars?: number
  runtimeClock?: RuntimeClock
  runtimeTimeZone?: string
}

export class ProductionChatAgent implements AgentExecutor {
  private readonly context: GroupContext
  private readonly ambient: GroupAmbientContext
  private readonly speakerLabels: SpeakerLabelRegistry
  private readonly memory: MemoryService | null
  private readonly persistentLog: PersistentRuntimeLog | null
  private readonly webSearchPlanner: WebSearchPlannerLike | null
  private readonly webSearchProvider: WebSearchProvider | null
  private readonly webSearchMaxResults: number
  private readonly webSearchTimeoutMs: number
  private readonly webSearchMaxContextChars: number
  private readonly runtimeClock: RuntimeClock
  private readonly runtimeTimeZone: string | undefined

  public constructor(
    private readonly chatService: ChatService,
    options: ProductionChatAgentOptions = {},
  ) {
    this.speakerLabels = options.speakerLabels ?? new SpeakerLabelRegistry()
    this.memory = options.memory ?? null
    this.persistentLog = options.persistentLog ?? null
    this.webSearchPlanner = options.webSearchPlanner ?? null
    this.webSearchProvider = options.webSearchProvider ?? null
    this.webSearchMaxResults = options.webSearchMaxResults ?? config.webSearchMaxResults
    this.webSearchTimeoutMs = options.webSearchTimeoutMs ?? config.webSearchTimeoutMs
    this.webSearchMaxContextChars = options.webSearchMaxContextChars ?? config.webSearchMaxContextChars
    this.runtimeClock = options.runtimeClock ?? { now: () => new Date() }
    this.runtimeTimeZone = options.runtimeTimeZone ?? config.agentTimeZone
    this.context = new GroupContext(
      config.maxContextMessages,
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
    )
    this.ambient = options.ambientContext ?? new GroupAmbientContext({
      maxEntries: config.ambientMaxEntries,
      ttlMs: config.ambientTtlMs,
      maxChars: config.ambientMaxChars,
      sink: this.persistentLog
        ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver')
        : undefined,
    })
  }

  /**
   * Passive ambient capture. A group message that did not address the bot is
   * stored as group context and nothing else happens here:
   *
   *  - no provider call (the whole point of the passive path);
   *  - no memory read, no memory write, no extraction and no automatic-threshold
   *    buffer (three ordinary messages must never look like a remember request);
   *  - no requester context, so ambient chatter cannot be attributed to whoever
   *    asks next;
   *  - no outbound: this method cannot return anything.
   *
   * The method is synchronous on purpose. Ambience is best-effort, so there is
   * nothing to await and no failure mode that could delay or fail a chat turn.
   */
  public observePassiveContext(passive: AgentPassiveContext): void {
    this.ambient.append(passive.conversationId, {
      messageId: passive.messageId,
      speakerId: passive.senderId,
      speakerType: 'MEMBER',
      text: passive.text,
      timestamp: passive.timestamp,
    })
  }

  public async complete(request: AgentRequest): Promise<string> {
    // One immutable snapshot is shared by the Planner and final-answer prompt.
    const runtimeTime = createRuntimeTimeFacts(this.runtimeClock, this.runtimeTimeZone)
    const label = this.speakerLabels.labelFor({
      conversationType: request.conversationType,
      conversationId: request.conversationId,
      requesterId: request.requesterId,
      requesterRole: request.requesterRole,
      ownerDisplayName: request.ownerDisplayName,
      senderName: request.senderName,
      senderId: request.senderId,
    })

    const spanFacts = request.botMentionSpans ?? ABSENT_BOT_MENTION_SPANS
    const userContentSpan = request.userContentSpan ?? ABSENT_USER_CONTENT_SPAN
    // Spans are UTF-16 offsets into the WIRE body, so the projection starts there;
    // `request.text` is the trimmed view and would shift every offset.
    const wireBody = request.rawText ?? request.text
    const canonicalText = canonicalUserText(wireBody, spanFacts, userContentSpan)
    const questionText = request.conversationType === 'GROUP' && userContentSpan.trust !== 'VALID'
      ? redactUntrustedGroupIds(canonicalText, request)
      : canonicalText
    const question: GroupMessage = {
      senderId: request.senderId,
      // Never the raw runtime identity: the label is role/pseudonym based.
      senderName: label,
      // ONE canonical projection of the contract body, computed once and reused by
      // every consumer below: the memory admission gate, the extractor, the
      // retrieval query, the transcript and the final current request. It removes
      // exactly the spans the runtime identified as the BOT's tokens, so a mention
      // of another member stays in the sentence as real user text.
      text: questionText,
      timestamp: request.timestamp,
    }
    const textShape = describeUserText(wireBody, spanFacts, userContentSpan)
    // The transcript window and the event ids it covers come from ONE selection
    // pass, so the ids used for cross-context de-duplication always describe the
    // messages that are about to be rendered.
    const window = this.context.window(
      request.conversationId,
      config.contextMessageLimit,
      config.maxContextChars,
      request.messageId,
    )

    // Ambient is read before this message is appended, and the message id is
    // excluded as well: the request being answered right now is the active
    // request, and it must never be rendered a second time as ambience.
    //
    // Earlier @-messages ARE in both stores; they are excluded here by event id so
    // the ambient section complements the transcript instead of duplicating it.
    const ambient = request.conversationType === 'GROUP'
      ? this.ambient.select(request.conversationId, {
          // The store's own clock decides expiry: TTL is wall-clock time, not a
          // value the wire can influence.
          currentRequesterId: request.requesterId,
          excludeMessageId: request.messageId,
          excludeEventIds: window.eventIds,
        }).lines
      : []

    // A real mention is group history too: the next member to ask needs to see
    // that the question was already asked and what was answered.
    if (request.conversationType === 'GROUP') {
      this.ambient.append(request.conversationId, {
        messageId: request.messageId,
        speakerId: request.senderId,
        speakerType: 'MEMBER',
        text: question.text,
        timestamp: request.timestamp,
      })
    }

    this.context.append(request.conversationId, question, request.messageId)

    if (this.memory) {
      // Historical order: explicit memory intent short-circuits the chat turn,
      // then the message feeds the automatic extractor, then retrieval. All three
      // see the SAME canonical text the chat turn will see.
      const explicit = await this.memory.tryHandleExplicit({
        conversationType: request.conversationType,
        conversationId: request.conversationId,
        requesterId: request.requesterId,
        requesterRole: request.requesterRole,
        question: question.text,
        textShape,
        // The side-effect gate needs the runtime's own mention verdict: a persistent
        // memory write may only be admitted when this message really carries a
        // trusted bot mention token.
        mentionState: request.mentionState,
        botMentionSpanTrust: spanFacts.trust,
        botMentionSpanCount: spanFacts.spans.length,
        userContentSpanTrust: userContentSpan.trust,
      })
      if (explicit.handled) {
        return explicit.reply
      }

      if (request.conversationType === 'GROUP' && userContentSpan.trust !== 'VALID') {
        this.memory.reportUntrustedUserContentSpan(request.requesterRole)
      } else {
        this.memory.observeHumanMessage({
          messageId: request.messageId,
          conversationType: request.conversationType,
          conversationId: request.conversationId,
          requesterId: request.requesterId,
          requesterRole: request.requesterRole,
          speakerLabel: label,
          text: question.text,
          timestamp: request.timestamp,
          chatTriggered: true,
        })
      }
    }

    const memory = this.memory
      ? await this.memory.retrieveForChat({
          conversationType: request.conversationType,
          conversationId: request.conversationId,
          requesterId: request.requesterId,
          requesterRole: request.requesterRole,
          question: question.text,
        })
      : []

    const webSearch = await this.resolveWebSearch(
      question.text,
      window.messages,
      ambient,
      request,
      runtimeTime,
    )

    const answer = await this.chatService.reply(
      window.messages,
      question,
      {
        botDisplayName: config.botDisplayName,
        mention: mentionFact(request),
        requesterRole: request.requesterRole,
        ownerConfigured: request.ownerConfigured,
        memory,
        ambient,
        currentSpeakerLabel: request.conversationType === 'GROUP' ? label : undefined,
        // A disabled or absent store is a runtime fact: the model may not claim a
        // long-term memory that this process does not have.
        persistentMemoryAvailable: this.memory !== null && this.memory.isEnabled,
        runtimeTime,
        webSearch,
      },
      guardValues(request),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-chat') : undefined,
      request.messageId,
    )

    // The bot's own line joins the ambient transcript so the next member to ask
    // sees the whole exchange. This is GENERATED, not DELIVERY_ACKNOWLEDGED: the
    // Agent forms the answer, the runtime delivers it, and the send ACK is not on
    // this side of the boundary. A reply that passes the guard enters the
    // transcript; a blocked or failed one throws above and enters nothing.
    if (request.conversationType === 'GROUP') {
      this.ambient.append(request.conversationId, {
        messageId: `assistant:${request.messageId}`,
        speakerId: 'ASSISTANT',
        speakerType: 'ASSISTANT',
        text: answer,
        timestamp: request.timestamp,
      })
    }

    return answer
  }

  private async resolveWebSearch(
    question: string,
    recentContext: readonly GroupMessage[],
    ambient: readonly AmbientLine[],
    request: AgentRequest,
    runtimeTime: RuntimeTimeFacts,
  ): Promise<{
    used: boolean
    status: 'PASS' | 'FAILED'
    results: readonly WebSearchResult[]
    maxContextChars: number
  } | undefined> {
    if (this.webSearchPlanner === null) {
      return undefined
    }

    const planner = await this.webSearchPlanner.plan(
      {
        question,
        recentContext,
        ambient,
        runtimeTime,
      },
      guardValues(request),
    )
    const revalidated = parseWebSearchDecisionProtocol(
      formatWebSearchDecisionProtocol(planner.decision),
      guardValues(request),
    )
    const decision = planner.result === 'PASS' && revalidated.valid
      ? revalidated.decision
      : { action: 'DIRECT' as const, query: null, reasonCode: 'DIRECT_SUFFICIENT' as const }
    const decisionResult = planner.result === 'PASS' && revalidated.valid ? 'PASS' : 'FAIL'
    const failureReason = planner.result === 'PASS' && !revalidated.valid
      ? revalidated.failureReason
      : planner.failureReason ?? 'NONE'
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-web-search') : undefined,
      'WEB_SEARCH_DECISION',
      {
        action: decision.action,
        result: decisionResult,
        reasonCode: decision.reasonCode,
        queryChars: decision.query?.length ?? 0,
        plannerAttempts: planner.attempts ?? 1,
        failureReason,
      },
    )

    if (decision.action !== 'SEARCH' || decision.query === null) {
      return undefined
    }

    if (this.webSearchProvider === null) {
      this.logWebSearch('FAIL', 0, 'DISABLED')
      this.logWebSearchContext(0, 0, false)
      return { used: true, status: 'FAILED', results: [], maxContextChars: this.webSearchMaxContextChars }
    }

    try {
      const response = await this.webSearchProvider.search({
        query: decision.query,
        maxResults: this.webSearchMaxResults,
        timeoutMs: this.webSearchTimeoutMs,
      })
      const normalized = normalizeWebSearchResults(response.results)
      if (normalized.length === 0) {
        this.logWebSearch('FAIL', 0, 'NO_RESULTS')
        this.logWebSearchContext(0, 0, false)
        return { used: true, status: 'FAILED', results: [], maxContextChars: this.webSearchMaxContextChars }
      }

      const bounded = buildWebSearchContext(normalized, this.webSearchMaxContextChars)
      this.logWebSearch('PASS', bounded.results.length, 'NONE')
      this.logWebSearchContext(bounded.results.length, bounded.chars, bounded.truncated)
      if (bounded.results.length === 0) {
        return { used: true, status: 'FAILED', results: [], maxContextChars: this.webSearchMaxContextChars }
      }
      return {
        used: true,
        status: 'PASS',
        results: bounded.results,
        maxContextChars: this.webSearchMaxContextChars,
      }
    } catch (error) {
      const reason: WebSearchFailureReason = error instanceof WebSearchError
        ? error.reason
        : 'HTTP_ERROR'
      this.logWebSearch('FAIL', 0, reason)
      this.logWebSearchContext(0, 0, false)
      return { used: true, status: 'FAILED', results: [], maxContextChars: this.webSearchMaxContextChars }
    }
  }

  private logWebSearch(result: 'PASS' | 'FAIL', resultCount: number, reason: WebSearchFailureReason | 'NONE'): void {
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-web-search') : undefined,
      'WEB_SEARCH',
      { result, resultCount, reason },
    )
  }

  private logWebSearchContext(resultCount: number, chars: number, truncated: boolean): void {
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-web-search') : undefined,
      'WEB_SEARCH_CONTEXT',
      { resultCount, chars, truncated },
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
  const webSearchPlanner = config.webSearchEnabled
    ? new WebSearchPlanner((system, user) => chatService.completeStructured(system, user))
    : null
  const webSearchProvider = config.webSearchEnabled
    ? new TavilyWebSearchProvider(config.tavilyApiBase, config.tavilyApiKey)
    : null
  return new ProductionChatAgent(chatService, {
    memory: createMemoryService(chatService, options.persistentLog),
    persistentLog: options.persistentLog,
    webSearchPlanner,
    webSearchProvider,
    webSearchMaxResults: config.webSearchMaxResults,
    webSearchTimeoutMs: config.webSearchTimeoutMs,
    webSearchMaxContextChars: config.webSearchMaxContextChars,
    runtimeTimeZone: config.agentTimeZone,
  })
}

/**
 * Persistent memory runtime. A disabled or broken store degrades to "no memory"
 * with an explicit `[MEMORY_STORE]` diagnostic instead of failing chat.
 *
 * The same persistent sink the receiver, transport and chat already use is
 * injected here, so every memory decision is durable as well as visible on
 * stdout: one sink, one component (`agent-memory`), no second logger.
 *
 * Retrieval makes NO provider call. `MemoryService.retrieveForChat` authorizes,
 * budgets and returns the working set; the final chat turn is the only model
 * call an active request makes. The two remaining structured completions here
 * are the automatic extractor and the explicit "记住" mutation parser, both of
 * which are write-path and unchanged.
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
