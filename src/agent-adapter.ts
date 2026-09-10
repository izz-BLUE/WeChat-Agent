import { sanitizeFinalAnswer } from './final-answer.js'
import {
  normalizeRawHookMessage,
  type ConversationType,
  type InboundMessage,
  type NormalizationResult,
  type RawHookMessage,
  type RequesterRole,
} from './message-contract.js'

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
  /** Display metadata only; never an authorization input. */
  ownerDisplayName: string | null
  senderName: string | null
  text: string
  timestamp: number
  mentionState: MentionState
  metadata: {
    rawMessageType: number
  }
}

export interface OutboundCommand {
  conversationType: ConversationType
  conversationId: string
  text: string
}

export type MentionPolicyResult =
  | { status: 'PROCESS' }
  | { status: 'IGNORED'; reason: 'GROUP_MENTION_REQUIRED' | 'DIRECT_IDENTITY_UNVERIFIED' }

export type AgentResult =
  | { kind: 'SUCCESS_TEXT'; text: string }
  | { kind: 'NO_REPLY' }
  | { kind: 'ERROR' }

export interface AgentExecutor {
  complete(request: AgentRequest): Promise<string | null | undefined>
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
      policy: Extract<MentionPolicyResult, { status: 'PROCESS' }>
      request: AgentRequest
      agentResult: AgentResult
      outboundCommand: OutboundCommand | null
    }

export function conversationKey(message: Pick<InboundMessage, 'conversationType' | 'conversationId'>): string {
  return `${message.conversationType.toLowerCase()}:${message.conversationId}`
}

/**
 * The single admission decision. GROUP + a runtime-confirmed mention is the only
 * form the product has verified: everything else fails closed.
 *
 * DIRECT is refused outright. Its conversation, requester and self contracts are
 * unverified — a DIRECT envelope cannot be told apart from a publish-account
 * push, a system notification or an echo of our own message, and its conversation
 * identity may not resolve back to the originating conversation. Until that
 * contract passes a real field acceptance, a DIRECT inbound must not invoke the
 * Agent or produce a reply, so no service message can reach the provider.
 */
export function applyMentionPolicy(message: InboundMessage): MentionPolicyResult {
  if (message.conversationType === 'DIRECT') {
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
    senderName: message.senderName,
    text: message.text,
    timestamp: message.timestamp,
    mentionState: toMentionState(message),
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
export function toOutboundCommand(message: InboundMessage, result: AgentResult): OutboundCommand | null {
  if (result.kind !== 'SUCCESS_TEXT') {
    return null
  }

  const sanitized = sanitizeFinalAnswer(result.text)
  if (sanitized.unterminatedTag || !sanitized.text) {
    return null
  }

  return {
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
    outboundCommand: toOutboundCommand(normalization.message, agentResult),
  }
}
