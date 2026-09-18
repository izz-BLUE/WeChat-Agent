import { sanitizeFinalAnswer } from './final-answer.js'
import { randomUUID } from 'node:crypto'
import type { BotMentionSpanFacts, UserContentSpanFacts } from './canonical-user-text.js'
import {
  normalizePassiveContextMessage,
  normalizeRawHookMessage,
  isVerifiedOwnerDirect,
  type ConversationType,
  type InboundMessage,
  type NormalizationResult,
  type PassiveContextMessage,
  type PassiveNormalizationResult,
  type RawHookMessage,
  type RequesterRole,
} from './message-contract.js'
import { sha256Utf8, type OutboundDeliveryAck, type OutboundIdentity, type DeliveryAckResult } from './outbound-delivery.js'
import type { OwnerAliasClass } from './owner-alias-wake.js'

/** Runtime-decided mention fact; the Agent must never re-derive it from text. */
export type MentionState = 'MENTIONED' | 'NOT_MENTIONED' | 'UNKNOWN'

export interface AgentRequest {
  conversationKey: string
  messageId: string
  conversationType: ConversationType
  conversationId: string
  senderId: string
  /** Runtime-decided requester identity; consumed as-is, never re-derived here. */
  requesterId: string
  requesterSource: string
  /** Runtime-decided role fact; consumed as-is, never re-derived here. */
  requesterRole: RequesterRole
    ownerConfigured: boolean
    /** Runtime-supplied Owner display label; never a requester-authorization input. */
    ownerDisplayName: string | null
    /** Runtime-supplied Creator display label; absent on older runtimes. */
    assistantCreatorDisplayName?: string | null
    /** Local public display metadata; never identity, role or memory input. */
    publicDisplayName?: string | null
    /** C#-only target; only verified OWNER DIRECT may consume it. */
    privateDispatchTargetConversationId?: string | null
  senderName: string | null
  text: string
  /**
   * The wire body before the trim applied to `text`. Bot mention spans index this
   * value, so canonicalization starts from it rather than from `text`.
   */
  rawText?: string
  timestamp: number
  mentionState: MentionState
  /**
   * The runtime's bot mention span claim for this message, already validated
   * against the raw body. Absent means an older runtime that makes no claim.
   */
  botMentionSpans?: BotMentionSpanFacts
  /** The runtime's resolved trusted GROUP user-content suffix claim. */
  userContentSpan?: UserContentSpanFacts
  metadata: {
    rawMessageType: number
  }
}

export interface OutboundCommand {
  outboundId: string
  requestMessageId: string
  contentSha256: string
  conversationType: ConversationType
  conversationId: string
  text: string
}

export type MentionPolicyResult =
  | { status: 'PROCESS' }
  | { status: 'PROCESS_PRIVATE_OWNER' }
  | { status: 'IGNORED'; reason: 'GROUP_MENTION_REQUIRED' | 'DIRECT_IDENTITY_UNVERIFIED' }

export type AgentResult =
  | { kind: 'SUCCESS_TEXT'; text: string }
  | { kind: 'NO_REPLY' }
  | { kind: 'ERROR' }

/**
 * A group message admitted as ambience only. It carries no authorization fact and
 * no destination: there is nothing here that a reply could be sent to.
 */
export interface AgentPassiveContext {
  conversationKey: string
  messageId: string
  conversationType: 'GROUP'
  conversationId: string
  senderId: string
  requesterId: string
  /** Local public display metadata for presentation only. */
  publicDisplayName?: string | null
  text: string
  timestamp: number
}

/**
 * A passive context that was promoted after capture by the deterministic alias
 * matcher. The only additional fact is the enum-like alias class; no authority
 * fields are introduced by this contract.
 */
export interface OwnerAliasWakeContext extends AgentPassiveContext {
  matchedAliasClass: OwnerAliasClass
}

export interface AgentExecutor {
  complete(request: AgentRequest): Promise<string | null | undefined>

  /** Drain one already-authorized proactive command without entering any chat path. */
  pollProactiveOutbound?(): OutboundCommand | null

  /**
   * Production agents stage a normal generated answer before returning it. The
   * adapter only needs the opaque identity that belongs to the final command.
   * Legacy/fake executors omit this capability and still receive a complete wire
   * command; their ACK is necessarily rejected because no pending entry exists.
   */
  takeOutboundIdentity?(request: AgentRequest, text: string): OutboundIdentity | null

  /** Independent delivery settlement path; it must not invoke the chat pipeline. */
  observeOutboundDelivery?(ack: OutboundDeliveryAck): Promise<DeliveryAckResult> | DeliveryAckResult

  /**
   * Ambience only: a group message that did not address the bot.
   *
   * Optional, and its absence is fail-safe — an executor that does not implement
   * it simply drops the ambience. An implementation of this method may not read
   * or write memory, call a provider, touch requester context or produce a reply;
   * the return value is deliberately `void` so none can be smuggled out.
   */
  observePassiveContext?(context: AgentPassiveContext): Promise<void> | void

  /** Generate one group-level proactive reply after passive capture. */
  handleOwnerAliasWake?(context: OwnerAliasWakeContext): Promise<void> | void
}

export type AgentPipelineResult =
  | {
      status: 'INVALID' | 'UNSUPPORTED'
      normalization: Extract<NormalizationResult, { status: 'INVALID' | 'UNSUPPORTED' }>
    }
  | {
      status: 'IGNORED'
      normalization: Extract<NormalizationResult, { status: 'VALID' }>
      policy: Extract<MentionPolicyResult, { status: 'IGNORED' }>
    }
  | {
      status: 'AGENT_RESULT'
      normalization: Extract<NormalizationResult, { status: 'VALID' }>
      policy: Extract<MentionPolicyResult, { status: 'PROCESS' | 'PROCESS_PRIVATE_OWNER' }>
      request: AgentRequest
      agentResult: AgentResult
      outboundCommand: OutboundCommand | null
    }

export function conversationKey(message: Pick<InboundMessage, 'conversationType' | 'conversationId'>): string {
  return `${message.conversationType.toLowerCase()}:${message.conversationId}`
}

export function toPassiveContext(message: PassiveContextMessage): AgentPassiveContext {
  return {
    conversationKey: `group:${message.conversationId}`,
    messageId: message.messageId,
    conversationType: 'GROUP',
    conversationId: message.conversationId,
    senderId: message.senderId,
    requesterId: message.requesterId,
    publicDisplayName: message.publicDisplayName,
    text: message.text,
    timestamp: message.timestamp,
  }
}

/**
 * The single active admission decision. GROUP + a runtime-confirmed mention and
 * the additive verified owner DIRECT contract are the only admitted forms.
 *
 * Ordinary DIRECT remains refused. Its conversation, requester and self contracts
 * are unverified; only the explicit DIRECT_OWNER_FIELD_VERIFIED wire source can
 * enter the private-owner command channel.
 */
export function applyMentionPolicy(message: InboundMessage): MentionPolicyResult {
  if (message.conversationType === 'DIRECT') {
    if (isVerifiedOwnerDirect(message)) {
      return { status: 'PROCESS_PRIVATE_OWNER' }
    }
    return { status: 'IGNORED', reason: 'DIRECT_IDENTITY_UNVERIFIED' }
  }

  if (message.isMentioned === true) {
    return { status: 'PROCESS' }
  }

  return { status: 'IGNORED', reason: 'GROUP_MENTION_REQUIRED' }
}

export function toMentionState(message: Pick<InboundMessage, 'isMentioned'>): MentionState {
  if (message.isMentioned === true) {
    return 'MENTIONED'
  }
  return message.isMentioned === false ? 'NOT_MENTIONED' : 'UNKNOWN'
}

export function toAgentRequest(message: InboundMessage): AgentRequest {
  return {
    conversationKey: conversationKey(message),
    messageId: message.messageId,
    conversationType: message.conversationType,
    conversationId: message.conversationId,
    senderId: message.senderId,
    requesterId: message.requesterId,
    requesterSource: message.requesterSource,
    requesterRole: message.requesterRole,
    ownerConfigured: message.ownerConfigured,
    ownerDisplayName: message.ownerDisplayName,
    assistantCreatorDisplayName: message.assistantCreatorDisplayName,
    publicDisplayName: message.publicDisplayName,
    privateDispatchTargetConversationId: message.conversationType === 'DIRECT'
      ? message.privateDispatchTargetConversationId
      : null,
    senderName: message.senderName,
    text: message.text,
    rawText: message.rawText,
    timestamp: message.timestamp,
    mentionState: toMentionState(message),
    botMentionSpans: message.botMentionSpans,
    userContentSpan: message.userContentSpan,
    metadata: {
      rawMessageType: message.rawMessageType,
    },
  }
}

/**
 * First defence at the Agent result boundary: a reply may only be the final
 * answer. Provider thinking markup is stripped here so every executor (real or
 * fake) is covered, and text that is nothing but reasoning becomes NO_REPLY.
 */
export function mapAgentResponse(response: string | null | undefined): AgentResult {
  const raw = response?.trim() ?? ''
  if (!raw) {
    return { kind: 'NO_REPLY' }
  }

  const sanitized = sanitizeFinalAnswer(raw)
  if (sanitized.unterminatedTag || !sanitized.text) {
    return { kind: 'NO_REPLY' }
  }

  return { kind: 'SUCCESS_TEXT', text: sanitized.text }
}

export function mapAgentError(): AgentResult {
  return { kind: 'ERROR' }
}

/**
 * Last defence before the outbound command leaves the Agent: the text is
 * re-checked here, so nothing can reach the WeChat send boundary with thinking
 * markup even if an executor bypasses `mapAgentResponse`.
 */
export function toOutboundCommand(
  message: InboundMessage,
  result: AgentResult,
  identity?: OutboundIdentity | null,
): OutboundCommand | null {
  if (isVerifiedOwnerDirect(message)) {
    // Verified DIRECT is an Agent command channel only. Its destination is never
    // an outbound recipient; private dispatch is staged as GROUP proactive work.
    return null
  }
  if (result.kind !== 'SUCCESS_TEXT') {
    return null
  }

  const sanitized = sanitizeFinalAnswer(result.text)
  if (sanitized.unterminatedTag || !sanitized.text) {
    return null
  }

  return {
    outboundId: identity?.outboundId ?? randomUUID(),
    requestMessageId: identity?.requestMessageId ?? message.messageId,
    contentSha256: identity?.contentSha256 ?? sha256Utf8(sanitized.text),
    conversationType: message.conversationType,
    conversationId: message.conversationId,
    text: sanitized.text,
  }
}

export async function runRawAgentPipeline(
  raw: RawHookMessage,
  agent: AgentExecutor,
): Promise<AgentPipelineResult> {
  const normalization = normalizeRawHookMessage(raw)
  if (normalization.status !== 'VALID') {
    return { status: normalization.status, normalization }
  }

  const policy = applyMentionPolicy(normalization.message)
  if (policy.status === 'IGNORED') {
    return { status: 'IGNORED', normalization, policy }
  }

  const request = toAgentRequest(normalization.message)
  let agentResult: AgentResult
  try {
    agentResult = mapAgentResponse(await agent.complete(request))
  } catch {
    agentResult = mapAgentError()
  }

  return {
    status: 'AGENT_RESULT',
    normalization,
    policy,
    request,
    agentResult,
    outboundCommand: toOutboundCommand(
      normalization.message,
      agentResult,
      agentResult.kind === 'SUCCESS_TEXT'
        ? agent.takeOutboundIdentity?.(request, agentResult.text)
        : null,
    ),
  }
}

/**
 * Outcome of one passive ambient event.
 *
 * There is no outbound member in any variant, by construction: this pipeline has
 * no path that can produce one, which is what makes "no mention never replies"
 * a structural property instead of a checked one.
 */
export type PassivePipelineResult =
  | {
      status: 'INVALID' | 'UNSUPPORTED'
      normalization: Extract<PassiveNormalizationResult, { status: 'INVALID' | 'UNSUPPORTED' }>
    }
  | {
      status: 'PASSIVE_CONTEXT' | 'PASSIVE_CONTEXT_UNSUPPORTED' | 'PASSIVE_CONTEXT_ERROR'
      normalization: Extract<PassiveNormalizationResult, { status: 'VALID' }>
      context: AgentPassiveContext
    }

/**
 * Passive pipeline: normalize an ambient group message and hand it to the
 * executor's ambience sink.
 *
 * Deliberately NOT the active pipeline. It never applies the mention policy (the
 * runtime already decided this message is not a mention), never builds an
 * `AgentRequest`, never maps an answer and never builds an outbound command. An
 * executor that throws loses the ambience and nothing else.
 */
export async function runRawPassiveContextPipeline(
  raw: RawHookMessage,
  agent: AgentExecutor,
): Promise<PassivePipelineResult> {
  const normalization = normalizePassiveContextMessage(raw)
  if (normalization.status !== 'VALID') {
    return { status: normalization.status, normalization }
  }

  const context = toPassiveContext(normalization.message)
  if (agent.observePassiveContext === undefined) {
    // A delivered event nobody consumes is reported as such: the transport must
    // not claim the ambience was captured when it was dropped on the floor.
    return { status: 'PASSIVE_CONTEXT_UNSUPPORTED', normalization, context }
  }

  try {
    await agent.observePassiveContext(context)
  } catch {
    // Ambience is best-effort by contract: a failed append is reported, never
    // retried and never allowed to become a reply or an error the user can see.
    return { status: 'PASSIVE_CONTEXT_ERROR', normalization, context }
  }

  return { status: 'PASSIVE_CONTEXT', normalization, context }
}
