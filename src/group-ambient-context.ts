/**
 * GROUP_AMBIENT_CONTEXT: the passive, group-scoped ambient transcript.
 *
 * A group member who does not @ the bot still writes the sentence the next real
 * mention depends on. "你觉得是什么原因？" is unanswerable on its own; the two
 * ordinary messages before it are what make it answerable. This store is the only
 * place those messages go.
 *
 * It is deliberately NOT:
 *  - persistent memory. Nothing here is extracted, summarised, written to the
 *    memory file or restored on boot: the store is process memory and a restart
 *    empties it. Ambient chatter must never cross the long-term memory boundary;
 *  - requester context. A non-mentioned message never enters the requester
 *    conversation, so ambient chatter can never be attributed to whoever asks
 *    next;
 *  - an authorization input. The rendered speaker labels carry no authority and
 *    are never compared against operator configuration.
 *
 * Scope is one group (the conversation id). Two groups never share entries,
 * counters or speaker numbering.
 *
 * One event, one render: an @-message is captured here too (the next member to
 * ask needs to see that the question was already asked), so the same inbound
 * event is held by both this store and the recent-conversation transcript. The
 * renderer therefore accepts the event ids another view is rendering and drops
 * them, by id, never by text (see `AmbientRenderRequest.excludeEventIds`).
 *
 * Hard bounds — both apply, neither replaces the other:
 *  - `maxEntries`: the newest N entries survive per group;
 *  - `ttlMs`: an entry older than the TTL is dropped at the next touch.
 * A final render budget keeps 30 long messages from blowing up the prompt; the
 * most recent lines win.
 *
 * Privacy: entries keep the trusted runtime identity in memory purely to tell
 * two speakers apart. It is never rendered, never logged and never stored. Logs
 * carry enums and counts only.
 */
import { formatDiagnosticLine, type PersistentRuntimeLogSink } from './persistent-runtime-log.js'

/** Scope token used in every ambient diagnostic. */
export const AMBIENT_SCOPE = 'GROUP_AMBIENT'

/** Prefix of a group-local pseudonym for a member who is not the current requester. */
export const AMBIENT_SPEAKER_PREFIX = 'AMBIENT_SPEAKER_'

/**
 * Label of the requester whose message triggered the current turn. It is
 * resolved per render, not per append, so the same member is the current
 * requester in one turn and an ambient speaker in the next.
 */
export const CURRENT_REQUESTER_LABEL = 'CURRENT_REQUESTER'

/** Label of the bot's own group replies inside the ambient transcript. */
export const ASSISTANT_LABEL = 'ASSISTANT'

export type AmbientSpeakerType = 'MEMBER' | 'ASSISTANT'

/** One ambient entry as captured. `speakerId` is trusted and in-memory only. */
export interface AmbientEntryInput {
  messageId: string
  speakerId: string
  speakerType: AmbientSpeakerType
  text: string
  timestamp: number
}

/** One rendered transcript line. Never carries a raw identity. */
export interface AmbientLine {
  label: string
  text: string
}

export interface AmbientRenderRequest {
  /** Current time in epoch milliseconds; defaults to the store clock. */
  now?: number
  /** Trusted requester identity of the turn being rendered, if any. */
  currentRequesterId?: string
  /** Message being answered right now; it must not appear twice in one prompt. */
  excludeMessageId?: string
  /**
   * Event ids another context view is rendering in this same prompt.
   *
   * An @-message is group history, so it is captured here as well as in the
   * recent-conversation transcript. That is two stores holding one event, and the
   * prompt must not present it twice: the transcript is the "actually entered the
   * Agent" view and wins, so those event ids are dropped from this render and the
   * ambient section becomes the complement of the transcript — the ordinary
   * chatter that never reached the Agent.
   *
   * Identity is the delivery id, never the text: two members saying "好的" are two
   * events with two ids, and only the one already rendered elsewhere is dropped.
   */
  excludeEventIds?: readonly string[]
  /** Optional per-render entry cap; defaults to the store cap. */
  limit?: number
  /** Optional per-render character budget; defaults to the store budget. */
  maxChars?: number
}

export interface AmbientSelection {
  lines: readonly AmbientLine[]
  /** Entries that survived the TTL and every exclusion for this render. */
  availableCount: number
  /** Entries actually rendered after the entry and character budgets. */
  selectedCount: number
  /** Entries removed by the TTL during this read. */
  expiredDropped: number
  /** Entries dropped because another context view already rendered the event. */
  crossContextDropped: number
}

export type AmbientAppendResult = 'PASS' | 'DUPLICATE' | 'REJECTED'

export interface AmbientAppendOutcome {
  result: AmbientAppendResult
  /** Entries held for this group after the append (and after trimming). */
  messageCount: number
  /** Entries removed by the TTL during this append. */
  expiredDropped: number
}

export interface GroupAmbientContextOptions {
  /** Entries retained per group. */
  maxEntries?: number
  /** Entry lifetime in milliseconds. */
  ttlMs?: number
  /** Default character budget for one render. */
  maxChars?: number
  /** Durable diagnostic sink. Absent means stdout-only diagnostics. */
  sink?: PersistentRuntimeLogSink
  /** Injectable clock so TTL behaviour is deterministic in tests. */
  now?: () => number
}

export const DEFAULT_AMBIENT_MAX_ENTRIES = 30
export const DEFAULT_AMBIENT_TTL_MS = 30 * 60 * 1000
export const DEFAULT_AMBIENT_MAX_CHARS = 4000

/**
 * Per-group ambient transcript. Every mutating path prunes first, so a reader can
 * never observe an entry that already outlived its TTL.
 */
export class GroupAmbientContext {
  private readonly entriesByGroup = new Map<string, AmbientEntryInput[]>()
  private readonly labelsByGroup = new Map<string, Map<string, string>>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly maxChars: number
  private readonly sink?: PersistentRuntimeLogSink
  private readonly clock: () => number

  public constructor(options: GroupAmbientContextOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_AMBIENT_MAX_ENTRIES
    this.ttlMs = options.ttlMs ?? DEFAULT_AMBIENT_TTL_MS
    this.maxChars = options.maxChars ?? DEFAULT_AMBIENT_MAX_CHARS
    this.sink = options.sink
    this.clock = options.now ?? (() => Date.now())
  }

  /**
   * Append one ambient entry.
   *
   * A missing field, an empty body or a non-finite timestamp is refused instead
   * of being repaired: a half-known line in the transcript is worse than a gap.
   * A repeated message id is a duplicate delivery, not a second utterance, so the
   * stored transcript keeps exactly one copy of it.
   */
  public append(groupKey: string, entry: AmbientEntryInput): AmbientAppendOutcome {
    const now = this.clock()
    if (!isUsableGroup(groupKey) || !isUsableEntry(entry)) {
      const outcome: AmbientAppendOutcome = {
        result: 'REJECTED',
        messageCount: this.entriesByGroup.get(groupKey)?.length ?? 0,
        expiredDropped: 0,
      }
      this.diagnose('CONTEXT_APPEND', entry.speakerType, outcome)
      return outcome
    }

    const expiredDropped = this.prune(groupKey, now)
    const entries = this.entriesByGroup.get(groupKey) ?? []
    if (entries.some((existing) => existing.messageId === entry.messageId)) {
      const outcome: AmbientAppendOutcome = {
        result: 'DUPLICATE',
        messageCount: entries.length,
        expiredDropped,
      }
      this.diagnose('CONTEXT_APPEND', entry.speakerType, outcome)
      return outcome
    }

    if (entry.speakerType === 'MEMBER') {
      // Numbering is assigned once per (group, speaker) and never reused, so a
      // member keeps the same label for the whole Agent lifetime.
      this.labelFor(groupKey, entry.speakerId)
    }
    entries.push({ ...entry, text: entry.text.trim() })
    if (entries.length > this.maxEntries) {
      entries.splice(0, entries.length - this.maxEntries)
    }

    this.entriesByGroup.set(groupKey, entries)
    const outcome: AmbientAppendOutcome = {
      result: 'PASS',
      messageCount: entries.length,
      expiredDropped,
    }
    this.diagnose('CONTEXT_APPEND', entry.speakerType, outcome)
    return outcome
  }

  /**
   * Render the ambient transcript that may be handed to the provider.
   *
   * Two exclusions apply, both by event identity:
   *  - the message currently being answered is excluded by id: it is the active
   *    request, and repeating it here as well would make the model read one
   *    utterance as two;
   *  - events another context view is rendering in this same prompt are excluded
   *    by id, so the ambient section complements the recent-conversation
   *    transcript instead of duplicating it.
   */
  public select(groupKey: string, request: AmbientRenderRequest): AmbientSelection {
    const expiredDropped = this.prune(groupKey, request.now ?? this.clock())
    const entries = this.entriesByGroup.get(groupKey) ?? []
    const renderedElsewhere =
      request.excludeEventIds === undefined ? undefined : new Set(request.excludeEventIds)

    const withoutActive = entries.filter(
      (entry) => request.excludeMessageId === undefined || entry.messageId !== request.excludeMessageId,
    )
    const eligible = renderedElsewhere === undefined
      ? withoutActive
      : withoutActive.filter((entry) => !renderedElsewhere.has(entry.messageId))
    const crossContextDropped = withoutActive.length - eligible.length

    const limit = Math.max(0, Math.min(request.limit ?? this.maxEntries, this.maxEntries))
    const maxChars = Math.max(0, Math.min(request.maxChars ?? this.maxChars, this.maxChars))
    const lines: AmbientLine[] = []
    let chars = 0

    for (let index = eligible.length - 1; index >= 0 && lines.length < limit; index -= 1) {
      const entry = eligible[index]
      const label = this.renderLabel(groupKey, entry, request.currentRequesterId)
      const lineChars = label.length + entry.text.length + 2
      // The budget always keeps the most recent line, even when that single line
      // is longer than the whole budget: an empty ambient section would be worse.
      if (lines.length > 0 && chars + lineChars > maxChars) {
        break
      }

      lines.unshift({ label, text: entry.text })
      chars += lineChars
    }

    const selection: AmbientSelection = {
      lines,
      availableCount: eligible.length,
      selectedCount: lines.length,
      expiredDropped,
      crossContextDropped,
    }
    this.diagnoseRead(selection)
    return selection
  }

  /** Entries currently held for one group, after a TTL prune. */
  public count(groupKey: string): number {
    this.prune(groupKey, this.clock())
    return this.entriesByGroup.get(groupKey)?.length ?? 0
  }

  /** Stored transcript for one group, oldest first. Test and diagnostic surface. */
  public entries(groupKey: string): readonly AmbientEntryInput[] {
    this.prune(groupKey, this.clock())
    return [...(this.entriesByGroup.get(groupKey) ?? [])]
  }

  private renderLabel(groupKey: string, entry: AmbientEntryInput, currentRequesterId?: string): string {
    if (entry.speakerType === 'ASSISTANT') {
      return ASSISTANT_LABEL
    }
    if (currentRequesterId !== undefined && currentRequesterId === entry.speakerId) {
      return CURRENT_REQUESTER_LABEL
    }
    return this.labelFor(groupKey, entry.speakerId)
  }

  private labelFor(groupKey: string, speakerId: string): string {
    let labels = this.labelsByGroup.get(groupKey)
    if (!labels) {
      labels = new Map<string, string>()
      this.labelsByGroup.set(groupKey, labels)
    }

    const existing = labels.get(speakerId)
    if (existing !== undefined) {
      return existing
    }

    const label = `${AMBIENT_SPEAKER_PREFIX}${labels.size + 1}`
    labels.set(speakerId, label)
    return label
  }

  /** Drops entries that outlived the TTL and reports how many were removed. */
  private prune(groupKey: string, now: number): number {
    const entries = this.entriesByGroup.get(groupKey)
    if (!entries || entries.length === 0) {
      return 0
    }

    const kept = entries.filter((entry) => now - entry.timestamp <= this.ttlMs)
    const dropped = entries.length - kept.length
    if (dropped > 0) {
      this.entriesByGroup.set(groupKey, kept)
    }
    return dropped
  }

  private diagnose(event: string, speakerType: AmbientSpeakerType, outcome: AmbientAppendOutcome): void {
    emitAmbientDiagnostic(this.sink, event, {
      scope: AMBIENT_SCOPE,
      speakerType,
      messageCount: outcome.messageCount,
      expiredDropped: outcome.expiredDropped,
      result: outcome.result,
    })
  }

  private diagnoseRead(selection: AmbientSelection): void {
    emitAmbientDiagnostic(this.sink, 'CONTEXT_READ', {
      scope: AMBIENT_SCOPE,
      availableCount: selection.availableCount,
      selectedCount: selection.selectedCount,
      expiredDropped: selection.expiredDropped,
      crossContextDropped: selection.crossContextDropped,
      result: 'PASS',
    })
  }
}

/**
 * One diagnostic renderer for both channels: the same fields reach stdout and the
 * durable log, and both carry enums and counts only.
 */
function emitAmbientDiagnostic(
  sink: PersistentRuntimeLogSink | undefined,
  event: string,
  fields: Record<string, string | number>,
): void {
  console.log(formatDiagnosticLine(event, fields))
  try {
    sink?.writeStructured(event, fields)
  } catch {
    /* fail-open: a broken sink must never break chat, memory or the policy path */
  }
}

function isUsableGroup(groupKey: string): boolean {
  return typeof groupKey === 'string' && groupKey.trim().length > 0
}

function isUsableEntry(entry: AmbientEntryInput): boolean {
  return (
    typeof entry.messageId === 'string' &&
    entry.messageId.trim().length > 0 &&
    typeof entry.speakerId === 'string' &&
    entry.speakerId.trim().length > 0 &&
    typeof entry.text === 'string' &&
    entry.text.trim().length > 0 &&
    Number.isFinite(entry.timestamp) &&
    entry.timestamp > 0
  )
}

/** True when a rendered label is an ambient-transcript pseudonym. */
export function isAmbientSpeakerLabel(label: string): boolean {
  return new RegExp(`^${AMBIENT_SPEAKER_PREFIX}\\d+$`, 'u').test(label)
}
