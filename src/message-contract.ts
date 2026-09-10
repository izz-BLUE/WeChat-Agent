export const SUPPORTED_TEXT_MESSAGE_TYPE = 1

import { resolveBotMentionSpans, type BotMentionSpanFacts } from './canonical-user-text.js'

/**
 * Wire kind of the passive ambient event.
 *
 * It is deliberately a second envelope kind rather than a flag on
 * `INBOUND_MESSAGE`: the two events carry different authority, and an additive
 * kind keeps an older Agent that does not know it from misreading group chatter
 * as a request. The active kind stays exactly what it was.
 */
export const PASSIVE_CONTEXT_KIND = 'PASSIVE_CONTEXT_ONLY'

export type ConversationType = 'DIRECT' | 'GROUP'

/** The only roles the trusted runtime can decide. */
export type RequesterRole = 'OWNER' | 'MEMBER'

/** Raw fields emitted by the current WeixinHook message event. */
export interface RawHookMessage {
  msgId: string | number
  type: number
  timestamp: number
  from: string
  wxid: string
  content: string
  signature: string
  senderName?: string | null
  isMentioned?: boolean | null
  /**
   * Runtime identity decision carried on the wire. The C# runtime is the single
   * producer; these fields are the only authoritative source of GROUP identity.
   */
  conversationType?: string | null
  conversationId?: string | null
  senderId?: string | null
  requesterId?: string | null
  requesterSource?: string | null
  /**
   * Owner decision carried on the wire. The role is compared by the runtime
   * against operator configuration; the Agent states the fact and never
   * re-derives it from text, nicknames or model output.
   */
  requesterRole?: string | null
  ownerConfigured?: boolean | null
  /** Display metadata only; it carries no authority. */
  ownerDisplayName?: string | null
  /**
   * Confirmed BOT mention token spans over `content`, in UTF-16 code units, as
   * produced by the runtime's single mention scan. Optional additive field: an
   * older runtime omits it, which the Agent records as an absent claim (chat still
   * works, memory side effects do not). It carries no identity, no name and no
   * text — only offsets.
   */
  botMentionSpans?: ReadonlyArray<{ start?: unknown; length?: unknown }> | null
}

export interface InboundMessage {
  messageId: string
  conversationType: ConversationType
  conversationId: string
  senderId: string
  /** Agent business requester identity. GROUP: canonical runtime signature. */
  requesterId: string
  requesterSource: string
  /** Trusted runtime role fact; the Agent never re-judges it. */
  requesterRole: RequesterRole
  ownerConfigured: boolean
  ownerDisplayName: string | null
  senderName: string | null
  text: string
  /**
   * The wire body exactly as the runtime sent it, before the trim applied to `text`.
   *
   * Bot mention spans are UTF-16 offsets into the RAW body — the runtime scans that
   * string, before any trim, newline normalization or canonicalization — so a
   * consumer that uses them must slice this value. Slicing `text` instead would
   * shift every offset whenever the body carries leading or trailing whitespace
   * (a trailing newline or mention separator is enough), which is why the raw body
   * is carried rather than reconstructed.
   */
  rawText: string
  isMentioned: boolean | null
  timestamp: number
  rawMessageType: number
  /**
   * Whether the runtime's bot mention span claim can be used, and the spans.
   *
   * Resolved once here, from the wire, against the raw body. It is a trust verdict,
   * not a rejection: an invalid or absent claim never drops the message (chat must
   * keep working on an older wire), it only forbids the side effects that depend on
   * knowing which framing belongs to the bot.
   */
  botMentionSpans: BotMentionSpanFacts
}

export type NormalizationResult =
  | { status: 'VALID'; message: InboundMessage }
  | { status: 'INVALID'; reason: string; rawMessageType: number }
  | { status: 'UNSUPPORTED'; reason: string; rawMessageType: number }

/**
 * An ordinary group message admitted only as ambient context.
 *
 * It is the group-scoped subset of `InboundMessage`, and the omissions are the
 * point: there is no requester role, no owner configuration and no owner display
 * metadata, because a passive event decides nothing. Nothing downstream can read
 * an authorization fact off it, so group chatter can never become a request.
 */
export interface PassiveContextMessage {
  messageId: string
  conversationType: 'GROUP'
  conversationId: string
  /** Speaker identity. GROUP: the canonical runtime sender identity (Signature). */
  senderId: string
  requesterId: string
  requesterSource: string
  text: string
  timestamp: number
  rawMessageType: number
}

export type PassiveNormalizationResult =
  | { status: 'VALID'; message: PassiveContextMessage }
  | { status: 'INVALID'; reason: string; rawMessageType: number }
  | { status: 'UNSUPPORTED'; reason: string; rawMessageType: number }

function normalized(value: string | number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value).trim()
}

function resolveConversationType(raw: RawHookMessage, conversationId: string): ConversationType {
  const wireType = normalized(raw.conversationType).toUpperCase()
  if (wireType === 'GROUP' || wireType === 'DIRECT') {
    return wireType
  }

  // Legacy envelopes carry no wire decision; the conversation suffix is the only
  // remaining signal and it classifies the conversation, not the requester.
  return conversationId.endsWith('@chatroom') ? 'GROUP' : 'DIRECT'
}

type IdentityResolution =
  | {
      status: 'VALID'
      senderId: string
      requesterId: string
      requesterSource: string
      requesterRole: RequesterRole
      ownerConfigured: boolean
      ownerDisplayName: string | null
    }
  | { status: 'INVALID'; reason: string }

function wireRequesterRole(value: string | null | undefined): RequesterRole | null {
  const role = normalized(value).toUpperCase()
  return role === 'OWNER' || role === 'MEMBER' ? role : null
}

function resolveIdentity(
  raw: RawHookMessage,
  conversationType: ConversationType,
  conversationId: string,
): IdentityResolution {
  const wireSenderId = normalized(raw.senderId)
  const wireRequesterId = normalized(raw.requesterId)
  const wireSource = normalized(raw.requesterSource)
  const ownerDisplayName = normalized(raw.ownerDisplayName) || null

  if (conversationType === 'GROUP') {
    // GROUP identity is decided once by the runtime. The Agent consumes the wire
    // decision and must never re-derive it from signature/wxid: a missing wire
    // identity is a fail-closed condition, not a reason to guess.
    if (!wireSenderId) {
      return { status: 'INVALID', reason: 'GROUP_SENDER_IDENTITY_MISSING' }
    }
    if (!wireRequesterId) {
      return { status: 'INVALID', reason: 'GROUP_REQUESTER_IDENTITY_MISSING' }
    }
    if (wireSenderId !== wireRequesterId) {
      return { status: 'INVALID', reason: 'GROUP_SENDER_REQUESTER_MISMATCH' }
    }
    if (wireRequesterId === conversationId) {
      return { status: 'INVALID', reason: 'GROUP_REQUESTER_EQUALS_CONVERSATION' }
    }

    // The owner decision is part of the same trusted contract. A missing or
    // unknown role is a producer defect, not an invitation to guess a role.
    const requesterRole = wireRequesterRole(raw.requesterRole)
    if (requesterRole === null) {
      return { status: 'INVALID', reason: 'GROUP_REQUESTER_ROLE_INVALID' }
    }
    if (typeof raw.ownerConfigured !== 'boolean') {
      return { status: 'INVALID', reason: 'GROUP_OWNER_CONFIG_FLAG_INVALID' }
    }
    if (requesterRole === 'OWNER' && raw.ownerConfigured !== true) {
      return { status: 'INVALID', reason: 'GROUP_OWNER_ROLE_WITHOUT_CONFIG' }
    }

    return {
      status: 'VALID',
      senderId: wireSenderId,
      requesterId: wireRequesterId,
      requesterSource: wireSource || 'UNKNOWN',
      requesterRole,
      ownerConfigured: raw.ownerConfigured,
      ownerDisplayName,
    }
  }

  // DIRECT identity semantics are still unverified. The legacy derivation stays
  // here, isolated from the GROUP contract and explicitly labelled as legacy.
  // An unverified identity can never claim the owner role, whatever the wire says.
  const legacySenderId = wireSenderId || normalized(raw.signature) || normalized(raw.wxid)
  if (!legacySenderId) {
    return { status: 'INVALID', reason: 'SENDER_ID_MISSING' }
  }

  return {
    status: 'VALID',
    senderId: legacySenderId,
    requesterId: wireRequesterId || legacySenderId,
    requesterSource: wireSource || 'DIRECT_IDENTITY_UNVERIFIED',
    requesterRole: 'MEMBER',
    ownerConfigured: raw.ownerConfigured === true,
    ownerDisplayName,
  }
}

export function normalizeRawHookMessage(raw: RawHookMessage): NormalizationResult {
  if (raw.type !== SUPPORTED_TEXT_MESSAGE_TYPE) {
    return {
      status: 'UNSUPPORTED',
      reason: 'RAW_MESSAGE_TYPE_NOT_SUPPORTED',
      rawMessageType: raw.type,
    }
  }

  const messageId = normalized(raw.msgId)
  const conversationId = normalized(raw.conversationId) || normalized(raw.from)
  const conversationType = resolveConversationType(raw, conversationId)
  const rawText = raw.content ?? ''
  const text = normalized(rawText)

  if (!messageId) {
    return { status: 'INVALID', reason: 'MESSAGE_ID_MISSING', rawMessageType: raw.type }
  }
  if (!conversationId) {
    return { status: 'INVALID', reason: 'CONVERSATION_ID_MISSING', rawMessageType: raw.type }
  }
  if (!text) {
    return { status: 'INVALID', reason: 'TEXT_EMPTY', rawMessageType: raw.type }
  }
  if (!Number.isFinite(raw.timestamp) || raw.timestamp < 0) {
    return { status: 'INVALID', reason: 'TIMESTAMP_INVALID', rawMessageType: raw.type }
  }

  const identity = resolveIdentity(raw, conversationType, conversationId)
  if (identity.status === 'INVALID') {
    return { status: 'INVALID', reason: identity.reason, rawMessageType: raw.type }
  }

  return {
    status: 'VALID',
    message: {
      messageId,
      conversationType,
      conversationId,
      senderId: identity.senderId,
      requesterId: identity.requesterId,
      requesterSource: identity.requesterSource,
      requesterRole: identity.requesterRole,
      ownerConfigured: identity.ownerConfigured,
      ownerDisplayName: identity.ownerDisplayName,
      senderName: normalized(raw.senderName) || null,
      text,
      rawText,
      isMentioned: raw.isMentioned ?? null,
      timestamp: raw.timestamp,
      rawMessageType: raw.type,
      // Resolved against the RAW body: the spans index that string, so validating
      // them against the trimmed view would invalidate every claim on a body with
      // padding.
      botMentionSpans: resolveBotMentionSpans(rawText, raw.botMentionSpans),
    },
  }
}

/**
 * Normalizes a passive ambient event.
 *
 * The runtime already decided that this message is a supported, non-mentioned
 * group text; the Agent re-checks exactly the invariants it depends on and fails
 * closed on everything else. Three checks are the contract:
 *
 *  - `isMentioned` must be present and false. A passive event that carries a real
 *    mention is a producer defect, and reclassifying it here would let group
 *    chatter take the active path.
 *  - the conversation must be GROUP. Ambient context is group-scoped; a DIRECT or
 *    unclassifiable envelope never enters it.
 *  - GROUP identity keeps the active path's invariant (`senderId === requesterId`,
 *    neither equal to the conversation). Passive does not weaken the identity
 *    contract just because it carries no authority.
 */
export function normalizePassiveContextMessage(raw: RawHookMessage): PassiveNormalizationResult {
  if (raw.type !== SUPPORTED_TEXT_MESSAGE_TYPE) {
    return {
      status: 'UNSUPPORTED',
      reason: 'RAW_MESSAGE_TYPE_NOT_SUPPORTED',
      rawMessageType: raw.type,
    }
  }

  const messageId = normalized(raw.msgId)
  const conversationId = normalized(raw.conversationId) || normalized(raw.from)
  const text = normalized(raw.content)
  const rawMessageType = raw.type

  if (!messageId) {
    return { status: 'INVALID', reason: 'MESSAGE_ID_MISSING', rawMessageType }
  }
  if (!conversationId) {
    return { status: 'INVALID', reason: 'CONVERSATION_ID_MISSING', rawMessageType }
  }
  if (!text) {
    return { status: 'INVALID', reason: 'TEXT_EMPTY', rawMessageType }
  }
  if (!Number.isFinite(raw.timestamp) || raw.timestamp < 0) {
    return { status: 'INVALID', reason: 'TIMESTAMP_INVALID', rawMessageType }
  }
  if (resolveConversationType(raw, conversationId) !== 'GROUP') {
    return { status: 'INVALID', reason: 'PASSIVE_CONTEXT_NON_GROUP', rawMessageType }
  }
  if (raw.isMentioned === true) {
    return { status: 'INVALID', reason: 'PASSIVE_CONTEXT_MENTION_CONFLICT', rawMessageType }
  }
  if (raw.isMentioned !== false) {
    return { status: 'INVALID', reason: 'PASSIVE_CONTEXT_MENTION_FLAG_MISSING', rawMessageType }
  }

  const senderId = normalized(raw.senderId)
  const requesterId = normalized(raw.requesterId)
  if (!senderId) {
    return { status: 'INVALID', reason: 'GROUP_SENDER_IDENTITY_MISSING', rawMessageType }
  }
  if (!requesterId) {
    return { status: 'INVALID', reason: 'GROUP_REQUESTER_IDENTITY_MISSING', rawMessageType }
  }
  if (senderId !== requesterId) {
    return { status: 'INVALID', reason: 'GROUP_SENDER_REQUESTER_MISMATCH', rawMessageType }
  }
  if (requesterId === conversationId) {
    return { status: 'INVALID', reason: 'GROUP_REQUESTER_EQUALS_CONVERSATION', rawMessageType }
  }

  return {
    status: 'VALID',
    message: {
      messageId,
      conversationType: 'GROUP',
      conversationId,
      senderId,
      requesterId,
      requesterSource: normalized(raw.requesterSource) || 'UNKNOWN',
      text,
      timestamp: raw.timestamp,
      rawMessageType,
    },
  }
}
