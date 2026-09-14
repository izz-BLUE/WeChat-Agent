/**
 * Short-lived requester-local group context.
 *
 * This is deliberately a process-local conversation view, not persistent
 * Memory. Its storage scope is the pair (groupConversationId, requesterId),
 * so the same requester can have independent continuity in two groups.
 */
import { formatDiagnosticLine, type PersistentRuntimeLogSink } from './persistent-runtime-log.js'
import type { GroupMessage } from './context.js'
import { sanitizePublicDisplayName } from './public-display-name.js'

export const REQUESTER_LOCAL_SCOPE = 'REQUESTER_LOCAL'

export interface RequesterLocalSelection {
  /** Provider-safe only after the assembler removes senderId. */
  messages: readonly GroupMessage[]
  availableCount: number
  selectedCount: number
  expiredDropped: number
  currentEventDropped: number
  crossRequesterLocalDropped: number
  crossGroupDropped: number
}

export interface RequesterLocalAppendOutcome {
  result: 'PASS' | 'DUPLICATE' | 'REJECTED'
  messageCount: number
  expiredDropped: number
}

export interface RequesterLocalContextOptions {
  maxEntries?: number
  ttlMs?: number
  maxChars?: number
  sink?: PersistentRuntimeLogSink
  now?: () => number
}

export const DEFAULT_REQUESTER_LOCAL_MAX_ENTRIES = 50
export const DEFAULT_REQUESTER_LOCAL_TTL_MS = 30 * 60 * 1000
export const DEFAULT_REQUESTER_LOCAL_MAX_CHARS = 8_000

interface LocalEntry {
  groupConversationId: string
  requesterId: string
  message: GroupMessage
  /** Process-local arrival time; wire timestamps are event data, not a TTL clock. */
  storedAt: number
}

/** Bounded, non-persistent requester-local context keyed by group and requester. */
export class RequesterLocalContext {
  private readonly entriesByScope = new Map<string, LocalEntry[]>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly maxChars: number
  private readonly sink?: PersistentRuntimeLogSink
  private readonly clock: () => number

  public constructor(options: RequesterLocalContextOptions = {}) {
    this.maxEntries = positiveBound(
      options.maxEntries ?? DEFAULT_REQUESTER_LOCAL_MAX_ENTRIES,
      'maxEntries',
    )
    this.ttlMs = positiveBound(options.ttlMs ?? DEFAULT_REQUESTER_LOCAL_TTL_MS, 'ttlMs')
    this.maxChars = positiveBound(
      options.maxChars ?? DEFAULT_REQUESTER_LOCAL_MAX_CHARS,
      'maxChars',
    )
    this.sink = options.sink
    this.clock = options.now ?? (() => Date.now())
  }

  public append(
    groupConversationId: string,
    requesterId: string,
    message: GroupMessage,
  ): RequesterLocalAppendOutcome {
    if (!isUsableScope(groupConversationId, requesterId) || !isUsableMessage(message)) {
      const outcome: RequesterLocalAppendOutcome = {
        result: 'REJECTED',
        messageCount: this.entriesByScope.get(scopeKey(groupConversationId, requesterId))?.length ?? 0,
        expiredDropped: 0,
      }
      this.diagnoseAppend(outcome, message.senderName)
      return outcome
    }

    const expiredDropped = this.pruneScope(groupConversationId, requesterId, this.clock())
    const key = scopeKey(groupConversationId, requesterId)
    const entries = this.entriesByScope.get(key) ?? []
    if (entries.some((entry) => entry.message.messageId === message.messageId)) {
      const outcome: RequesterLocalAppendOutcome = {
        result: 'DUPLICATE',
        messageCount: entries.length,
        expiredDropped,
      }
      this.diagnoseAppend(outcome, message.senderName)
      return outcome
    }

    const storedAt = this.clock()
    entries.push({
      groupConversationId,
      requesterId,
      message: {
        ...message,
        publicDisplayName: sanitizePublicDisplayName(message.publicDisplayName),
      },
      storedAt,
    })
    if (entries.length > this.maxEntries) {
      entries.splice(0, entries.length - this.maxEntries)
    }
    this.entriesByScope.set(key, entries)

    const outcome: RequesterLocalAppendOutcome = {
      result: 'PASS',
      messageCount: entries.length,
      expiredDropped,
    }
    this.diagnoseAppend(outcome, message.senderName)
    return outcome
  }

  public select(
    groupConversationId: string,
    requesterId: string,
    options: {
      excludeMessageId?: string
      maxEntries?: number
      maxChars?: number
      now?: number
    } = {},
  ): RequesterLocalSelection {
    const now = options.now ?? this.clock()
    const expiredDropped = this.pruneAll(now)
    const key = scopeKey(groupConversationId, requesterId)
    const entries = this.entriesByScope.get(key) ?? []
    const withoutCurrent = entries.filter((entry) => entry.message.messageId !== options.excludeMessageId)
    const currentEventDropped = entries.length - withoutCurrent.length
    const limit = Math.max(0, Math.min(options.maxEntries ?? this.maxEntries, this.maxEntries))
    const maxChars = Math.max(0, Math.min(options.maxChars ?? this.maxChars, this.maxChars))
    const selected: LocalEntry[] = []
    let chars = 0

    for (let index = withoutCurrent.length - 1; index >= 0 && selected.length < limit; index -= 1) {
      const entry = withoutCurrent[index] as LocalEntry
      const message = entry.message
      const lineChars = message.senderName.length + message.text.length + 3
      if (selected.length > 0 && chars + lineChars > maxChars) {
        break
      }
      selected.unshift(entry)
      chars += lineChars
    }

    const crossRequesterLocalDropped = this.countOtherScopes(groupConversationId, requesterId, true)
    const crossGroupDropped = this.countOtherScopes(groupConversationId, requesterId, false)
    const result: RequesterLocalSelection = {
      messages: selected.map((entry) => ({ ...entry.message })),
      availableCount: withoutCurrent.length,
      selectedCount: selected.length,
      expiredDropped,
      currentEventDropped,
      crossRequesterLocalDropped,
      crossGroupDropped,
    }
    this.diagnoseRead(result)
    return result
  }

  public count(groupConversationId: string, requesterId: string): number {
    this.pruneScope(groupConversationId, requesterId, this.clock())
    return this.entriesByScope.get(scopeKey(groupConversationId, requesterId))?.length ?? 0
  }

  /** Internal/test view; callers must not pass these entries to a provider. */
  public entries(groupConversationId: string, requesterId: string): readonly GroupMessage[] {
    this.pruneScope(groupConversationId, requesterId, this.clock())
    return (this.entriesByScope.get(scopeKey(groupConversationId, requesterId)) ?? [])
      .map((entry) => ({ ...entry.message }))
  }

  private pruneScope(groupConversationId: string, requesterId: string, now: number): number {
    const key = scopeKey(groupConversationId, requesterId)
    const entries = this.entriesByScope.get(key)
    if (!entries || entries.length === 0) return 0
    const kept = entries.filter((entry) => now - entry.storedAt <= this.ttlMs)
    const dropped = entries.length - kept.length
    if (dropped > 0) {
      if (kept.length === 0) this.entriesByScope.delete(key)
      else this.entriesByScope.set(key, kept)
    }
    return dropped
  }

  private pruneAll(now: number): number {
    let dropped = 0
    for (const [key, entry] of this.entriesByScope) {
      const kept = entry.filter((item) => now - item.storedAt <= this.ttlMs)
      dropped += entry.length - kept.length
      if (kept.length === 0) this.entriesByScope.delete(key)
      else if (kept.length !== entry.length) this.entriesByScope.set(key, kept)
    }
    return dropped
  }

  private countOtherScopes(groupConversationId: string, requesterId: string, sameGroup: boolean): number {
    let count = 0
    for (const entries of this.entriesByScope.values()) {
      for (const entry of entries) {
        const isSameGroup = entry.groupConversationId === groupConversationId
        const isSameRequester = entry.requesterId === requesterId
        if (sameGroup ? isSameGroup && !isSameRequester : !isSameGroup) count += 1
      }
    }
    return count
  }

  private diagnoseAppend(outcome: RequesterLocalAppendOutcome, speakerType: string): void {
    emitDiagnostic(this.sink, 'CONTEXT_APPEND', {
      scope: REQUESTER_LOCAL_SCOPE,
      speakerType: speakerType === 'ASSISTANT' ? 'ASSISTANT' : 'REQUESTER',
      messageCount: outcome.messageCount,
      expiredDropped: outcome.expiredDropped,
      result: outcome.result,
    })
  }

  private diagnoseRead(selection: RequesterLocalSelection): void {
    emitDiagnostic(this.sink, 'CONTEXT_READ', {
      scope: REQUESTER_LOCAL_SCOPE,
      availableCount: selection.availableCount,
      selectedCount: selection.selectedCount,
      expiredDropped: selection.expiredDropped,
      crossRequesterLocalDropped: selection.crossRequesterLocalDropped,
      crossGroupDropped: selection.crossGroupDropped,
      result: 'PASS',
    })
  }
}

function scopeKey(groupConversationId: string, requesterId: string): string {
  return `${groupConversationId.length}:${groupConversationId}${requesterId.length}:${requesterId}`
}

function isUsableScope(groupConversationId: string, requesterId: string): boolean {
  return groupConversationId.trim().length > 0 && requesterId.trim().length > 0
}

function isUsableMessage(message: GroupMessage): boolean {
  return typeof message.messageId === 'string' && message.messageId.trim().length > 0 &&
    typeof message.senderName === 'string' && message.senderName.trim().length > 0 &&
    typeof message.text === 'string' && message.text.trim().length > 0 &&
    Number.isFinite(message.timestamp) && message.timestamp > 0
}

function positiveBound(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function emitDiagnostic(
  sink: PersistentRuntimeLogSink | undefined,
  event: string,
  fields: Record<string, string | number>,
): void {
  // GROUP_CONTEXT_ASSEMBLY is the stdout summary for the request. The local
  // store keeps per-operation diagnostics for a durable sink without adding
  // synchronous console I/O to the latency-critical path when no sink exists.
  if (sink === undefined) return
  console.log(formatDiagnosticLine(event, fields))
  try { sink.writeStructured(event, fields) } catch {
    /* Diagnostics must never break a chat turn. */
  }
}
