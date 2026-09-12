import { createHash, randomUUID } from 'node:crypto'

export const OUTBOUND_DELIVERY_ACK_KIND = 'OUTBOUND_DELIVERY_ACK' as const
export const DEFAULT_PENDING_OUTBOUND_MAX = 256
export const DEFAULT_PENDING_OUTBOUND_TTL_MS = 5 * 60 * 1000

export type OutboundDeliveryStatus = 'SENT' | 'FAILED'

export interface OutboundDeliveryAck {
  outboundId: string
  requestMessageId: string
  status: OutboundDeliveryStatus
  contentSha256: string
  errorCode: string
}

export interface OutboundIdentity {
  outboundId: string
  requestMessageId: string
  contentSha256: string
}

export interface PendingOutboundReply extends OutboundIdentity {
  conversationType: 'DIRECT' | 'GROUP'
  conversationId: string
  text: string
  /** The inbound request timestamp; this preserves the existing event semantics. */
  timestamp: number
  /**
   * Trusted requester identity for a normal group reply. Process-local only;
   * ACKs and diagnostics never carry or render this value.
   */
  replyToSpeakerId?: string
}

export type DeliveryAckRejectReason =
  | 'UNKNOWN_OUTBOUND'
  | 'DUPLICATE_ACK'
  | 'REQUEST_ID_MISMATCH'
  | 'CONTENT_HASH_MISMATCH'
  | 'PENDING_EXPIRED'
  | 'INVALID_ACK'

export type DeliveryAckResult =
  | { accepted: true; reason: 'SENT_COMMITTED' | 'FAILED_DISCARDED' }
  | { accepted: false; reason: DeliveryAckRejectReason }

export interface PendingOutboundReplyStoreOptions {
  maxEntries?: number
  ttlMs?: number
  now?: () => number
  idFactory?: () => string
}

interface PendingState extends PendingOutboundReply {
  stagedAt: number
}

export type PendingOutboundReplyInput = Pick<
  PendingOutboundReply,
  'conversationType' | 'conversationId' | 'requestMessageId' | 'text' | 'timestamp' | 'replyToSpeakerId'
>

/** SHA-256 of the exact UTF-8 text crossing the Agent outbound boundary. */
export function sha256Utf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export class PendingOutboundReplyStore {
  private readonly pending = new Map<string, PendingState>()
  private readonly finalized = new Map<string, OutboundDeliveryStatus>()
  private readonly expired = new Set<string>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly clock: () => number
  private readonly idFactory: () => string

  public constructor(options: PendingOutboundReplyStoreOptions = {}) {
    this.maxEntries = positiveBound(options.maxEntries ?? DEFAULT_PENDING_OUTBOUND_MAX, 'maxEntries')
    this.ttlMs = positiveBound(options.ttlMs ?? DEFAULT_PENDING_OUTBOUND_TTL_MS, 'ttlMs')
    this.clock = options.now ?? (() => Date.now())
    this.idFactory = options.idFactory ?? randomUUID
  }

  public stage(input: PendingOutboundReplyInput): OutboundIdentity {
    if (!isConversationType(input.conversationType) || !input.conversationId.trim() ||
        !input.requestMessageId.trim() || !input.text.trim() || !Number.isFinite(input.timestamp) ||
        (input.replyToSpeakerId !== undefined && (
          typeof input.replyToSpeakerId !== 'string' || !input.replyToSpeakerId.trim()
        ))) {
      throw new Error('pending outbound fields are invalid')
    }

    this.prune()
    while (this.pending.size >= this.maxEntries) {
      const oldest = this.pending.keys().next().value
      if (typeof oldest !== 'string') break
      this.pending.delete(oldest)
    }

    let outboundId = this.idFactory().trim()
    while (this.pending.has(outboundId) || this.finalized.has(outboundId) || this.expired.has(outboundId)) {
      outboundId = this.idFactory().trim()
    }
    const identity: OutboundIdentity = {
      outboundId,
      requestMessageId: input.requestMessageId,
      contentSha256: sha256Utf8(input.text),
    }
    this.pending.set(outboundId, {
      ...input,
      ...identity,
      stagedAt: this.clock(),
    })
    return identity
  }

  public getIdentityFor(requestMessageId: string, text: string): OutboundIdentity | null {
    this.prune()
    for (const pending of this.pending.values()) {
      if (pending.requestMessageId === requestMessageId && pending.text === text) {
        return {
          outboundId: pending.outboundId,
          requestMessageId: pending.requestMessageId,
          contentSha256: pending.contentSha256,
        }
      }
    }
    return null
  }

  public settle(ack: OutboundDeliveryAck, onSent?: (pending: PendingOutboundReply) => void): DeliveryAckResult {
    if (!isValidAck(ack)) {
      return { accepted: false, reason: 'INVALID_ACK' }
    }
    this.prune()
    if (this.finalized.has(ack.outboundId)) {
      return { accepted: false, reason: 'DUPLICATE_ACK' }
    }
    if (this.expired.has(ack.outboundId)) {
      return { accepted: false, reason: 'PENDING_EXPIRED' }
    }
    const pending = this.pending.get(ack.outboundId)
    if (!pending) {
      return { accepted: false, reason: 'UNKNOWN_OUTBOUND' }
    }
    if (pending.requestMessageId !== ack.requestMessageId) {
      return { accepted: false, reason: 'REQUEST_ID_MISMATCH' }
    }
    if (ack.status === 'SENT' && pending.contentSha256 !== ack.contentSha256) {
      return { accepted: false, reason: 'CONTENT_HASH_MISMATCH' }
    }

    this.pending.delete(ack.outboundId)
    this.finalized.set(ack.outboundId, ack.status)
    this.trimHistory(this.finalized)
    if (ack.status === 'SENT') {
      onSent?.(pending)
      return { accepted: true, reason: 'SENT_COMMITTED' }
    }
    return { accepted: true, reason: 'FAILED_DISCARDED' }
  }

  private prune(): void {
    const now = this.clock()
    for (const [outboundId, pending] of this.pending) {
      if (now - pending.stagedAt >= this.ttlMs) {
        this.pending.delete(outboundId)
        this.expired.add(outboundId)
      }
    }
    while (this.expired.size > this.maxEntries) {
      const oldest = this.expired.values().next().value
      if (typeof oldest !== 'string') break
      this.expired.delete(oldest)
    }
  }

  private trimHistory(history: Map<string, unknown>): void {
    while (history.size > this.maxEntries) {
      const oldest = history.keys().next().value
      if (typeof oldest !== 'string') break
      history.delete(oldest)
    }
  }
}

function isConversationType(value: string): value is 'DIRECT' | 'GROUP' {
  return value === 'DIRECT' || value === 'GROUP'
}

function isValidAck(value: OutboundDeliveryAck): boolean {
  return typeof value === 'object' && value !== null &&
    typeof value.outboundId === 'string' && value.outboundId.trim().length > 0 &&
    typeof value.requestMessageId === 'string' && value.requestMessageId.trim().length > 0 &&
    (value.status === 'SENT' || value.status === 'FAILED') &&
    typeof value.contentSha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.contentSha256) &&
    typeof value.errorCode === 'string' && value.errorCode.length <= 128
}

function positiveBound(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}
