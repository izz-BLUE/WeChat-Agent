import {
  ChatService,
  MIN_FINAL_ANSWER_BUDGET_MS,
  REQUEST_DEADLINE_FALLBACK_REPLY,
  type ChatMentionFact,
  type ChatPromptMessage,
  type MemoryPromptItem,
} from './chat.js'
import { sanitizeFinalAnswer } from './final-answer.js'
import { decorateYeyeReplySignatureWithDiagnostics } from './chat-renderer.js'
import {
  ABSENT_BOT_MENTION_SPANS,
  ABSENT_USER_CONTENT_SPAN,
  canonicalUserText,
  describeUserText,
} from './canonical-user-text.js'
import { GroupContext, type GroupMessage } from './context.js'
import { ASSISTANT_LABEL, GroupAmbientContext, type AmbientLine } from './group-ambient-context.js'
import {
  GroupConversationContextAssembler,
  stabilizeActiveAmbientLabels,
  type GroupConversationContext,
} from './group-conversation-context.js'
import { RequesterLocalContext } from './requester-local-context.js'
import {
  GroupTopicCapsuleCompactor,
  GroupTopicCapsuleStore,
  type TopicCapsuleStructuredCompletion,
} from './group-topic-capsule.js'
import { config, validateChatConfig } from './config.js'
import type {
  AgentExecutor,
  AgentPassiveContext,
  AgentRequest,
  OwnerAliasWakeContext,
  OutboundCommand,
} from './agent-adapter.js'
import {
  PendingOutboundReplyStore,
  type OutboundDeliveryAck,
  type OutboundIdentity,
  type DeliveryAckResult,
} from './outbound-delivery.js'
import { ProductionAgentTransportServer } from './production-agent-transport.js'
import { MemoryExtractor } from './memory-extractor.js'
import { GROUP_SCOPE_KEYWORDS, isExplicitMemoryCommand, MemoryService } from './memory-service.js'
import { MemoryStore } from './memory-store.js'
import { SpeakerLabelRegistry } from './speaker-labels.js'
import {
  buildWebSearchContext,
  enrichWebSearchResultsWithPageEvidence,
  normalizeWebSearchResults,
  rankWebSearchResults,
  SearXNGWebSearchProvider,
  TavilyWebSearchProvider,
  WebSearchError,
  type WebSearchMode,
  type WebSearchFailureReason,
  type WebSearchProvider,
  type WebSearchResult,
  type WebSearchQueryOrigin,
  type WebSearchWindow,
  type WebPageDnsLookup,
  type WebPageFetchImplementation,
} from './web-search.js'
import {
  formatWebSearchDecisionProtocol,
  WebSearchPlanner,
  parseWebSearchDecisionProtocol,
  type WebSearchRecencyWindow,
  type WebSearchPlannerLike,
} from './web-search-planner.js'
import {
  emitDiagnostic,
  PersistentRuntimeLog,
  PersistentRuntimeLogSink,
  type TokenCorrelationState,
} from './persistent-runtime-log.js'
import { createRuntimeTimeFacts, type RuntimeClock, type RuntimeTimeFacts } from './runtime-time.js'
import { observeGroupStyle } from './group-style.js'
import { deriveGroupReplyPressure, observeConversationDynamics } from './conversation-dynamics.js'
import { deriveMemberInteractionProfile } from './member-interaction-profile.js'
import {
  isOwnerDispatchCandidate,
  type OwnerDispatchPlannerLike,
  OwnerDispatchPlanner,
} from './owner-dispatch-planner.js'
import {
  OwnerPrivateDispatchPlanner,
  formatOwnerPrivateDispatchProtocol,
  parseOwnerPrivateDispatchProtocol,
  type OwnerPrivateDispatchPlannerLike,
} from './owner-private-dispatch-planner.js'
import { isGroupConversationId, isVerifiedOwnerDirect, SUPPORTED_TEXT_MESSAGE_TYPE } from './message-contract.js'
import { isRequestDeadlineExceeded, RequestDeadline, withRequestDeadline } from './request-deadline.js'
import { identityToken } from './identity-observer.js'
import { createTrustedAssistantRuntimeFacts } from './assistant-identity.js'
import { renderOwnerEscalationHint } from './owner-escalation.js'
import {
  DEFAULT_OWNER_ALIAS_WAKE_COOLDOWN_MS,
  OwnerAliasWakeGate,
} from './owner-alias-wake.js'
import {
  DEFAULT_PROACTIVE_QUEUE_MAX_ENTRIES,
  DEFAULT_PROACTIVE_QUEUE_TTL_MS,
  ProactiveGroupQueue,
} from './proactive-group-queue.js'

function finalizeYeyeReply(
  answer: string,
  reportSignature = false,
  persistentSink?: PersistentRuntimeLogSink,
): string {
  const decorated = decorateYeyeReplySignatureWithDiagnostics(answer)
  if (reportSignature) {
    emitDiagnostic(
      (line: string) => console.log(line),
      persistentSink,
      'YEYE_REPLY_SIGNATURE',
      {
        beforeCount: decorated.beforeCount,
        afterCount: decorated.afterCount,
        placement: decorated.placement,
        result: decorated.afterCount <= 1 ? 'PASS' : 'FAIL',
      },
    )
  }
  return sanitizeFinalAnswer(decorated.text).text
}

/**
 * Safe presentation adapter for the shared conversational pipeline. These
 * values are constants because a passive wire event carries no authority facts.
 */
function toOwnerAliasPresentationRequest(context: OwnerAliasWakeContext): AgentRequest {
  return {
    conversationKey: `group:${context.conversationId}`,
    messageId: context.messageId,
    conversationType: 'GROUP',
    conversationId: context.conversationId,
    senderId: context.senderId,
    requesterId: context.requesterId,
    requesterSource: 'PASSIVE_CONTEXT_ONLY',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    ownerDisplayName: null,
    publicDisplayName: context.publicDisplayName ?? null,
    privateDispatchTargetConversationId: null,
    senderName: null,
    text: context.text,
    rawText: context.text,
    timestamp: context.timestamp,
    mentionState: 'NOT_MENTIONED',
    botMentionSpans: ABSENT_BOT_MENTION_SPANS,
    userContentSpan: {
      trust: 'VALID',
      span: { start: 0, length: context.text.length },
    },
    metadata: { rawMessageType: SUPPORTED_TEXT_MESSAGE_TYPE },
  }
}

export const MIN_SEARCH_FALLBACK_BUDGET_MS = 3_000
export const MIN_ALT_QUERY_SEARCH_BUDGET_MS = 3_000
export const MIN_PAGE_FETCH_BUDGET_MS = 2_500

export interface SearchProviderFallbackBudget {
  remainingMs: number
  reservedFinalAnswerMs: number
  availableFallbackBudgetMs: number
  minimumFallbackBudgetMs: number
  effectiveFallbackTimeoutMs: number
  result: 'RUN' | 'SKIP'
}

export function calculateSearchProviderFallbackBudget(
  remainingMs: number,
  webSearchTimeoutMs: number,
): SearchProviderFallbackBudget {
  const safeRemainingMs = Math.max(0, remainingMs)
  const availableFallbackBudgetMs = Math.max(0, safeRemainingMs - MIN_FINAL_ANSWER_BUDGET_MS)
  const effectiveFallbackTimeoutMs = Math.min(
    Math.max(0, webSearchTimeoutMs),
    availableFallbackBudgetMs,
  )
  return {
    remainingMs: safeRemainingMs,
    reservedFinalAnswerMs: MIN_FINAL_ANSWER_BUDGET_MS,
    availableFallbackBudgetMs,
    minimumFallbackBudgetMs: MIN_SEARCH_FALLBACK_BUDGET_MS,
    effectiveFallbackTimeoutMs,
    result: availableFallbackBudgetMs >= MIN_SEARCH_FALLBACK_BUDGET_MS ? 'RUN' : 'SKIP',
  }
}

/**
 * Bound one provider call to the search-stage budget while keeping the parent
 * RequestDeadline as the authoritative whole-request timeout. The local timer
 * is important for providers that do not honor their numeric timeout field.
 */
async function withSearchStageBudget<T>(
  deadline: RequestDeadline,
  budgetMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const effectiveBudgetMs = Math.min(
    Math.max(1, Math.floor(budgetMs)),
    Math.max(1, deadline.remainingMs()),
  )
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const operationPromise = withRequestDeadline(deadline, (deadlineSignal) => {
    const abortFromDeadline = (): void => controller.abort()
    if (deadlineSignal.aborted) {
      controller.abort()
    }
    deadlineSignal.addEventListener('abort', abortFromDeadline, { once: true })
    return operation(controller.signal).finally(() => {
      deadlineSignal.removeEventListener('abort', abortFromDeadline)
    })
  })
  const budgetTimeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new WebSearchError('TIMEOUT'))
    }, effectiveBudgetMs)
  })
  try {
    return await Promise.race([operationPromise, budgetTimeout])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

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
  return [
    request.requesterId,
    request.conversationId,
    request.senderId,
    request.privateDispatchTargetConversationId ?? '',
  ]
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

interface ActiveContextSplit {
  currentRequester: ChatPromptMessage[]
  otherMembers: ChatPromptMessage[]
}

/**
 * Split only the already-selected active transcript. The comparison uses the
 * trusted requester identity when available and the stable internal label as a
 * compatibility anchor; display names and message text never participate.
 */
function splitActiveContext(
  messages: readonly GroupMessage[],
  requesterId: string,
  senderId: string,
  currentSpeakerLabel: string,
): ActiveContextSplit {
  const currentRequester: ChatPromptMessage[] = []
  const otherMembers: ChatPromptMessage[] = []
  for (const message of messages) {
    const belongsToCurrentRequester =
      message.senderId === requesterId ||
      message.senderId === senderId ||
      message.senderName === currentSpeakerLabel
    if (belongsToCurrentRequester) {
      // Rebase historical current-requester entries to the current stable label
      // without changing GroupContext storage or exposing any identity.
      const { senderId: _senderId, ...providerSafeMessage } = message
      currentRequester.push({ ...providerSafeMessage, senderName: currentSpeakerLabel })
    } else {
      const { senderId: _senderId, ...providerSafeMessage } = message
      otherMembers.push(providerSafeMessage)
    }
  }
  return { currentRequester, otherMembers }
}

function dateDaysBefore(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) {
    return localDate
  }
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
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
  /** Backwards-compatible single-provider seam used by existing tests/callers. */
  webSearchProvider?: WebSearchProvider | null
  tavilyWebSearchProvider?: WebSearchProvider | null
  searxngWebSearchProvider?: WebSearchProvider | null
  webSearchMaxResults?: number
  webSearchTimeoutMs?: number
  webSearchMaxContextChars?: number
  /** Optional bounded page-evidence enrichment. Tests keep this disabled unless explicitly enabled. */
  webPageFetchEnabled?: boolean
  webPageFetchMaxResults?: number
  webPageFetchTimeoutMs?: number
  webPageFetchMaxCharsPerPage?: number
  webPageFetchMaxTotalChars?: number
  webPageFetchImplementation?: WebPageFetchImplementation
  webPageDnsLookup?: WebPageDnsLookup
  requestDeadlineMs?: number
  /** Narrow test seam for constructing an already-expired or controlled deadline. */
  requestDeadlineFactory?: (budgetMs: number) => RequestDeadline
  runtimeClock?: RuntimeClock
  runtimeTimeZone?: string
  pendingOutboundMaxEntries?: number
  pendingOutboundTtlMs?: number
  ownerDispatchPlanner?: OwnerDispatchPlannerLike | null
  ownerPrivateDispatchPlanner?: OwnerPrivateDispatchPlannerLike | null
  proactiveQueue?: ProactiveGroupQueue
  proactiveQueueMaxEntries?: number
  proactiveQueueTtlMs?: number
  requesterLocalContext?: RequesterLocalContext
  topicCapsuleStore?: GroupTopicCapsuleStore
  topicCapsuleCompactor?: GroupTopicCapsuleCompactor
  topicCapsuleCompletion?: TopicCapsuleStructuredCompletion
  ownerAliasWakeCooldownMs?: number
}

interface RequestDeadlineDiagnostics {
  preFinalRemainingMs?: number
}

export class ProductionChatAgent implements AgentExecutor {
  private readonly context: GroupContext
  private readonly ambient: GroupAmbientContext
  private readonly requesterLocal: RequesterLocalContext
  private readonly topicCapsules: GroupTopicCapsuleStore
  private readonly topicCompactor: GroupTopicCapsuleCompactor | null
  private readonly groupContextAssembler: GroupConversationContextAssembler
  private readonly speakerLabels: SpeakerLabelRegistry
  private readonly memory: MemoryService | null
  private readonly persistentLog: PersistentRuntimeLog | null
  private readonly webSearchPlanner: WebSearchPlannerLike | null
  private readonly tavilyWebSearchProvider: WebSearchProvider | null
  private readonly searxngWebSearchProvider: WebSearchProvider | null
  private readonly webSearchMaxResults: number
  private readonly webSearchTimeoutMs: number
  private readonly webSearchMaxContextChars: number
  private readonly webPageFetchEnabled: boolean
  private readonly webPageFetchMaxResults: number
  private readonly webPageFetchTimeoutMs: number
  private readonly webPageFetchMaxCharsPerPage: number
  private readonly webPageFetchMaxTotalChars: number
  private readonly webPageFetchImplementation: WebPageFetchImplementation | undefined
  private readonly webPageDnsLookup: WebPageDnsLookup | undefined
  private readonly requestDeadlineMs: number
  private readonly requestDeadlineFactory: (budgetMs: number) => RequestDeadline
  private readonly runtimeClock: RuntimeClock
  private readonly runtimeTimeZone: string | undefined
  private readonly pendingOutbound: PendingOutboundReplyStore
  private readonly ownerDispatchPlanner: OwnerDispatchPlannerLike | null
  private readonly ownerPrivateDispatchPlanner: OwnerPrivateDispatchPlannerLike | null
  private readonly proactiveQueue: ProactiveGroupQueue
  private readonly ownerAliasWakeGate: OwnerAliasWakeGate
  private readonly ownerAliasWakeInFlight = new Set<string>()

  public constructor(
    private readonly chatService: ChatService,
    options: ProductionChatAgentOptions = {},
  ) {
    this.speakerLabels = options.speakerLabels ?? new SpeakerLabelRegistry()
    this.memory = options.memory ?? null
    this.persistentLog = options.persistentLog ?? null
    this.webSearchPlanner = options.webSearchPlanner ?? null
    const legacyWebSearchProvider = options.webSearchProvider ?? null
    this.tavilyWebSearchProvider = options.tavilyWebSearchProvider ?? legacyWebSearchProvider
    this.searxngWebSearchProvider = options.searxngWebSearchProvider ?? legacyWebSearchProvider
    this.webSearchMaxResults = options.webSearchMaxResults ?? config.webSearchMaxResults
    this.webSearchTimeoutMs = options.webSearchTimeoutMs ?? config.webSearchTimeoutMs
    this.webSearchMaxContextChars = options.webSearchMaxContextChars ?? config.webSearchMaxContextChars
    this.webPageFetchEnabled = options.webPageFetchEnabled ?? false
    this.webPageFetchMaxResults = Math.min(3, Math.max(0, Math.floor(options.webPageFetchMaxResults ?? config.webPageFetchMaxResults)))
    this.webPageFetchTimeoutMs = options.webPageFetchTimeoutMs ?? config.webPageFetchTimeoutMs
    this.webPageFetchMaxCharsPerPage = options.webPageFetchMaxCharsPerPage ?? config.webPageFetchMaxCharsPerPage
    this.webPageFetchMaxTotalChars = options.webPageFetchMaxTotalChars ?? config.webPageFetchMaxTotalChars
    this.webPageFetchImplementation = options.webPageFetchImplementation
    this.webPageDnsLookup = options.webPageDnsLookup
    this.requestDeadlineMs = options.requestDeadlineMs ?? config.agentRequestDeadlineMs
    this.requestDeadlineFactory = options.requestDeadlineFactory ?? ((budgetMs) => new RequestDeadline(budgetMs))
    this.runtimeClock = options.runtimeClock ?? { now: () => new Date() }
    this.runtimeTimeZone = options.runtimeTimeZone ?? config.agentTimeZone
    this.ownerAliasWakeGate = new OwnerAliasWakeGate(
      options.ownerAliasWakeCooldownMs ?? DEFAULT_OWNER_ALIAS_WAKE_COOLDOWN_MS,
      () => this.runtimeClock.now().getTime(),
    )
    this.pendingOutbound = new PendingOutboundReplyStore({
      maxEntries: options.pendingOutboundMaxEntries,
      ttlMs: options.pendingOutboundTtlMs,
      // Pending delivery is process-local wall-clock state. The request timestamp
      // remains the ambient event timestamp; it is not used as a TTL clock.
      now: () => Date.now(),
    })
    this.ownerDispatchPlanner = options.ownerDispatchPlanner ?? null
    this.ownerPrivateDispatchPlanner = options.ownerPrivateDispatchPlanner ?? null
    this.proactiveQueue = options.proactiveQueue ?? new ProactiveGroupQueue({
      maxEntries: options.proactiveQueueMaxEntries ?? DEFAULT_PROACTIVE_QUEUE_MAX_ENTRIES,
      ttlMs: options.proactiveQueueTtlMs ?? DEFAULT_PROACTIVE_QUEUE_TTL_MS,
    })
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
    this.requesterLocal = options.requesterLocalContext ?? new RequesterLocalContext({
      maxEntries: config.requesterLocalMaxEntries,
      ttlMs: config.requesterLocalTtlMs,
      maxChars: config.requesterLocalMaxChars,
      sink: this.persistentLog
        ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver')
      : undefined,
    })
    this.topicCapsules = options.topicCapsuleStore ?? new GroupTopicCapsuleStore({
      maxCapsulesPerGroup: config.topicCapsuleMaxPerGroup,
      ttlMs: config.topicCapsuleTtlMs,
      maxSelected: config.topicCapsuleMaxSelected,
      maxChars: config.topicCapsuleMaxChars,
      summaryMaxChars: config.topicCapsuleSummaryMaxChars,
    })
    this.topicCompactor = options.topicCapsuleCompactor ?? (
      config.topicCapsuleEnabled && options.topicCapsuleCompletion !== undefined
        ? new GroupTopicCapsuleCompactor({
            ambient: this.ambient,
            store: this.topicCapsules,
            complete: options.topicCapsuleCompletion,
            triggerEventCount: config.topicCapsuleTriggerEventCount,
            triggerCharCount: config.topicCapsuleTriggerCharCount,
            recentRawEntries: config.topicCapsuleRecentRawEntries,
            recentRawMaxChars: config.topicCapsuleRecentRawChars,
            timeoutMs: config.topicCapsuleCompactionTimeoutMs,
            sink: this.persistentLog
              ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-topic')
              : undefined,
          })
        : null
    )
    this.groupContextAssembler = new GroupConversationContextAssembler(
      this.requesterLocal,
      this.ambient,
      {
        requesterLocalMaxEntries: config.requesterLocalMaxEntries,
        requesterLocalMaxChars: config.requesterLocalMaxChars,
        groupAmbientMaxEntries: config.ambientMaxEntries,
        groupAmbientMaxChars: config.ambientMaxChars,
        topicCapsuleStore: this.topicCapsules,
        topicCapsuleMaxSelected: config.topicCapsuleMaxSelected,
        topicCapsuleMaxChars: config.topicCapsuleMaxChars,
      },
    )
  }

  /**
   * Passive ambient capture. A group message that did not address the bot is
   * stored as group context and nothing else happens here:
   *
   *  - no provider call (the whole point of the passive path);
   *  - no memory read, no memory write, no extraction and no automatic-threshold
   *    buffer (three ordinary messages must never look like a remember request);
   *  - no persistent memory or provider call; the same trusted sender is retained
   *    only in its own bounded requester-local session view;
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
      publicDisplayName: passive.publicDisplayName,
      text: passive.text,
      timestamp: passive.timestamp,
    })
    const label = this.speakerLabels.labelFor({
      conversationType: 'GROUP',
      conversationId: passive.conversationId,
      requesterId: passive.requesterId,
      requesterRole: 'MEMBER',
      ownerDisplayName: null,
      senderName: null,
      senderId: passive.senderId,
    })
    this.requesterLocal.append(passive.conversationId, passive.requesterId, {
      senderId: passive.senderId,
      senderName: label,
      publicDisplayName: passive.publicDisplayName,
      text: passive.text,
      timestamp: passive.timestamp,
      messageId: passive.messageId,
    })
  }

  /**
   * Generate one group-level proactive answer after passive capture. The
   * normalized passive context is the only wire input; the request-shaped values
   * used by the shared chat path below are safe presentation constants, not
   * authority facts recovered from the passive payload.
   */
  public async handleOwnerAliasWake(context: OwnerAliasWakeContext): Promise<void> {
    const wake = this.ownerAliasWakeGate.admit(context.conversationId, context.messageId)
    if (!wake.allowed) {
      this.logOwnerAliasWake(context, wake.reason, false, false, 'SKIP')
      return
    }
    if (this.ownerAliasWakeInFlight.has(context.conversationId)) {
      this.logOwnerAliasWake(context, 'SINGLE_FLIGHT', false, true, 'SKIP')
      return
    }

    this.ownerAliasWakeInFlight.add(context.conversationId)
    this.logOwnerAliasWake(context, 'DETECTED', true, false, 'PASS')
    const request = toOwnerAliasPresentationRequest(context)
    const deadline = this.requestDeadlineFactory(this.requestDeadlineMs)
    const msgIdToken = identityToken(context.messageId).slice(0, 6)
    const deadlineDiagnostics: RequestDeadlineDiagnostics = {}
    let result: 'COMPLETED' | 'GENERATION_FAILED' = 'COMPLETED'
    try {
      const answer = await this.completeWithinDeadline(
        request,
        deadline,
        msgIdToken,
        deadlineDiagnostics,
        true,
      )
      deadline.throwIfExpired()
      const finalAnswer = finalizeYeyeReply(
        answer,
        true,
        this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
      )
      if (!finalAnswer) {
        result = 'GENERATION_FAILED'
        this.logOwnerAliasWake(context, 'GENERATION_FAILED', true, true, 'FAIL')
        return
      }
      this.logOwnerAliasWake(context, 'GENERATED', true, true, 'PASS')
      const queued = this.proactiveQueue.enqueue({
        conversationType: 'GROUP',
        conversationId: context.conversationId,
        text: finalAnswer,
      })
      if (!queued.accepted) {
        result = 'GENERATION_FAILED'
        this.logOwnerAliasWake(context, 'QUEUE_FULL', true, true, 'FAIL')
        this.logProactiveQueue('ENQUEUE', 'DROP', this.proactiveQueue.size)
        return
      }
      this.logOwnerAliasWake(context, 'QUEUED', true, true, 'PASS')
      this.logProactiveQueue('ENQUEUE', 'PASS', this.proactiveQueue.size)
    } catch {
      result = 'GENERATION_FAILED'
      this.logOwnerAliasWake(context, 'GENERATION_FAILED', true, true, 'FAIL')
    } finally {
      this.ownerAliasWakeInFlight.delete(context.conversationId)
      emitDiagnostic(
        (line: string) => console.log(line),
        this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
        'AGENT_REQUEST_DEADLINE',
        {
          budgetMs: this.requestDeadlineMs,
          elapsedMs: Date.now() - deadline.startedAt,
          finalAnswerLatencyMs: deadline.phaseLatencyMs('FINAL_ANSWER'),
          totalRequestLatencyMs: Date.now() - deadline.startedAt,
          remainingMs: deadline.remainingMs(),
          preFinalRemainingMs: deadlineDiagnostics.preFinalRemainingMs,
          result,
          phase: deadline.phase,
          msgIdToken,
        },
      )
    }
  }

  /** Returns the opaque identity staged for the exact generated answer. */
  public takeOutboundIdentity(request: AgentRequest, text: string): OutboundIdentity | null {
    return this.pendingOutbound.getIdentityFor(request.messageId, text)
  }

  /**
   * Poll-only drain. Claiming happens before the command leaves this process and
   * the pending delivery record is staged before the C# side can send it.
   */
  public pollProactiveOutbound(): OutboundCommand | null {
    const expired = this.proactiveQueue.pruneExpired()
    if (expired > 0) this.logProactiveQueue('EXPIRE', 'DROP', expired)

    const item = this.proactiveQueue.claimReady()
    if (item === null) return null

    this.logProactiveQueue('CLAIM', 'PASS', this.proactiveQueue.size)
    const requestMessageId = `proactive:${item.taskId}`
    try {
      const identity = this.pendingOutbound.stage({
        requestMessageId,
        conversationType: item.conversationType,
        conversationId: item.conversationId,
        text: item.text,
        timestamp: item.createdAt,
      })
      this.proactiveQueue.finalize(item.taskId)
      this.logProactiveQueue('FINALIZE', 'PASS', this.proactiveQueue.size)
      return {
        outboundId: identity.outboundId,
        requestMessageId: identity.requestMessageId,
        contentSha256: identity.contentSha256,
        conversationType: item.conversationType,
        conversationId: item.conversationId,
        text: item.text,
      }
    } catch {
      this.proactiveQueue.finalize(item.taskId)
      this.logProactiveQueue('FINALIZE', 'DROP', this.proactiveQueue.size)
      return null
    }
  }

  /**
   * Delivery ACKs are a side channel. This method only settles the in-memory
   * pending record and, for SENT, commits one already-generated line to ambient;
   * it never calls the provider, memory service, planner or search provider.
   */
  public observeOutboundDelivery(ack: OutboundDeliveryAck): DeliveryAckResult {
    const result = this.pendingOutbound.settle(ack, (pending) => {
      if (pending.conversationType === 'GROUP') {
        this.ambient.append(pending.conversationId, {
          messageId: `assistant:${pending.requestMessageId}`,
          speakerId: 'ASSISTANT',
          speakerType: 'ASSISTANT',
          text: pending.text,
          timestamp: pending.timestamp,
          ...(pending.replyToSpeakerId === undefined ? {} : { replyToSpeakerId: pending.replyToSpeakerId }),
        })
        if (pending.replyToSpeakerId !== undefined) {
          this.requesterLocal.append(pending.conversationId, pending.replyToSpeakerId, {
            senderId: 'ASSISTANT',
            senderName: ASSISTANT_LABEL,
            text: pending.text,
            timestamp: pending.timestamp,
            messageId: `assistant:${pending.requestMessageId}`,
          })
          // Compaction is scheduled only after a real active GROUP reply is
          // acknowledged SENT. The scheduler defers the provider call so this
          // ACK path never waits for or joins the foreground response.
          this.topicCompactor?.schedule(pending.conversationId)
        }
      }
    })
    if (this.persistentLog) {
      new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver').writeStructured(
        'DELIVERY_ACK',
        {
          status: ack.status,
          result: result.accepted
            ? result.reason === 'SENT_COMMITTED' ? 'COMMITTED' : 'DISCARDED'
            : 'REJECTED',
          reason: result.accepted ? '' : result.reason,
        },
        `outboundIdToken=${this.persistentLog.shortIdFor(ack.outboundId)}`,
      )
    }
    return result
  }

  public async complete(request: AgentRequest): Promise<string> {
    const deadline = this.requestDeadlineFactory(this.requestDeadlineMs)
    const msgIdToken = this.persistentLog?.shortIdFor(request.messageId) ?? identityToken(request.messageId).slice(0, 6)
    const deadlineDiagnostics: RequestDeadlineDiagnostics = {}
    let result: 'COMPLETED' | 'DEADLINE_FALLBACK' = 'COMPLETED'
    try {
      const answer = await this.completeWithinDeadline(request, deadline, msgIdToken, deadlineDiagnostics)
      deadline.throwIfExpired()
      return finalizeYeyeReply(
        answer,
        true,
        this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
      )
    } catch (error) {
      if (!isRequestDeadlineExceeded(error)) {
        throw error
      }
      result = 'DEADLINE_FALLBACK'
      const fallback = finalizeYeyeReply(
        REQUEST_DEADLINE_FALLBACK_REPLY,
        true,
        this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
      )
      this.stageOutbound(request, fallback, msgIdToken)
      return fallback
    } finally {
      const elapsedMs = Date.now() - deadline.startedAt
      emitDiagnostic(
        (line: string) => console.log(line),
        this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
        'AGENT_REQUEST_DEADLINE',
        {
          budgetMs: this.requestDeadlineMs,
          elapsedMs,
          ownerDispatchLatencyMs: deadline.phaseLatencyMs('OWNER_DISPATCH_PLANNER'),
          plannerLatencyMs: deadline.phaseLatencyMs('WEB_SEARCH_PLANNER'),
          searchLatencyMs: deadline.phaseLatencyMs('WEB_SEARCH'),
          finalAnswerLatencyMs: deadline.phaseLatencyMs('FINAL_ANSWER'),
          groundingRepairLatencyMs: deadline.phaseLatencyMs('GROUNDING_REPAIR'),
          totalRequestLatencyMs: elapsedMs,
          remainingMs: deadline.remainingMs(),
          preFinalRemainingMs: deadlineDiagnostics.preFinalRemainingMs,
          result,
          phase: deadline.phase,
          msgIdToken,
        },
      )
    }
  }

  private async completeWithinDeadline(
    request: AgentRequest,
    deadline: RequestDeadline,
    msgIdToken: string,
    deadlineDiagnostics: RequestDeadlineDiagnostics,
    aliasWake = false,
  ): Promise<string> {
    if (isVerifiedOwnerDirect(request)) {
      return this.tryOwnerPrivateDispatch(request, deadline, msgIdToken)
    }

    // One immutable snapshot is shared by the Planner and final-answer prompt.
    const runtimeTime = createRuntimeTimeFacts(this.runtimeClock, this.runtimeTimeZone)
    const assistantRuntime = createTrustedAssistantRuntimeFacts(
      config.botDisplayName,
      request.ownerConfigured,
      request.ownerDisplayName,
      request.assistantCreatorDisplayName,
    )
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
      publicDisplayName: request.publicDisplayName,
      // ONE canonical projection of the contract body, computed once and reused by
      // every consumer below: the memory admission gate, the extractor, the
      // retrieval query, the transcript and the final current request. It removes
      // exactly the spans the runtime identified as the BOT's tokens, so a mention
      // of another member stays in the sentence as real user text.
      text: questionText,
      timestamp: request.timestamp,
      messageId: request.messageId,
    }
    if (request.conversationType === 'GROUP' && !aliasWake) {
      // Retain the inbound turn for the next request. The assembler excludes
      // this event id so it is rendered only as CURRENT_REQUEST this turn.
      this.requesterLocal.append(request.conversationId, request.requesterId, question)
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
    const activeContext = request.conversationType === 'GROUP'
      ? splitActiveContext(window.messages, request.requesterId, request.senderId, label)
      : { currentRequester: [], otherMembers: [] }

    const mixedGroupContext: GroupConversationContext | undefined = request.conversationType === 'GROUP'
      ? stabilizeActiveAmbientLabels(
          this.groupContextAssembler.assemble({
            groupConversationId: request.conversationId,
            requesterIdentity: request.requesterId,
            currentEventId: request.messageId,
            activeEventIds: activeContext.currentRequester
              .map((message) => message.messageId)
              .filter((messageId): messageId is string => messageId !== undefined),
            currentTurn: question,
            currentSpeakerLabel: label,
          }),
          window.messages,
        )
      : undefined
    const ambient = mixedGroupContext?.recentGroupAmbient ?? []
    if (mixedGroupContext !== undefined) {
      emitDiagnostic(
        (line: string) => console.log(line),
        this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
        'GROUP_CONTEXT_ASSEMBLY',
        { ...mixedGroupContext.diagnostics },
      )
    }

    const groupStyle = request.conversationType === 'GROUP'
      ? observeGroupStyle({
          recentGroupContext: window.messages.map((message) => ({
            text: message.text,
            speakerType: 'MEMBER' as const,
            eventId: message.messageId,
          })),
          // Style must observe the raw bounded ambient transcript, not the
          // quality-ranked/de-duplicated provider selection above.
          groupAmbientContext: this.ambient.entries(request.conversationId).map((entry) => ({
            text: entry.text,
            speakerType: entry.speakerType,
            eventId: entry.messageId,
          })),
        })
      : undefined

    const conversationDynamics = request.conversationType === 'GROUP'
      ? observeConversationDynamics({
          recentGroupContext: window.messages,
          groupAmbientContext: ambient,
          currentSpeakerLabel: label,
          currentRequesterId: request.requesterId,
        })
      : undefined
    const groupReplyPressure = conversationDynamics === undefined
      ? undefined
      : deriveGroupReplyPressure(conversationDynamics)

    if (conversationDynamics !== undefined) {
      emitDiagnostic(
        (line: string) => console.log(line),
        this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
        'CONVERSATION_DYNAMICS',
        {
          activeTurnCount: conversationDynamics.activeTurnCount,
          ambientLineCount: conversationDynamics.ambientLineCount,
          assistantRecent: conversationDynamics.assistantRecent,
          lastAssistantReplyTarget: conversationDynamics.lastAssistantReplyTarget,
          membersAfterAssistant: conversationDynamics.membersAfterAssistant,
          lastActiveRequester: conversationDynamics.lastActiveRequester,
          participation: conversationDynamics.participation,
          pace: conversationDynamics.pace,
          continuity: conversationDynamics.continuity,
          result: 'PASS',
        },
      )
      emitDiagnostic(
        (line: string) => console.log(line),
        this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
        'GROUP_REPLY_PRESSURE',
        {
          pressure: groupReplyPressure,
          participation: conversationDynamics.participation,
          pace: conversationDynamics.pace,
          result: 'PASS',
        },
      )
    }

    // A real mention is group history too: the next member to ask needs to see
    // that the question was already asked and what was answered.
    if (request.conversationType === 'GROUP' && !aliasWake) {
      this.ambient.append(request.conversationId, {
        messageId: request.messageId,
        speakerId: request.senderId,
        speakerType: 'MEMBER',
        publicDisplayName: request.publicDisplayName,
        text: question.text,
        timestamp: request.timestamp,
      })
    }

    if (!aliasWake) {
      this.context.append(request.conversationId, question, request.messageId)
    }

    if (this.memory && !aliasWake) {
      deadline.mark('MEMORY_EXPLICIT')
      // Historical order: explicit memory intent short-circuits the chat turn,
      // then the message feeds the automatic extractor, then retrieval. All three
      // see the SAME canonical text the chat turn will see.
      const memoryRequest = {
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
        requestDeadline: deadline,
        msgIdToken,
      }
      const selfAddress = this.memory.tryHandleSelfAddressPreference?.(memoryRequest) ?? { handled: false, reply: '' }
      if (selfAddress.handled) {
        return selfAddress.reply
      }
      const explicit = await this.memory.tryHandleExplicit(memoryRequest)
      if (explicit.handled) {
        return explicit.reply
      }
    }

    // The existing explicit-memory grammar already identifies a deterministic
    // GROUP-scoped mutation request. A non-owner cannot perform it, so this
    // clear Owner-only branch may explain the authorization boundary without an
    // extra model call. Other-member mutations do not satisfy the GROUP scope
    // contract here and continue through the normal safety/identity path.
    if (!aliasWake &&
        request.requesterRole !== 'OWNER' &&
        isExplicitMemoryCommand(question.text) &&
        GROUP_SCOPE_KEYWORDS.some((keyword) => question.text.includes(keyword))) {
      return renderOwnerEscalationHint('OWNER_ONLY_ACTION', assistantRuntime)
    }

    if (!aliasWake && await this.tryOwnerDispatch(request, question.text, deadline, msgIdToken)) {
      return ''
    }

    if (this.memory && !aliasWake) {
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
        }, deadline, msgIdToken)
      }
    }

    const memory = this.memory && !aliasWake
      ? await this.memory.retrieveForChat({
          conversationType: request.conversationType,
          conversationId: request.conversationId,
          requesterId: request.requesterId,
          requesterRole: request.requesterRole,
          question: question.text,
        })
      : []

    const memberInteractionProfile = request.conversationType === 'GROUP'
      ? deriveMemberInteractionProfile({
          authorizedPersonalMemory: memory.filter((item) => item.scope === 'PERSONAL'),
          recentRequesterActiveContext: mixedGroupContext?.requesterLocalContext ?? activeContext.currentRequester,
          groupStyle,
        })
      : undefined

    const webSearch = aliasWake
      ? undefined
      : await this.resolveWebSearch(
          question.text,
          window.messages,
          ambient,
          memory,
          mixedGroupContext === undefined
            ? activeContext
            : {
                currentRequester: [...mixedGroupContext.requesterLocalContext],
                otherMembers: [],
              },
          conversationDynamics,
          request,
          runtimeTime,
          deadline,
          msgIdToken,
          mixedGroupContext,
        )

    deadlineDiagnostics.preFinalRemainingMs = deadline.remainingMs()
    const answer = await this.chatService.reply(
      window.messages,
      question,
      {
        botDisplayName: config.botDisplayName,
        assistantRuntime,
        conversationType: request.conversationType,
        mention: mentionFact(request),
        ownerAliasWake: aliasWake,
        requesterRole: request.requesterRole,
        ownerConfigured: request.ownerConfigured,
        memory,
        ambient,
        currentSpeakerLabel: request.conversationType === 'GROUP' ? label : undefined,
        // A disabled or absent store is a runtime fact: the model may not claim a
        // long-term memory that this process does not have.
        persistentMemoryAvailable: this.memory !== null && this.memory.isEnabled,
        // An explicit mutation that succeeds returns above with its deterministic
        // Store-backed reply, so every ordinary Chat turn reaches this boundary
        // with no successful mutation evidence.
        memoryMutationThisTurn: 'NONE',
        runtimeTime,
        groupStyle,
        memberInteractionProfile,
        conversationDynamics,
        groupReplyPressure,
        // Preserve the existing structural split for Planner/diagnostic callers.
        // The final GROUP prompt uses the explicit mixed context below, so these
        // legacy views are not rendered as an additional prompt section.
        currentRequesterActiveContext: request.conversationType === 'GROUP'
          ? activeContext.currentRequester
          : undefined,
        otherMemberActiveContext: request.conversationType === 'GROUP'
          ? activeContext.otherMembers
          : undefined,
        groupConversationContext: mixedGroupContext,
        webSearch,
      },
      guardValues(request),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-chat') : undefined,
      request.messageId,
      deadline,
    )

    deadline.throwIfExpired()
    if (!aliasWake) {
      this.stageOutbound(request, answer, msgIdToken)
    }
    return answer
  }

  private stageOutbound(request: AgentRequest, answer: string, msgIdToken: string): void {
    const outboundText = finalizeYeyeReply(answer)
    if (!outboundText) return
    const identity = this.pendingOutbound.stage({
      requestMessageId: request.messageId,
      conversationType: request.conversationType,
      conversationId: request.conversationId,
      text: outboundText,
      timestamp: request.timestamp,
      ...(request.conversationType === 'GROUP'
        ? { replyToSpeakerId: request.requesterId }
        : {}),
    })
    if (this.persistentLog) {
      new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver').writeStructured(
        'PENDING_OUTBOUND',
        { result: 'STAGED', chars: outboundText.length, msgIdToken },
        `outboundIdToken=${this.persistentLog.shortIdFor(identity.outboundId)}`,
      )
    }

  }

  private logOwnerAliasWake(
    context: OwnerAliasWakeContext,
    reason: 'DETECTED' | 'COOLDOWN' | 'DUPLICATE' | 'SINGLE_FLIGHT' | 'GENERATED' | 'QUEUED' | 'GENERATION_FAILED' | 'QUEUE_FULL',
    cooldownAllowed: boolean,
    providerInvoked: boolean,
    result: 'PASS' | 'FAIL' | 'SKIP',
  ): void {
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
      'GROUP_WAKE',
      {
        reason,
        matchedAliasClass: context.matchedAliasClass,
        conversationType: context.conversationType,
        cooldownAllowed,
        providerInvoked,
        result,
      },
    )
  }

  private async tryOwnerDispatch(
    request: AgentRequest,
    question: string,
    deadline: RequestDeadline,
    msgIdToken: string,
  ): Promise<boolean> {
    const authorized = request.conversationType === 'GROUP' &&
      request.requesterRole === 'OWNER' &&
      request.mentionState === 'MENTIONED' &&
      request.botMentionSpans?.trust === 'VALID' &&
      request.botMentionSpans.spans.length > 0 &&
      request.userContentSpan?.trust === 'VALID'
    if (!authorized) {
      this.logOwnerDispatch('CHAT', 'FAIL', 'AUTHORIZATION', false)
      return false
    }
    if (!isOwnerDispatchCandidate(question)) {
      this.logOwnerDispatch('CHAT', 'PASS', 'FAST_PATH_CHAT', false)
      return false
    }
    if (this.ownerDispatchPlanner === null) {
      this.logOwnerDispatch('CHAT', 'FAIL', 'PLANNER_UNAVAILABLE', false)
      return false
    }

    let plan
    try {
      deadline.mark('OWNER_DISPATCH_PLANNER')
      plan = await this.ownerDispatchPlanner.plan(question, guardValues(request), deadline, msgIdToken)
      deadline.throwIfExpired()
    } catch (error) {
      if (isRequestDeadlineExceeded(error)) throw error
      this.logOwnerDispatch('CHAT', 'FAIL', 'PLANNER_EXCEPTION', true)
      return false
    }
    if (plan.result !== 'PASS' || plan.decision.action !== 'DISPATCH_NOW' || !plan.decision.message) {
      this.logOwnerDispatch('CHAT', plan.result === 'PASS' ? 'PASS' : 'FAIL', plan.failureReason ?? 'PLANNER_CHAT', true)
      return false
    }

    const queued = this.proactiveQueue.enqueue({
      conversationType: 'GROUP',
      conversationId: request.conversationId,
      text: plan.decision.message,
    })
    if (!queued.accepted) {
      this.logOwnerDispatch('DISPATCH_NOW', 'FAIL', queued.reason, true)
      this.logProactiveQueue('ENQUEUE', 'DROP', this.proactiveQueue.size)
      // A dispatch decision is still a handled command. Do not turn a full or
      // invalid queue into a second normal bot reply in the same inbound turn.
      return true
    }
    this.logOwnerDispatch('DISPATCH_NOW', 'PASS', 'ENQUEUED', true)
    this.logProactiveQueue('ENQUEUE', 'PASS', this.proactiveQueue.size)
    return true
  }

  private async tryOwnerPrivateDispatch(
    request: AgentRequest,
    deadline: RequestDeadline,
    msgIdToken: string,
  ): Promise<string> {
    const target = request.privateDispatchTargetConversationId?.trim() ?? ''
    if (!target) {
      this.logOwnerPrivateDispatch('DISPATCH', 'FAIL', 'TARGET_UNBOUND')
      return ''
    }
    if (!isGroupConversationId(target)) {
      this.logOwnerPrivateDispatch('DISPATCH', 'FAIL', 'TARGET_INVALID')
      return ''
    }
    if (this.ownerPrivateDispatchPlanner === null) {
      this.logOwnerPrivateDispatch('DISPATCH', 'FAIL', 'PLANNER_UNAVAILABLE')
      return ''
    }

    let plan
    try {
      deadline.mark('OWNER_PRIVATE_DISPATCH_PLANNER')
      plan = await this.ownerPrivateDispatchPlanner.plan(request.text, guardValues(request), deadline, msgIdToken)
      deadline.throwIfExpired()
    } catch (error) {
      if (isRequestDeadlineExceeded(error)) throw error
      this.logOwnerPrivateDispatch('DISPATCH', 'FAIL', 'PLANNER_EXCEPTION')
      return ''
    }

    if (plan.result !== 'PASS') {
      this.logOwnerPrivateDispatch('DISPATCH', 'FAIL', plan.failureReason ?? 'PLANNER_FAILED')
      return ''
    }
    const parsed = parseOwnerPrivateDispatchProtocol(
      formatOwnerPrivateDispatchProtocol(plan.decision),
      guardValues(request),
    )
    if (!parsed.valid) {
      this.logOwnerPrivateDispatch('DISPATCH', 'FAIL', parsed.failureReason)
      return ''
    }
    if (parsed.decision.action === 'NOOP') {
      this.logOwnerPrivateDispatch('NOOP', 'PASS', 'NOOP')
      return ''
    }

    const queued = this.proactiveQueue.enqueue({
      conversationType: 'GROUP',
      conversationId: target,
      text: parsed.decision.message ?? '',
    })
    if (!queued.accepted) {
      this.logOwnerPrivateDispatch('DISPATCH', 'FAIL', queued.reason)
      this.logProactiveQueue('ENQUEUE', 'DROP', this.proactiveQueue.size)
      return ''
    }
    this.logOwnerPrivateDispatch('DISPATCH', 'PASS', 'ENQUEUED')
    this.logProactiveQueue('ENQUEUE', 'PASS', this.proactiveQueue.size)
    return ''
  }

  private logOwnerPrivateDispatch(
    action: 'NOOP' | 'DISPATCH',
    result: 'PASS' | 'FAIL',
    reason: string,
  ): void {
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
      'OWNER_PRIVATE_DISPATCH',
      { action, result, reason },
    )
  }

  private logOwnerDispatch(
    action: 'CHAT' | 'DISPATCH_NOW',
    result: 'PASS' | 'FAIL',
    reason: string,
    plannerInvoked: boolean,
  ): void {
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
      'OWNER_DISPATCH',
      { action, result, reason, plannerInvoked },
    )
  }

  private logProactiveQueue(operation: 'ENQUEUE' | 'CLAIM' | 'FINALIZE' | 'EXPIRE', result: 'PASS' | 'DROP', queueSize: number): void {
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-receiver') : undefined,
      'PROACTIVE_QUEUE',
      { operation, result, queueSize },
    )
  }

  private async resolveWebSearch(
    question: string,
    recentContext: readonly GroupMessage[],
    ambient: readonly AmbientLine[],
    authorizedMemory: readonly MemoryPromptItem[],
    activeContext: ActiveContextSplit,
    conversationDynamics: ReturnType<typeof observeConversationDynamics> | undefined,
    request: AgentRequest,
    runtimeTime: RuntimeTimeFacts,
    deadline: RequestDeadline,
    msgIdToken: string,
    mixedGroupContext?: GroupConversationContext,
  ): Promise<{
    used: boolean
    status: 'PASS' | 'FAILED'
    results: readonly WebSearchResult[]
    maxContextChars: number
    mode: WebSearchMode
    window: WebSearchWindow
  } | undefined> {
    if (this.webSearchPlanner === null) {
      return undefined
    }

    deadline.mark('WEB_SEARCH_PLANNER')
    const planner = await this.webSearchPlanner.plan(
      {
        question,
        recentContext,
        ambient,
        authorizedMemory,
        runtimeTime,
        currentRequesterActiveContext: request.conversationType === 'GROUP'
          ? activeContext.currentRequester
          : undefined,
        otherMemberActiveContext: request.conversationType === 'GROUP'
          ? activeContext.otherMembers
          : undefined,
        groupConversationContext: mixedGroupContext,
        conversationDynamics,
      },
      guardValues(request),
      deadline,
      msgIdToken,
    )
    deadline.throwIfExpired()
    const revalidated = parseWebSearchDecisionProtocol(
      formatWebSearchDecisionProtocol(planner.decision),
      guardValues(request),
    )
    const decision = planner.result === 'PASS' && revalidated.valid
      ? revalidated.decision
      : { action: 'DIRECT' as const, query: null, reasonCode: 'DIRECT_SUFFICIENT' as const, mode: 'GENERAL' as const, recencyWindow: 'NONE' as const }
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
        msgIdToken,
      },
    )

    if (decision.action !== 'SEARCH' || decision.query === null) {
      return undefined
    }

    const mode = decision.mode
    const alternateQuery = decision.alternateQuery?.trim() || null
    const recencyWindow: WebSearchRecencyWindow = decision.recencyWindow
    const primaryWindow: WebSearchWindow = recencyWindow === 'DAY_1'
      ? 'DAY_1'
      : recencyWindow === 'DAY_3'
        ? 'DAY_3'
        : 'GENERAL'
    const windows = primaryWindow === 'DAY_1' ? ['DAY_1', 'DAY_3'] as const : [primaryWindow] as const
    // Provider routing is resolved once from the primary query and reused for
    // the alternate query. The two logical queries must keep identical mode,
    // recency, and provider-routing semantics.
    const preferSearXng = mode === 'GENERAL' && /\p{Script=Han}/u.test(decision.query)
    const providerCandidates = preferSearXng
      ? [this.searxngWebSearchProvider, this.tavilyWebSearchProvider]
      : [this.tavilyWebSearchProvider, this.searxngWebSearchProvider]
    const providers: WebSearchProvider[] = []
    for (const candidate of providerCandidates) {
      if (candidate !== null && !providers.includes(candidate)) {
        providers.push(candidate)
      }
    }
    const plannedQueryCount = alternateQuery === null ? 1 : 2
    const failed = (window: WebSearchWindow) => ({
      used: true as const,
      status: 'FAILED' as const,
      results: [] as const,
      maxContextChars: this.webSearchMaxContextChars,
      mode,
      window,
    })

    if (providers.length === 0) {
      this.logWebSearchMultiQuery({
        plannedQueryCount,
        executedQueryCount: 0,
        skippedQueryCount: plannedQueryCount,
        primaryResultCount: 0,
        alternateResultCount: 0,
        mergedResultCount: 0,
        dedupedResultCount: 0,
        result: 'SKIPPED',
      }, msgIdToken)
      this.logWebSearchExecution(mode, primaryWindow, 1, 'FAILED', 0, msgIdToken)
      this.logWebSearch('FAIL', 0, 'DISABLED', msgIdToken)
      this.logWebSearchContext(0, 0, false, msgIdToken)
      return failed(primaryWindow)
    }

    // Preserve the existing primary-search behavior. Only the optional
    // alternate query gets a hard search-stage ceiling that leaves the final
    // answer reserve untouched.
    const alternateSearchStageDeadlineAt = deadline.deadlineAt - MIN_FINAL_ANSWER_BUDGET_MS
    const primary = await this.executeWebSearchQuery(
      decision.query,
      'PRIMARY',
      mode,
      primaryWindow,
      windows,
      providers,
      runtimeTime,
      deadline,
      deadline.deadlineAt,
      msgIdToken,
    )

    let alternate: {
      status: 'PASS' | 'FAILED' | 'SKIPPED'
      results: WebSearchResult[]
      window: WebSearchWindow
    } = {
      status: 'SKIPPED',
      results: [],
      window: primary.window,
    }
    let skippedQueryCount = 0
    if (alternateQuery !== null) {
      const availableAlternateBudgetMs = Math.max(0, deadline.remainingMs() - MIN_FINAL_ANSWER_BUDGET_MS)
      if (availableAlternateBudgetMs >= MIN_ALT_QUERY_SEARCH_BUDGET_MS) {
        alternate = await this.executeWebSearchQuery(
          alternateQuery,
          'ALTERNATE',
          mode,
          primaryWindow,
          windows,
          providers,
          runtimeTime,
          deadline,
          alternateSearchStageDeadlineAt,
          msgIdToken,
        )
      } else {
        skippedQueryCount = 1
        emitDiagnostic(
          (line: string) => console.log(line),
          this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-web-search') : undefined,
          'OPTIONAL_STAGE_BUDGET',
          {
            stage: 'ALTERNATE_QUERY_SEARCH',
            remainingMs: Math.max(0, deadline.remainingMs()),
            reservedFinalAnswerMs: MIN_FINAL_ANSWER_BUDGET_MS,
            availableAlternateBudgetMs,
            minimumAlternateBudgetMs: MIN_ALT_QUERY_SEARCH_BUDGET_MS,
            result: 'SKIP',
            msgIdToken,
          },
        )
      }
    }

    const merged = [...primary.results, ...alternate.results]
    if (merged.length === 0) {
      this.logWebSearchMultiQuery({
        plannedQueryCount,
        executedQueryCount: plannedQueryCount - skippedQueryCount,
        skippedQueryCount,
        primaryResultCount: primary.results.length,
        alternateResultCount: alternate.results.length,
        mergedResultCount: 0,
        dedupedResultCount: 0,
        result: skippedQueryCount > 0 ? 'SKIPPED' : 'PARTIAL',
      }, msgIdToken)
      return failed(alternate.window ?? primary.window)
    }

    // Each provider response is normalized before this merge. Normalize once
    // more at the boundary so cross-query URL canonicalization is guaranteed;
    // P2.4 then performs title deduplication, reranking, and source-id repair.
    const normalizedMerged = normalizeWebSearchResults(merged)
    const ranked = rankWebSearchResults(normalizedMerged, {
      query: decision.query,
      alternateQuery,
      mode,
      window: primary.window,
      runtimeLocalDate: runtimeTime.localDate,
      runtimeUtcIso: runtimeTime.utcIso,
      runtimeTimeZone: runtimeTime.timeZone,
    })
    const multiQueryResult = skippedQueryCount > 0 ? 'PARTIAL' : 'PASS'
    this.logWebSearchMultiQuery({
      plannedQueryCount,
      executedQueryCount: plannedQueryCount - skippedQueryCount,
      skippedQueryCount,
      primaryResultCount: primary.results.length,
      alternateResultCount: alternate.results.length,
      mergedResultCount: merged.length,
      dedupedResultCount: ranked.report.dedupedCount,
      result: multiQueryResult,
    }, msgIdToken)
    const enriched = await this.enrichPageEvidence(ranked.results, deadline, msgIdToken)
    const bounded = buildWebSearchContext(enriched, this.webSearchMaxContextChars)
    this.logWebSearchQuality({
      ...ranked.report,
      selectedCount: bounded.results.length,
    }, msgIdToken)
    this.logWebSearch('PASS', bounded.results.length, 'NONE', msgIdToken)
    this.logWebSearchContext(bounded.results.length, bounded.chars, bounded.truncated, msgIdToken)
    if (bounded.results.length === 0) {
      return failed(primary.window)
    }
    return {
      used: true,
      status: 'PASS',
      results: bounded.results,
      maxContextChars: this.webSearchMaxContextChars,
      mode,
      window: primary.window,
    }
  }

  private async executeWebSearchQuery(
    query: string,
    queryOrigin: WebSearchQueryOrigin,
    mode: WebSearchMode,
    primaryWindow: WebSearchWindow,
    windows: readonly WebSearchWindow[],
    providers: readonly WebSearchProvider[],
    runtimeTime: RuntimeTimeFacts,
    deadline: RequestDeadline,
    searchStageDeadlineAt: number,
    msgIdToken: string,
  ): Promise<{ status: 'PASS' | 'FAILED'; results: WebSearchResult[]; window: WebSearchWindow }> {
    let attempt = 0
    let fallbackTimeoutMs: number | null = null
    let lastWindow = primaryWindow
    for (const [providerIndex, provider] of providers.entries()) {
      const providerWindows = mode === 'NEWS_RECENT' && provider === this.tavilyWebSearchProvider
        ? windows
        : [primaryWindow] as const
      for (const [windowIndex, window] of providerWindows.entries()) {
        lastWindow = window
        attempt += 1
        const availableSearchBudgetMs = Math.max(0, searchStageDeadlineAt - Date.now())
        if (availableSearchBudgetMs < 1) {
          return { status: 'FAILED', results: [], window }
        }
        try {
          const days = window === 'DAY_1' ? 1 : window === 'DAY_3' ? 3 : undefined
          deadline.mark('WEB_SEARCH')
          deadline.throwIfExpired()
          const response = await withSearchStageBudget(deadline, availableSearchBudgetMs, (signal) => provider.search({
            query,
            maxResults: this.webSearchMaxResults,
            timeoutMs: providerIndex > 0
              ? Math.min(Math.max(1, fallbackTimeoutMs ?? 0), availableSearchBudgetMs)
              : Math.min(this.webSearchTimeoutMs, availableSearchBudgetMs),
            mode,
            signal,
            ...(days === undefined ? {} : {
              days: days as 1 | 3,
              startDate: dateDaysBefore(runtimeTime.localDate, days - 1),
              endDate: runtimeTime.localDate,
            }),
          }))
          const normalized = normalizeWebSearchResults(response.results).map((item) => ({
            ...item,
            queryOrigin,
          }))
          if (normalized.length === 0) {
            this.logWebSearchExecution(mode, window, attempt, 'NO_RESULTS', 0, msgIdToken)
            this.logWebSearch('FAIL', 0, 'NO_RESULTS', msgIdToken)
            this.logWebSearchContext(0, 0, false, msgIdToken)
            if (windowIndex + 1 < providerWindows.length) {
              continue
            }
            if (providerIndex + 1 < providers.length) {
              fallbackTimeoutMs = this.allowSearchProviderFallback(deadline, msgIdToken)
              if (fallbackTimeoutMs === null) {
                return { status: 'FAILED', results: [], window }
              }
              break
            }
            return { status: 'FAILED', results: [], window }
          }

          this.logWebSearchExecution(mode, window, attempt, 'PASS', normalized.length, msgIdToken)
          return { status: 'PASS', results: normalized, window }
        } catch (error) {
          if (isRequestDeadlineExceeded(error)) throw error
          const reason: WebSearchFailureReason = error instanceof WebSearchError
            ? error.reason
            : 'HTTP_ERROR'
          this.logWebSearchExecution(mode, window, attempt, 'FAILED', 0, msgIdToken)
          this.logWebSearch('FAIL', 0, reason, msgIdToken)
          this.logWebSearchContext(0, 0, false, msgIdToken)
          if (providerIndex + 1 < providers.length) {
            fallbackTimeoutMs = this.allowSearchProviderFallback(deadline, msgIdToken)
            if (fallbackTimeoutMs === null) {
              return { status: 'FAILED', results: [], window }
            }
            break
          }
          return { status: 'FAILED', results: [], window }
        }
      }
    }
    return { status: 'FAILED', results: [], window: lastWindow }
  }

  private allowSearchProviderFallback(deadline: RequestDeadline, msgIdToken: string): number | null {
    const budget = calculateSearchProviderFallbackBudget(deadline.remainingMs(), this.webSearchTimeoutMs)
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-web-search') : undefined,
      'OPTIONAL_STAGE_BUDGET',
      {
        stage: 'SEARCH_PROVIDER_FALLBACK',
        remainingMs: budget.remainingMs,
        reservedFinalAnswerMs: budget.reservedFinalAnswerMs,
        availableFallbackBudgetMs: budget.availableFallbackBudgetMs,
        minimumFallbackBudgetMs: budget.minimumFallbackBudgetMs,
        effectiveFallbackTimeoutMs: budget.effectiveFallbackTimeoutMs,
        result: budget.result,
        msgIdToken,
      },
    )
    return budget.result === 'RUN' ? budget.effectiveFallbackTimeoutMs : null
  }

  private async enrichPageEvidence(
    results: readonly WebSearchResult[],
    deadline: RequestDeadline,
    msgIdToken: string,
  ): Promise<readonly WebSearchResult[]> {
    const skip = (budgetMs: number): readonly WebSearchResult[] => {
      this.logWebPageFetch({
        attemptedCount: 0,
        successCount: 0,
        failedCount: 0,
        skippedCount: results.length,
        totalEvidenceChars: 0,
        budgetMs,
        result: 'SKIPPED',
      }, msgIdToken)
      return results
    }
    if (!this.webPageFetchEnabled || this.webPageFetchMaxResults === 0) {
      return skip(0)
    }

    const availablePageFetchBudgetMs = Math.max(0, deadline.remainingMs() - MIN_FINAL_ANSWER_BUDGET_MS)
    if (availablePageFetchBudgetMs < MIN_PAGE_FETCH_BUDGET_MS) {
      return skip(availablePageFetchBudgetMs)
    }

    const effectivePageFetchBudgetMs = Math.min(this.webPageFetchTimeoutMs, availablePageFetchBudgetMs)
    deadline.mark('WEB_PAGE_FETCH')
    try {
      const enriched = await withRequestDeadline(deadline, (signal) => enrichWebSearchResultsWithPageEvidence(results, {
        maxResults: this.webPageFetchMaxResults,
        timeoutMs: Math.min(this.webPageFetchTimeoutMs, effectivePageFetchBudgetMs),
        maxCharsPerPage: this.webPageFetchMaxCharsPerPage,
        maxTotalChars: this.webPageFetchMaxTotalChars,
        budgetMs: effectivePageFetchBudgetMs,
        signal,
        fetchImpl: this.webPageFetchImplementation,
        lookup: this.webPageDnsLookup,
      }))
      this.logWebPageFetch(enriched.report, msgIdToken)
      return enriched.results
    } catch {
      // Page fetch is enrichment only. Preserve ranked snippets and leave the
      // existing Search PASS/Grounding path intact if the optional stage fails.
      this.logWebPageFetch({
        attemptedCount: 0,
        successCount: 0,
        failedCount: 0,
        skippedCount: results.length,
        totalEvidenceChars: 0,
        budgetMs: effectivePageFetchBudgetMs,
        result: 'SKIPPED',
      }, msgIdToken)
      return results
    }
  }

  private logWebSearchExecution(
    mode: WebSearchMode,
    window: WebSearchWindow,
    attempt: number,
    result: 'PASS' | 'NO_RESULTS' | 'FAILED',
    resultCount: number,
    msgIdToken: string,
  ): void {
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-web-search') : undefined,
      'WEB_SEARCH_EXECUTION',
      { mode, window, attempt, result, resultCount, msgIdToken },
    )
  }

  private logWebPageFetch(
    report: {
      attemptedCount: number
      successCount: number
      failedCount: number
      skippedCount: number
      totalEvidenceChars: number
      budgetMs: number
      result: 'PASS' | 'PARTIAL' | 'SKIPPED'
    },
    msgIdToken: string,
  ): void {
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-web-search') : undefined,
      'WEB_PAGE_FETCH',
      { ...report, msgIdToken },
    )
  }

  private logWebSearch(
    result: 'PASS' | 'FAIL',
    resultCount: number,
    reason: WebSearchFailureReason | 'NONE',
    msgIdToken: string,
  ): void {
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-web-search') : undefined,
      'WEB_SEARCH',
      { result, resultCount, reason, msgIdToken },
    )
  }

  private logWebSearchContext(resultCount: number, chars: number, truncated: boolean, msgIdToken: string): void {
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-web-search') : undefined,
      'WEB_SEARCH_CONTEXT',
      { resultCount, chars, truncated, msgIdToken },
    )
  }

  private logWebSearchQuality(
    report: ReturnType<typeof rankWebSearchResults>['report'],
    msgIdToken: string,
  ): void {
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-web-search') : undefined,
      'WEB_SEARCH_RESULT_QUALITY',
      { ...report, result: 'PASS', msgIdToken },
    )
  }

  private logWebSearchMultiQuery(
    report: {
      plannedQueryCount: number
      executedQueryCount: number
      skippedQueryCount: number
      primaryResultCount: number
      alternateResultCount: number
      mergedResultCount: number
      dedupedResultCount: number
      result: 'PASS' | 'PARTIAL' | 'SKIPPED'
    },
    msgIdToken: string,
  ): void {
    emitDiagnostic(
      (line: string) => console.log(line),
      this.persistentLog ? new PersistentRuntimeLogSink(this.persistentLog, 'agent-web-search') : undefined,
      'WEB_SEARCH_MULTI_QUERY',
      { ...report, msgIdToken },
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
  const chatSink = options.persistentLog
    ? new PersistentRuntimeLogSink(options.persistentLog, 'agent-chat')
    : undefined
  const chatService = new ChatService(config.openAiApiBase, config.openAiApiKey, config.openAiModel, chatSink)
  const webSearchPlanner = config.webSearchEnabled
    ? new WebSearchPlanner((system, user, deadline, msgIdToken, phase) => chatService.completeStructured(system, user, deadline, msgIdToken, phase))
    : null
  const webSearchProvider = config.webSearchEnabled
    ? new TavilyWebSearchProvider(config.tavilyApiBase, config.tavilyApiKey)
    : null
  const searxngWebSearchProvider = config.webSearchEnabled && config.searxngEnabled
    ? new SearXNGWebSearchProvider(config.searxngApiBase, config.searxngEngines)
    : null
  return new ProductionChatAgent(chatService, {
    memory: createMemoryService(chatService, options.persistentLog),
    persistentLog: options.persistentLog,
    webSearchPlanner,
    tavilyWebSearchProvider: webSearchProvider,
    searxngWebSearchProvider,
    webSearchMaxResults: config.webSearchMaxResults,
    webSearchTimeoutMs: config.webSearchTimeoutMs,
    webSearchMaxContextChars: config.webSearchMaxContextChars,
    webPageFetchEnabled: config.webPageFetchEnabled,
    webPageFetchMaxResults: config.webPageFetchMaxResults,
    webPageFetchTimeoutMs: config.webPageFetchTimeoutMs,
    webPageFetchMaxCharsPerPage: config.webPageFetchMaxCharsPerPage,
    webPageFetchMaxTotalChars: config.webPageFetchMaxTotalChars,
    requestDeadlineMs: config.agentRequestDeadlineMs,
    runtimeTimeZone: config.agentTimeZone,
    ownerDispatchPlanner: new OwnerDispatchPlanner((system, user, deadline, msgIdToken, phase) => chatService.completeStructured(system, user, deadline, msgIdToken, phase)),
    ownerPrivateDispatchPlanner: new OwnerPrivateDispatchPlanner(
      (system, user, deadline, msgIdToken, phase) => chatService.completeStructured(system, user, deadline, msgIdToken, phase),
    ),
    topicCapsuleCompletion: (system, user, deadline, msgIdToken, phase) =>
      chatService.completeStructured(system, user, deadline, msgIdToken, phase),
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
    extractor: new MemoryExtractor((system, user, deadline, msgIdToken, phase) => chatService.completeStructured(system, user, deadline, msgIdToken, phase)),
    mutate: (system, user, deadline, msgIdToken, phase) => chatService.completeStructured(system, user, deadline, msgIdToken, phase),
    backgroundTimeoutMs: config.memoryBackgroundTimeoutMs,
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
