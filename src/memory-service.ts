/**
 * Memory service: trigger policy, scope selection, retrieval and writes.
 *
 * HISTORICAL_SEMANTIC (v02 `MemoryService.cs`), migrated one-to-one unless
 * marked CURRENT_MIGRATION_DECISION:
 *  - auto batch threshold 8, chat-triggered threshold 3, 5-minute timer that
 *    flushes buffers with at least 3 pending messages;
 *  - pending buffer capped at 32 messages, restored when a flush fails;
 *  - GROUP retrieval = conversation GROUP/SHARED + the current requester's
 *    personal scope (OWNER/SHARED for an owner, MEMBER/SHARED otherwise);
 *    PRIVATE is never read in GROUP;
 *  - GROUP writes are always SHARED; personal writes go to the requester's own
 *    scope id; a candidate whose scope contradicts the requester role is dropped;
 *  - explicit "记住" is OWNER-only, resolved through the trusted role fact;
 *  - eligibility 30 records, final injection 4 records, lexical relevance;
 *  - duplicate content inside one scope is skipped, write failures are explicit.
 *
 * CURRENT_MIGRATION_DECISION:
 *  - memory is enabled for GROUP only. DIRECT identity is still UNVERIFIED, so
 *    DIRECT reads and writes are skipped instead of keying personal memory on an
 *    unverified id;
 *  - the pending buffer is keyed by (conversation, requester) instead of
 *    conversation, so a batch can never attribute one requester's facts to
 *    another (historical buffers used the last speaker for the whole batch);
 *  - each admitted message is consumed at most once (duplicate MsgId is skipped);
 *  - write validation also rejects over-long content and raw identity markers.
 */
import { randomUUID } from 'node:crypto'
import { sanitizeFinalAnswer } from './final-answer.js'
import {
  containsRawIdentityMarker,
  MEMORY_MAX_CONTENT_CHARS,
  MEMORY_SCOPE_GROUP,
  MEMORY_SCOPE_MEMBER,
  MEMORY_SCOPE_OWNER,
  MemoryText,
  type MemoryAccessRule,
  type MemoryCandidate,
  type MemoryCandidateRejection,
  type MemoryContextItem,
  type MemoryInputMessage,
  type MemoryRecord,
  type MemoryScopeType,
} from './memory-models.js'
import { filterAndRank } from './memory-relevance.js'
import { MemoryExtractor, type StructuredCompletion } from './memory-extractor.js'
import type { MemoryStore } from './memory-store.js'
import type { ConversationType, RequesterRole } from './message-contract.js'
import {
  emitDiagnostic,
  type DiagnosticFields,
  type PersistentRuntimeLogSink,
} from './persistent-runtime-log.js'

export const MEMORY_AUTO_FLUSH_BATCH_SIZE = 8
export const MEMORY_CHAT_FLUSH_MINIMUM = 3
export const MEMORY_ELIGIBLE_LIMIT = 30
export const MEMORY_FINAL_LIMIT = 4
export const MEMORY_MAX_PENDING_MESSAGES = 32
export const MEMORY_TIMER_INTERVAL_MS = 5 * 60 * 1000
export const MEMORY_SEEN_MESSAGE_LIMIT = 512

/** Historical `MemoryService.IsExplicitMemoryIntent` keyword list. */
export const EXPLICIT_MEMORY_KEYWORDS = [
  '记住',
  '记一下',
  '记得',
  '忘掉',
  '忘记',
  '删掉这条记忆',
  '改成',
  '修改记忆',
] as const

/** Historical GROUP keywords that route an explicit add to the group scope. */
export const GROUP_SCOPE_KEYWORDS = ['这个群', '本群', '群里', '以后这个群'] as const

export interface MemoryObservation {
  messageId: string
  conversationType: ConversationType
  conversationId: string
  requesterId: string
  requesterRole: RequesterRole
  /** Runtime pseudonymous speaker label; never a raw identity. */
  speakerLabel: string
  text: string
  timestamp: number
  /** True when this message triggered a chat turn (historical `chatTriggered`). */
  chatTriggered: boolean
}

export interface MemoryReadRequest {
  conversationType: ConversationType
  conversationId: string
  requesterId: string
  requesterRole: RequesterRole
  question: string
}

export interface ExplicitMemoryRequest extends MemoryReadRequest {}

export interface ExplicitMemoryResult {
  handled: boolean
  reply: string
}

export interface MemoryMutation {
  operation: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE'
  target: string | null
  content: string | null
  scope: string | null
}

export interface MemoryServiceOptions {
  store: MemoryStore
  extractor: MemoryExtractor
  /** Structured completion used by the explicit "记住" mutation parser. */
  mutate: StructuredCompletion
  now?: () => number
  idFactory?: () => string
  log?: (message: string) => void
  /**
   * Durable sink for the same diagnostics. When present every
   * `MEMORY_TRIGGER` / `MEMORY_READ` / `MEMORY_WRITE` line is also written to
   * the persistent runtime log, so the memory decisions survive the process;
   * when absent the service stays stdout-only.
   */
  sink?: PersistentRuntimeLogSink
  /** The historical 5-minute timer. Tests disable it and drive flushes directly. */
  enableTimer?: boolean
  timerIntervalMs?: number
}

type MemoryFlushTrigger = 'AUTO_BATCH' | 'AUTO_CHAT_THRESHOLD' | 'AUTO_TIMER'

interface BufferedEntry {
  messageId: string
  message: MemoryInputMessage
}

class PendingBuffer {
  private entries: BufferedEntry[] = []
  private flushing = false

  public add(entry: BufferedEntry): number {
    if (this.entries.length >= MEMORY_MAX_PENDING_MESSAGES) {
      this.entries.shift()
    }
    this.entries.push(entry)
    return this.entries.length
  }

  public get count(): number {
    return this.entries.length
  }

  public tryBeginFlush(minimum: number): BufferedEntry[] | null {
    if (this.flushing || this.entries.length < minimum) {
      return null
    }
    this.flushing = true
    const batch = this.entries
    this.entries = []
    return batch
  }

  public complete(entries: readonly BufferedEntry[], success: boolean): void {
    if (!success) {
      // Historical `PendingBuffer.Complete`: an unsuccessful flush restores the
      // messages so nothing is silently lost.
      this.entries = [...entries, ...this.entries].slice(-MEMORY_MAX_PENDING_MESSAGES)
    }
    this.flushing = false
  }
}

interface PendingSlot {
  buffer: PendingBuffer
  conversationId: string
  requesterId: string
  requesterRole: RequesterRole
}

export class MemoryService {
  private readonly store: MemoryStore
  private readonly extractor: MemoryExtractor
  private readonly mutate: StructuredCompletion
  private readonly now: () => number
  private readonly idFactory: () => string
  private readonly log: (message: string) => void
  private readonly sink: PersistentRuntimeLogSink | undefined
  private readonly slots = new Map<string, PendingSlot>()
  private readonly pendingFlushes = new Set<Promise<void>>()
  private readonly seenMessageIds: string[] = []
  private readonly seen = new Set<string>()
  private timer: NodeJS.Timeout | undefined

  public constructor(options: MemoryServiceOptions) {
    this.store = options.store
    this.extractor = options.extractor
    this.mutate = options.mutate
    this.now = options.now ?? (() => Date.now())
    this.idFactory = options.idFactory ?? (() => randomUUID().replaceAll('-', ''))
    this.log = options.log ?? ((message: string) => console.log(message))
    this.sink = options.sink

    if (options.enableTimer === true) {
      this.timer = setInterval(() => this.flushPendingBuffers(), options.timerIntervalMs ?? MEMORY_TIMER_INTERVAL_MS)
      this.timer.unref()
    }
  }

  /**
   * One memory diagnostic: the stdout line the operator already knows, plus the
   * same fields as a durable persistent-log event. Fields are enums, counts and
   * result/reason codes only — never a raw requester id, scope id, conversation
   * id or memory content.
   */
  private emit(event: 'MEMORY_TRIGGER' | 'MEMORY_READ' | 'MEMORY_WRITE', fields: DiagnosticFields): void {
    emitDiagnostic(this.log, this.sink, event, fields)
  }

  public get isEnabled(): boolean {
    return this.store.isEnabled
  }

  /** Live record count, for diagnostics and acceptance assertions. */
  public get recordCount(): number {
    return this.store.liveRecordCount
  }

  public isExplicitMemoryIntent(role: RequesterRole, text: string): boolean {
    return role === 'OWNER' && EXPLICIT_MEMORY_KEYWORDS.some((keyword) => text.includes(keyword))
  }

  /** Admission + buffering. Never writes memory by itself. */
  public observeHumanMessage(observation: MemoryObservation): void {
    if (!this.store.isEnabled) {
      this.emit('MEMORY_TRIGGER', { trigger: 'NONE', role: observation.requesterRole, result: 'SKIPPED', reason: 'STORE_UNAVAILABLE' })
      return
    }
    if (observation.conversationType !== 'GROUP') {
      this.emit('MEMORY_TRIGGER', { trigger: 'NONE', role: observation.requesterRole, result: 'SKIPPED', reason: 'DIRECT_IDENTITY_UNVERIFIED' })
      return
    }
    if (!observation.requesterId) {
      this.emit('MEMORY_TRIGGER', { trigger: 'NONE', role: observation.requesterRole, result: 'SKIPPED', reason: 'REQUESTER_IDENTITY_MISSING' })
      return
    }

    const content = MemoryText.normalize(observation.text)
    if (content.length === 0) {
      this.emit('MEMORY_TRIGGER', { trigger: 'NONE', role: observation.requesterRole, result: 'SKIPPED', reason: 'EMPTY_TEXT' })
      return
    }

    if (this.seen.has(observation.messageId)) {
      this.emit('MEMORY_TRIGGER', { trigger: 'NONE', role: observation.requesterRole, result: 'SKIPPED', reason: 'DUPLICATE_MESSAGE' })
      return
    }
    this.rememberMessage(observation.messageId)

    const key = `${observation.conversationId}\u0000${observation.requesterId}`
    const slot = this.slots.get(key) ?? {
      buffer: new PendingBuffer(),
      conversationId: observation.conversationId,
      requesterId: observation.requesterId,
      requesterRole: observation.requesterRole,
    }
    this.slots.set(key, slot)

    const count = slot.buffer.add({
      messageId: observation.messageId,
      message: {
        speakerLabel: observation.speakerLabel,
        role: observation.requesterRole,
        content,
      },
    })

    const minimum = count >= MEMORY_AUTO_FLUSH_BATCH_SIZE
      ? MEMORY_AUTO_FLUSH_BATCH_SIZE
      : observation.chatTriggered && count >= MEMORY_CHAT_FLUSH_MINIMUM
        ? MEMORY_CHAT_FLUSH_MINIMUM
        : Number.POSITIVE_INFINITY
    const batch = slot.buffer.tryBeginFlush(minimum)
    if (batch === null) {
      this.emit('MEMORY_TRIGGER', { trigger: 'BUFFERED', role: observation.requesterRole, result: 'PASS', pending: count })
      return
    }

    const trigger: MemoryFlushTrigger =
      count >= MEMORY_AUTO_FLUSH_BATCH_SIZE ? 'AUTO_BATCH' : 'AUTO_CHAT_THRESHOLD'
    this.scheduleFlush(slot, batch, trigger)
  }

  /** Historical `RetrieveForChatAsync`, GROUP contract only. */
  public async retrieveForChat(request: MemoryReadRequest): Promise<MemoryContextItem[]> {
    // The personal scope the request would read (OWNER for an owner, MEMBER
    // otherwise); it is an enum so it is safe for both log channels.
    const scope = this.personalScope(request.requesterRole)
    if (!this.store.isEnabled) {
      this.emit('MEMORY_READ', { scope, personalCount: 0, groupCount: 0, candidateCount: 0, selectedCount: 0, result: 'FAIL', reason: 'STORE_UNAVAILABLE' })
      return []
    }
    if (request.conversationType !== 'GROUP') {
      this.emit('MEMORY_READ', { scope, personalCount: 0, groupCount: 0, candidateCount: 0, selectedCount: 0, result: 'PASS', reason: 'DIRECT_MEMORY_DISABLED' })
      return []
    }

    const eligible = this.store.retrieve(this.groupRetrievalRules(request), MEMORY_ELIGIBLE_LIMIT)
    const personalCount = eligible.filter((record) => record.scopeType !== MEMORY_SCOPE_GROUP).length
    const groupCount = eligible.length - personalCount
    const ranked = filterAndRank(request.question, eligible, MEMORY_FINAL_LIMIT, {
      requesterId: request.requesterId,
      personalScopeType: scope,
    })
    const items = ranked.map<MemoryContextItem>((record) => ({
      scope: record.scopeType === MEMORY_SCOPE_GROUP ? 'GROUP' : 'PERSONAL',
      content: MemoryText.forModel(record.content),
    }))

    this.emit('MEMORY_READ', {
      scope,
      personalCount,
      groupCount,
      candidateCount: eligible.length,
      selectedCount: items.length,
      result: 'PASS',
    })
    return items
  }

  /** Historical `TryHandleExplicitAsync`, OWNER-only through the trusted role. */
  public async tryHandleExplicit(request: ExplicitMemoryRequest): Promise<ExplicitMemoryResult> {
    if (!this.store.isEnabled) {
      this.emit('MEMORY_TRIGGER', { trigger: 'EXPLICIT_REMEMBER', role: request.requesterRole, result: 'SKIPPED', reason: 'STORE_UNAVAILABLE' })
      return { handled: false, reply: '' }
    }
    if (request.conversationType !== 'GROUP') {
      this.emit('MEMORY_TRIGGER', { trigger: 'EXPLICIT_REMEMBER', role: request.requesterRole, result: 'SKIPPED', reason: 'DIRECT_IDENTITY_UNVERIFIED' })
      return { handled: false, reply: '' }
    }
    if (!this.isExplicitMemoryIntent(request.requesterRole, request.question)) {
      return { handled: false, reply: '' }
    }

    const candidates = this.store.retrieve(this.explicitCandidateRules(request), MEMORY_FINAL_LIMIT)
    let mutation: MemoryMutation
    try {
      mutation = parseMemoryMutation(await this.mutate(mutationSystemPrompt(), mutationUserPrompt(request.question, candidates)))
    } catch {
      this.emit('MEMORY_TRIGGER', { trigger: 'EXPLICIT_REMEMBER', role: request.requesterRole, result: 'FAIL', reason: 'MUTATION_UNAVAILABLE' })
      return { handled: true, reply: '先不改。' }
    }

    if (mutation.operation === 'NONE') {
      this.emit('MEMORY_TRIGGER', { trigger: 'EXPLICIT_REMEMBER', role: request.requesterRole, result: 'FAIL', reason: 'MUTATION_NONE' })
      return { handled: true, reply: '先不改。' }
    }

    const now = this.now()
    if (mutation.operation === 'ADD') {
      // Historical scope routing: the group keywords decide GROUP, everything
      // else is the requester's own personal scope. The model's `scope` field is
      // informational only, exactly as in v02.
      const groupScoped = GROUP_SCOPE_KEYWORDS.some((keyword) => request.question.includes(keyword))
      const scopeType: MemoryScopeType = groupScoped ? MEMORY_SCOPE_GROUP : this.personalScope(request.requesterRole)
      const scopeId = groupScoped ? request.conversationId : request.requesterId
      const rejection = validateContent(mutation.content ?? '')
      if (rejection !== null) {
        this.emit('MEMORY_WRITE', { scope: scopeType, visibility: 'SHARED', result: 'FAIL', reason: rejection })
        return { handled: true, reply: '先不改。' }
      }

      const status = this.store.add({
        memoryId: this.idFactory(),
        scopeType,
        scopeId,
        content: MemoryText.normalize(mutation.content ?? ''),
        contentHash: '',
        visibility: 'SHARED',
        origin: 'EXPLICIT_OWNER',
        sourceConversationType: request.conversationType,
        sourceConversationId: request.conversationId,
        sourceSenderId: request.requesterId,
        createdAt: now,
        updatedAt: now,
        isDeleted: false,
      })
      this.emit('MEMORY_WRITE', { scope: scopeType, visibility: 'SHARED', result: status })
      this.emit('MEMORY_TRIGGER', {
        trigger: 'EXPLICIT_REMEMBER',
        role: request.requesterRole,
        result: status === 'WRITTEN' || status === 'SKIPPED' ? 'PASS' : 'FAIL',
      })
      return { handled: true, reply: status === 'WRITTEN' || status === 'SKIPPED' ? '记住了。' : '先不改。' }
    }

    const candidate = resolveMutationTarget(mutation.target, candidates)
    if (candidate === null) {
      this.emit('MEMORY_TRIGGER', { trigger: 'EXPLICIT_REMEMBER', role: request.requesterRole, result: 'FAIL', reason: 'TARGET_NOT_FOUND' })
      return { handled: true, reply: '没找到你说的那条记忆。' }
    }

    if (mutation.operation === 'UPDATE') {
      const rejection = validateContent(mutation.content ?? '')
      if (rejection !== null) {
        this.emit('MEMORY_WRITE', { scope: candidate.scopeType, visibility: 'SHARED', result: 'FAIL', reason: rejection })
        return { handled: true, reply: '先不改。' }
      }
      const updated = this.store.update(candidate.memoryId, mutation.content ?? '', now)
      this.emit('MEMORY_WRITE', { scope: candidate.scopeType, visibility: 'SHARED', result: updated ? 'WRITTEN' : 'FAILED' })
      this.emit('MEMORY_TRIGGER', { trigger: 'EXPLICIT_REMEMBER', role: request.requesterRole, result: updated ? 'PASS' : 'FAIL' })
      return { handled: true, reply: updated ? '改好了。' : '先不改。' }
    }

    const deleted = this.store.delete(candidate.memoryId, now)
    this.emit('MEMORY_WRITE', { scope: candidate.scopeType, visibility: 'SHARED', result: deleted ? 'WRITTEN' : 'FAILED' })
    this.emit('MEMORY_TRIGGER', { trigger: 'EXPLICIT_REMEMBER', role: request.requesterRole, result: deleted ? 'PASS' : 'FAIL' })
    return { handled: true, reply: deleted ? '忘掉了。' : '先不改。' }
  }

  /** Historical 5-minute timer body: flush every buffer with >= 3 messages. */
  public flushPendingBuffers(): void {
    for (const slot of this.slots.values()) {
      const batch = slot.buffer.tryBeginFlush(MEMORY_CHAT_FLUSH_MINIMUM)
      if (batch !== null) {
        this.scheduleFlush(slot, batch, 'AUTO_TIMER')
      }
    }
  }

  /** Awaits every in-flight flush. It does not start a timer-style flush. */
  public async flushAll(): Promise<void> {
    while (this.pendingFlushes.size > 0) {
      await Promise.all([...this.pendingFlushes])
    }
  }

  public close(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private scheduleFlush(slot: PendingSlot, batch: readonly BufferedEntry[], trigger: MemoryFlushTrigger): void {
    const task: Promise<void> = this.flushAsync(slot, batch, trigger)
    this.pendingFlushes.add(task)
    void task.finally(() => {
      this.pendingFlushes.delete(task)
    })
  }

  private async flushAsync(
    slot: PendingSlot,
    batch: readonly BufferedEntry[],
    trigger: MemoryFlushTrigger,
  ): Promise<void> {
    try {
      const candidates = await this.extractor.extract('GROUP', batch.map((entry) => entry.message))
      let written = 0
      let skipped = 0
      for (const candidate of candidates) {
        const built = this.buildAutomaticRecord(slot, candidate)
        if ('rejection' in built) {
          this.emit('MEMORY_WRITE', { scope: candidate.scopeType, visibility: 'SHARED', result: 'SKIPPED', reason: built.rejection })
          skipped += 1
          continue
        }

        const status = this.store.add(built.record)
        this.emit('MEMORY_WRITE', { scope: built.record.scopeType, visibility: 'SHARED', result: status })
        if (status === 'WRITTEN') {
          written += 1
        } else {
          skipped += 1
        }
      }

      slot.buffer.complete(batch, true)
      this.emit('MEMORY_TRIGGER', {
        trigger,
        role: slot.requesterRole,
        result: 'PASS',
        candidates: candidates.length,
        written,
        skipped,
      })
    } catch {
      slot.buffer.complete(batch, false)
      this.emit('MEMORY_TRIGGER', { trigger, role: slot.requesterRole, result: 'FAIL', reason: 'EXTRACTOR_FAILED' })
    }
  }

  private buildAutomaticRecord(
    slot: PendingSlot,
    candidate: MemoryCandidate,
  ): { record: MemoryRecord } | { rejection: MemoryCandidateRejection } {
    let scopeType: MemoryScopeType
    if (candidate.scopeType === MEMORY_SCOPE_GROUP) {
      scopeType = MEMORY_SCOPE_GROUP
    } else if (candidate.scopeType === MEMORY_SCOPE_OWNER && slot.requesterRole === 'OWNER') {
      scopeType = MEMORY_SCOPE_OWNER
    } else if (candidate.scopeType === MEMORY_SCOPE_MEMBER && slot.requesterRole === 'MEMBER') {
      scopeType = MEMORY_SCOPE_MEMBER
    } else {
      return { rejection: 'SCOPE_NOT_ALLOWED_FOR_ROLE' }
    }

    const scopeId = scopeType === MEMORY_SCOPE_GROUP ? slot.conversationId : slot.requesterId
    if (scopeId.length === 0) {
      return { rejection: 'SCOPE_IDENTITY_MISSING' }
    }

    const rejection = validateContent(candidate.content)
    if (rejection !== null) {
      return { rejection }
    }

    const content = MemoryText.normalize(candidate.content)
    const now = this.now()
    return {
      record: {
        memoryId: this.idFactory(),
        scopeType,
        scopeId,
        content,
        contentHash: '',
        // Historical GROUP writes are always SHARED.
        visibility: 'SHARED',
        origin: 'AUTOMATIC',
        sourceConversationType: 'GROUP',
        sourceConversationId: slot.conversationId,
        sourceSenderId: slot.requesterId,
        createdAt: now,
        updatedAt: now,
        isDeleted: false,
      },
    }
  }

  private groupRetrievalRules(request: MemoryReadRequest): MemoryAccessRule[] {
    return [
      { scopeType: MEMORY_SCOPE_GROUP, scopeId: request.conversationId, visibility: 'SHARED' },
      {
        scopeType: this.personalScope(request.requesterRole),
        scopeId: request.requesterId,
        visibility: 'SHARED',
      },
    ]
  }

  private explicitCandidateRules(request: ExplicitMemoryRequest): MemoryAccessRule[] {
    return [
      { scopeType: this.personalScope(request.requesterRole), scopeId: request.requesterId, visibility: 'SHARED' },
      { scopeType: MEMORY_SCOPE_GROUP, scopeId: request.conversationId, visibility: 'SHARED' },
    ]
  }

  private personalScope(role: RequesterRole): typeof MEMORY_SCOPE_OWNER | typeof MEMORY_SCOPE_MEMBER {
    return role === 'OWNER' ? MEMORY_SCOPE_OWNER : MEMORY_SCOPE_MEMBER
  }

  private rememberMessage(messageId: string): void {
    this.seen.add(messageId)
    this.seenMessageIds.push(messageId)
    while (this.seenMessageIds.length > MEMORY_SEEN_MESSAGE_LIMIT) {
      const evicted = this.seenMessageIds.shift()
      if (evicted !== undefined) {
        this.seen.delete(evicted)
      }
    }
  }
}

/** Write-time validation shared by automatic and explicit writes. */
export function validateContent(content: string): MemoryCandidateRejection | null {
  const normalized = MemoryText.normalize(content)
  if (normalized.length === 0) {
    return 'EMPTY_FACT'
  }
  if (normalized.length > MEMORY_MAX_CONTENT_CHARS) {
    return 'CONTENT_TOO_LONG'
  }
  if (containsRawIdentityMarker(normalized)) {
    return 'RAW_IDENTITY_IN_CONTENT'
  }
  return null
}

export function mutationSystemPrompt(): string {
  return (
    '你是长期记忆变更解析器。只输出严格 JSON，不要解释，不要输出思考过程。格式：'
    + '{"operation":"ADD|UPDATE|DELETE|NONE","target":"M1","content":"...","scope":"OWNER|GROUP"}。'
    + '只能理解用户明确的记忆变更意图，无法确定时输出 NONE。'
  )
}

export function mutationUserPrompt(question: string, candidates: readonly MemoryRecord[]): string {
  const candidateText = candidates.length === 0
    ? '（无候选记忆）'
    : candidates
        .map(
          (candidate, index) =>
            `M${index + 1}: scope=${candidate.scopeType} visibility=${candidate.visibility} content=${MemoryText.forModel(candidate.content)}`,
        )
        .join('\n')
  return `conversationType=GROUP\ncandidates:\n${candidateText}\n\nuserRequest:\n${question}`
}

/** Historical `ParseMutation`: strict JSON object, unknown operations -> NONE. */
export function parseMemoryMutation(response: string): MemoryMutation {
  const boundary = sanitizeMutationText(response)
  let document: unknown
  try {
    document = JSON.parse(boundary) as unknown
  } catch {
    return { operation: 'NONE', target: null, content: null, scope: null }
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { operation: 'NONE', target: null, content: null, scope: null }
  }

  const record = document as Record<string, unknown>
  const operation = typeof record.operation === 'string' ? record.operation.toUpperCase() : ''
  if (operation !== 'ADD' && operation !== 'UPDATE' && operation !== 'DELETE' && operation !== 'NONE') {
    return { operation: 'NONE', target: null, content: null, scope: null }
  }

  return {
    operation,
    target: typeof record.target === 'string' ? record.target : null,
    content: typeof record.content === 'string' ? record.content : null,
    scope: typeof record.scope === 'string' ? record.scope : null,
  }
}

function sanitizeMutationText(response: string): string {
  // The FINAL_ANSWER boundary applies to memory mutation parsing too: provider
  // reasoning is stripped before anything is interpreted.
  const boundary = sanitizeFinalAnswer(response)
  if (boundary.unterminatedTag) {
    return ''
  }
  const text = boundary.text
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

/** Historical `TryResolveCandidate`: only `M<n>` referring to a loaded candidate. */
export function resolveMutationTarget(
  target: string | null,
  candidates: readonly MemoryRecord[],
): MemoryRecord | null {
  if (!target || !target.startsWith('M')) {
    return null
  }
  const index = Number.parseInt(target.slice(1), 10)
  if (!Number.isInteger(index) || index < 1 || index > candidates.length) {
    return null
  }
  return candidates[index - 1] ?? null
}
