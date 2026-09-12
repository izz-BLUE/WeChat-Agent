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
 *  - write validation also rejects over-long content and raw identity markers;
 *  - GROUP retrieval returns the authorize-then-budget WORKING SET
 *    (`authorized-memory-working-set.ts`). The lexical rule is no longer a
 *    visibility gate: `MEMORY_FINAL_LIMIT` bounds the historical explicit
 *    candidate list, while the provider budget is
 *    `MAX_WORKING_MEMORIES` / `MAX_WORKING_MEMORY_CHARS`.
 */
import { randomUUID } from 'node:crypto'
import { sanitizeFinalAnswer } from './final-answer.js'
import {
  classifyMemoryKind,
  classifyMemorySubject,
  MEMORY_KINDS,
  MEMORY_SUBJECTS,
  isReadableMemoryKind,
  memoryKindWriteRejection,
  type MemoryKind,
  type MemorySubject,
} from './assistant-identity.js'
import {
  containsRawIdentityMarker,
  MEMORY_MAX_CONTENT_CHARS,
  MEMORY_SCOPE_GROUP,
  MEMORY_SCOPE_MEMBER,
  MEMORY_SCOPE_OWNER,
  MemoryText,
  normalizeCurrentRequesterSelfReference,
  type MemoryAccessRule,
  type MemoryCandidate,
  type MemoryCandidateRejection,
  type MemoryContextItem,
  type MemoryInputMessage,
  type MemoryRecord,
  type MemoryScopeType,
  type MemoryWriteStatus,
} from './memory-models.js'
import { isCurrentSelfIdentityQuery } from './memory-relevance.js'
import type { BotMentionSpanTrust, UserContentSpanTrust, UserTextShape } from './canonical-user-text.js'
import type { MentionState } from './agent-adapter.js'
import {
  buildAuthorizedMemoryWorkingSet,
  emitMemoryWorkingSet,
  scopeClassOf,
  type AuthorizedMemoryWorkingSet,
} from './authorized-memory-working-set.js'
import { MemoryExtractor, type StructuredCompletion } from './memory-extractor.js'
import type { MemoryStore } from './memory-store.js'
import type { ConversationType, RequesterRole } from './message-contract.js'
import { isRequestDeadlineExceeded, type RequestDeadline } from './request-deadline.js'
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

/**
 * Admission diagnostic. It is the one line that answers "did this message enter
 * the persistent-memory write entry, and if not, why" — the question the field
 * could not answer when a real `@bot 记住…` message silently became ordinary chat.
 */
export const MEMORY_ADMISSION_EVENT = 'MEMORY_ADMISSION'

/**
 * Why an explicit-memory entry ended the way it did.
 *
 * Every one of these used to be reported as the same line — `explicitCommand=false
 * reason=NOT_AN_EXPLICIT_COMMAND result=CHAT` — so "the runtime never confirmed a
 * bot mention", "the sentence is not a command", and "there is another line in
 * front of the command" were indistinguishable in the field. They have completely
 * different owners and fixes:
 *
 *  - `ROLE_NOT_OWNER` — authorization, nothing to do with the text;
 *  - `BOT_MENTION_SPAN_UNTRUSTED` — the runtime's mention verdict is missing or
 *    invalid; the side effect is refused on purpose;
 *  - `BODY_PREFIX_PRESENT` — the command is not the first line of the canonical
 *    body, so something precedes it. The blocker name says "a line precedes the
 *    command"; whether that line is runtime transport framing or genuine user
 *    content (a quoted message, a line the user typed) is NOT decided here, and the
 *    shape facts in the same log line are what settles it;
 *  - `GRAMMAR_MISS` — a single-line body that is simply not a memory command shape;
 *  - `SHAPE_UNKNOWN` — the caller supplied no structural facts, so no finer answer
 *    is claimed.
 */
export type MemoryAdmissionBlocker =
  | 'NONE'
  | 'ROLE_NOT_OWNER'
  | 'USER_CONTENT_SPAN_UNTRUSTED'
  | 'BOT_MENTION_SPAN_UNTRUSTED'
  | 'BODY_PREFIX_PRESENT'
  | 'GRAMMAR_MISS'
  | 'SHAPE_UNKNOWN'

/**
 * EXPLICIT MEMORY ADMISSION — a high-precision side-effect gate.
 *
 * Persistent memory writes, updates and deletes are side effects, and admission
 * to them is the only thing this grammar decides. It is NOT conversation
 * understanding: nothing here decides what a sentence means, and a sentence that
 * fails the gate is not "not a memory command" — it is simply handled as ordinary
 * chat, where the contextual working set already gives the final model what it
 * needs.
 *
 * The asymmetry is deliberate: a missed command becomes a normal chat turn,
 * while a false admission swallows a normal chat turn into a memory write that
 * then fails closed ("这条记忆没有保存成功。"). So the gate requires a verb in
 * COMMAND POSITION and, for updates, an explicit memory object.
 *
 * What each pattern rejects, and why it matters:
 *  - `我忘记带钥匙了` / `我忘记密码了` / `他忘掉带文件了`: the verb is not in command
 *    position, so a statement about one's own forgetfulness never becomes a
 *    memory delete;
 *  - `这个文件删掉了吗`: same, and a yes/no question never becomes a delete;
 *  - `把按钮改成蓝色` / `把接口改成 POST` / `这个字段改成 varchar`: no first-person
 *    memory attribute is being changed, so ordinary edit requests stay chat;
 *  - `记住了吗` / `记住吧`: a verb followed by a perfective or modal particle is a
 *    statement or a recall question, not an imperative.
 *
 * TRANSPORT FRAMING IS NOT THIS LAYER'S BUSINESS. The body arrives here as the
 * CANONICAL USER TEXT (`canonical-user-text.ts`): the mention envelope has
 * already been removed at the Agent ingress, by the contract's own token rule.
 * This gate therefore anchors on the first character of real user content and
 * never re-parses `@name`, separators or line structure. The previous revision
 * did strip an envelope here, and assuming the envelope was at the start of the
 * raw body is exactly how a real "@bot 记住…" message silently failed admission
 * in the field.
 *
 * Kept out on purpose (each would be a step toward a natural-language rule
 * library): any-position keyword matching, fuzzy "sounds like a command" forms,
 * `把…删掉` verb-final phrasing, tolerating an arbitrary prefix, and synonyms
 * beyond the closed sets below. If the verb or object lists start growing, the
 * answer is to let the sentence fall through to chat, not to add words.
 */

/** Optional politeness marker; the command verb still has to follow it. */
const POLITE_PREFIX = '(?:请|麻烦|帮我|替我|给我)'
/** A trailing particle turns an imperative into a statement or a question. */
const NOT_STATEMENT_OR_QUESTION = '(?!了|吗|没|不|吧|呢|？|\\?|$)'
/**
 * The closed set of first-person attributes the runtime can actually store. It is
 * what keeps `把我的代号改成…` (a memory update) apart from `把我的头像改成…`
 * (a client-side edit) without any sentence parsing.
 */
const MEMORY_ATTRIBUTE_OBJECT = '(?:记忆|代号|名字|称呼|昵称|姓名|资料)'
const UPDATE_VERB = '(?:改成|改为|换成|更新成|更新为)'

const EXPLICIT_MEMORY_COMMAND_PATTERNS: readonly RegExp[] = [
  // ADD: the imperative verb opens the sentence.
  new RegExp(`^${POLITE_PREFIX}?(?:记住|记一下|记下来|记着)${NOT_STATEMENT_OR_QUESTION}`, 'u'),
  // DELETE / FORGET: same shape, so the object is whatever follows the verb.
  new RegExp(`^${POLITE_PREFIX}?(?:忘记|忘掉|删掉|删除)${NOT_STATEMENT_OR_QUESTION}`, 'u'),
  // UPDATE of the memory itself.
  new RegExp(`^${POLITE_PREFIX}?(?:修改|更新|改一下)(?:一下)?记忆`, 'u'),
  // UPDATE of a first-person attribute, in the 把-construction.
  new RegExp(`^把(?:我|咱)(?:的)?${MEMORY_ATTRIBUTE_OBJECT}${UPDATE_VERB}`, 'u'),
  // UPDATE of something explicitly remembered earlier; the object noun is free
  // because `之前记的` already names a stored item.
  new RegExp(`^把(?:之前|上次|原来|以前|刚刚)(?:记|说|存|提)(?:的|过)[^，,。！!？?\\s]{0,16}${UPDATE_VERB}`, 'u'),
]

/**
 * True when the text is an explicit, unambiguous memory side-effect command.
 *
 * Anchored, deterministic and cheap: no provider call, no state, no scoring. It
 * runs before the mutation structured completion and is the only thing that can
 * let a message reach it. The input is the canonical user text, so the command
 * must open the sentence.
 */
export function isExplicitMemoryCommand(text: string): boolean {
  const command = text.trim()
  if (command.length === 0) {
    return false
  }
  return EXPLICIT_MEMORY_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
}

/** Historical GROUP keywords that route an explicit add to the group scope. */
export const GROUP_SCOPE_KEYWORDS = ['这个群', '本群', '群里', '以后这个群'] as const

const REQUESTER_LOCAL_PREFERENCE_KINDS: readonly MemoryKind[] = [
  'ADDRESS_PREFERENCE',
  'CONTENT_PREFERENCE',
  'SOFT_STYLE_PREFERENCE',
]

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
  /**
   * Structural facts about the canonical user text, when the caller produced one.
   *
   * Counts and booleans only. They exist so the admission decision is answerable
   * from one log line: "the framing was still attached" and "the requester was not
   * the owner" are different bugs with the same field symptom (an explicit memory
   * command that silently became ordinary chat), and the previous silence could
   * not tell them apart.
   */
  textShape?: UserTextShape
  /**
   * The runtime's own mention verdict for this message.
   *
   * A persistent memory side effect may only be admitted when the message really
   * carries a trusted bot mention token: the runtime decides that, the Agent may not
   * infer it. Absent or invalid facts refuse the side effect (the turn continues as
   * ordinary chat), which is the difference between "a command I could not parse"
   * and "a sentence that was never addressed to me at all".
   */
  mentionState?: MentionState
  botMentionSpanTrust?: BotMentionSpanTrust
  botMentionSpanCount?: number
  userContentSpanTrust?: UserContentSpanTrust
}

export interface ExplicitMemoryRequest extends MemoryReadRequest {
  requestDeadline?: RequestDeadline
  msgIdToken?: string
}

export interface ExplicitMemoryResult {
  handled: boolean
  reply: string
}

export interface MemoryMutation {
  operation: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE'
  target: string | null
  content: string | null
  scope: string | null
  kind: MemoryKind | null
  subject: MemorySubject | null
}

export type MutationParseResult =
  | 'EMPTY_RESPONSE'
  | 'INVALID_JSON'
  | 'SCHEMA_INVALID'
  | 'MODEL_NONE'
  | 'PARSED'

export interface MemoryMutationParseDiagnostics {
  mutation: MemoryMutation
  mutationParseResult: MutationParseResult
  schemaValid: boolean
  contentPresent: boolean
  contentChars: number
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

  /**
   * Historical `MemoryService.IsExplicitMemoryIntent`, now a high-precision
   * side-effect gate: OWNER-only AND an anchored memory command (see
   * `isExplicitMemoryCommand`). A recall question, a statement about forgetting
   * something, or an ordinary "改成" request is not admitted and follows the
   * normal chat path.
   */
  public isExplicitMemoryIntent(role: RequesterRole, text: string): boolean {
    return role === 'OWNER' && isExplicitMemoryCommand(text)
  }

  /**
   * Whether the runtime confirmed that this message carries the bot's own mention
   * token.
   *
   * All three facts are required, and the span count must be positive: a claim of
   * "mentioned, but here are zero tokens" is internally contradictory, so it is
   * treated exactly like a missing claim rather than as permission. This is a safety
   * boundary over a runtime fact, not a language rule — nothing here looks at the
   * text.
   */
  private hasTrustedBotMention(request: ExplicitMemoryRequest): boolean {
    return request.mentionState === 'MENTIONED' &&
      request.botMentionSpanTrust === 'VALID' &&
      (request.botMentionSpanCount ?? 0) > 0
  }

  private hasTrustedUserContentSpan(request: ExplicitMemoryRequest): boolean {
    return request.userContentSpanTrust === 'VALID'
  }

  /**
   * Why this entry did not admit a side effect, derived from structural facts only.
   *
   * No text is inspected beyond the anchored command test that already ran: this
   * classifies the SITUATION (role, runtime mention verdict, body shape) so the field
   * log names the owner of the problem. `BODY_PREFIX_PRESENT` deliberately claims
   * only that a line precedes the command — not that the line is transport framing.
   */
  private admissionBlocker(request: ExplicitMemoryRequest, admitted: boolean): MemoryAdmissionBlocker {
    if (admitted) {
      return 'NONE'
    }
    if (request.requesterRole !== 'OWNER') {
      return 'ROLE_NOT_OWNER'
    }
    if (!this.hasTrustedBotMention(request)) {
      return 'BOT_MENTION_SPAN_UNTRUSTED'
    }
    if (!this.hasTrustedUserContentSpan(request)) {
      return 'USER_CONTENT_SPAN_UNTRUSTED'
    }
    const canonicalLineCount = request.textShape?.canonicalLineCount
    if (canonicalLineCount === undefined) {
      return 'SHAPE_UNKNOWN'
    }
    // The gate is anchored at the start of the canonical text, so a first line that
    // opened a command would have matched; a multi-line body that did not match means
    // something else is in front of the command.
    return canonicalLineCount >= 2 ? 'BODY_PREFIX_PRESENT' : 'GRAMMAR_MISS'
  }

  /**
   * One admission decision per explicit-memory entry point.
   *
   * Fields are enums, counts and booleans only: the role fact, the conversation
   * class, the blocker, the shape of the canonical text (line counts, leading-line
   * class, trust of the runtime's span claim) and the verdict. Never the text, never
   * a mention name, never an id, never an exact offset.
   */
  private emitAdmission(
    request: ExplicitMemoryRequest,
    result: 'ADMITTED' | 'CHAT' | 'SKIPPED',
    reason: string,
  ): void {
    const admitted = result === 'ADMITTED'
    const fields: DiagnosticFields = {
      role: request.requesterRole,
      conversationType: request.conversationType,
      explicitCommand: admitted,
      blocker: this.admissionBlocker(request, admitted),
      result,
      reason,
    }
    if (request.textShape !== undefined) {
      fields.canonicalized = request.textShape.canonicalized
      fields.botMentionSpanCount = request.textShape.botMentionSpanCount
      fields.botMentionSpanValid = request.textShape.botMentionSpanValid
      fields.botMentionSpanAbsent = request.textShape.botMentionSpanAbsent
      fields.userContentSpanTrust = request.textShape.userContentSpanTrust
      fields.invisibleCharacterCount = request.textShape.invisibleCharacterCount
      fields.lineCount = request.textShape.lineCount
      fields.canonicalLineCount = request.textShape.canonicalLineCount
      fields.leadingLineClass = request.textShape.leadingLineClass
      fields.leadingLineLengthBucket = request.textShape.leadingLineLengthBucket
      fields.canonicalBodyPresent = request.textShape.canonicalBodyPresent
    }
    if (request.mentionState !== undefined) {
      fields.mentionState = request.mentionState
    }
    emitDiagnostic(this.log, this.sink, MEMORY_ADMISSION_EVENT, fields)
  }

  /** Admission + buffering. Never writes memory by itself. */
  public observeHumanMessage(
    observation: MemoryObservation,
    requestDeadline?: RequestDeadline,
    msgIdToken?: string,
  ): void {
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
    this.scheduleFlush(slot, batch, trigger, requestDeadline, msgIdToken)
  }

  /** Diagnostic-only fail-closed path for an untrusted GROUP body claim. */
  public reportUntrustedUserContentSpan(role: RequesterRole): void {
    this.emit('MEMORY_TRIGGER', {
      trigger: 'NONE',
      role,
      result: 'SKIPPED',
      reason: 'USER_CONTENT_SPAN_UNTRUSTED',
    })
  }

  /**
   * Historical `RetrieveForChatAsync`, GROUP contract only, now returning the
   * CONTEXTUAL MEMORY WORKING SET.
   *
   * Order is the whole security argument and it never inverts:
   *  1. the store resolves which records this requester, this conversation and
   *     the visibility rules allow (`groupRetrievalRules` -> `MemoryStore.retrieve`).
   *     A record that is not authorized does not exist downstream;
   *  2. the budget only orders and bounds that authorized set. It does not decide
   *     relevance: there is no second model call and no lexical gate, so a memory
   *     a human would call obviously relevant cannot be filtered out by a rule;
   *  3. the final model receives ambient context, the recent conversation and this
   *     working set together, and decides which memories help answer.
   *
   * The deterministic lexical rule (`memory-relevance.ts`) is still the same rule
   * and still classifies these records for the budget ordering, but nothing in
   * this path uses it as a visibility gate any more.
   */
  public async retrieveForChat(request: MemoryReadRequest): Promise<MemoryContextItem[]> {
    // The personal scope the request would read (OWNER for an owner, MEMBER
    // otherwise); it is an enum so it is safe for both log channels.
    const scope = this.personalScope(request.requesterRole)
    const selfIdentityQuery = isCurrentSelfIdentityQuery(request.question)
    if (!this.store.isEnabled) {
      this.emit('MEMORY_READ', { scope, selfIdentityQuery, personalCount: 0, groupCount: 0, candidateCount: 0, selectedCount: 0, result: 'FAIL', reason: 'STORE_UNAVAILABLE' })
      return []
    }
    if (request.conversationType !== 'GROUP') {
      this.emit('MEMORY_READ', { scope, selfIdentityQuery, personalCount: 0, groupCount: 0, candidateCount: 0, selectedCount: 0, result: 'PASS', reason: 'DIRECT_MEMORY_DISABLED' })
      return []
    }

    const identityContext = { requesterId: request.requesterId, personalScopeType: scope }
    // Step 1: deterministic authorization/scope/visibility filtering. Everything
    // downstream of this line can only ever see records this request may read.
    const eligible = this.readableRecords(
      this.store.retrieve(this.groupRetrievalRules(request), MEMORY_ELIGIBLE_LIMIT),
    )
    const personalCount = eligible.filter((record) => scopeClassOf(record) === 'PERSONAL').length
    const groupCount = eligible.length - personalCount

    // Step 2: the budget. Small stores provide everything authorized.
    const workingSet: AuthorizedMemoryWorkingSet = buildAuthorizedMemoryWorkingSet({
      query: request.question,
      eligible,
      identityContext,
    })
    emitMemoryWorkingSet(this.log, this.sink, workingSet)

    this.emit('MEMORY_READ', {
      scope,
      selfIdentityQuery,
      personalCount,
      groupCount,
      candidateCount: workingSet.eligibleCount,
      selectedCount: workingSet.includedCount,
      result: 'PASS',
    })
    return [...workingSet.items]
  }

  /** Historical `TryHandleExplicitAsync`, OWNER-only through the trusted role. */
  public async tryHandleExplicit(request: ExplicitMemoryRequest): Promise<ExplicitMemoryResult> {
    if (!this.store.isEnabled) {
      this.emitAdmission(request, 'SKIPPED', 'STORE_UNAVAILABLE')
      this.emit('MEMORY_TRIGGER', { trigger: 'EXPLICIT_REMEMBER', role: request.requesterRole, result: 'SKIPPED', reason: 'STORE_UNAVAILABLE' })
      return { handled: false, reply: '' }
    }
    if (request.conversationType !== 'GROUP') {
      this.emitAdmission(request, 'SKIPPED', 'DIRECT_IDENTITY_UNVERIFIED')
      this.emit('MEMORY_TRIGGER', { trigger: 'EXPLICIT_REMEMBER', role: request.requesterRole, result: 'SKIPPED', reason: 'DIRECT_IDENTITY_UNVERIFIED' })
      return { handled: false, reply: '' }
    }
    if (!this.isExplicitMemoryIntent(request.requesterRole, request.question)) {
      // The previously SILENT branch. A non-owner requester and a sentence that is
      // not a command both land here, and until now neither left a trace — which is
      // why "the explicit memory command became ordinary chat" could not be
      // diagnosed from the field log at all. It now states the role, the blocker and
      // the shape of the text it judged, without the text.
      this.emitAdmission(request, 'CHAT', 'NOT_AN_EXPLICIT_COMMAND')
      return { handled: false, reply: '' }
    }
    if (!this.hasTrustedBotMention(request)) {
      // A command-shaped sentence that the runtime did not confirm as a bot mention
      // is not a command. Without this check a sentence addressed to another member
      // could be read as one: the only reason "@张三 记住我不吃香菜" is not a
      // command is that its framing belongs to someone else, and the Agent cannot
      // know that on its own.
      this.emitAdmission(request, 'CHAT', 'UNTRUSTED_BOT_MENTION_SPAN')
      this.emit('MEMORY_TRIGGER', {
        trigger: 'EXPLICIT_REMEMBER',
        role: request.requesterRole,
        result: 'SKIPPED',
        reason: 'UNTRUSTED_BOT_MENTION_SPAN',
      })
      return { handled: false, reply: '' }
    }
    if (!this.hasTrustedUserContentSpan(request)) {
      this.emitAdmission(request, 'CHAT', 'UNTRUSTED_USER_CONTENT_SPAN')
      this.emit('MEMORY_TRIGGER', {
        trigger: 'EXPLICIT_REMEMBER',
        role: request.requesterRole,
        result: 'SKIPPED',
        reason: 'UNTRUSTED_USER_CONTENT_SPAN',
      })
      return { handled: false, reply: '' }
    }
    this.emitAdmission(request, 'ADMITTED', 'EXPLICIT_COMMAND')

    const candidates = this.readableRecords(
      this.store.retrieve(this.explicitCandidateRules(request), MEMORY_FINAL_LIMIT),
    )
    let parsedMutation: MemoryMutationParseDiagnostics
    try {
      request.requestDeadline?.throwIfExpired()
      const rawMutation = await this.mutate(
        mutationSystemPrompt(),
        mutationUserPrompt(request.question, candidates),
        request.requestDeadline,
        request.msgIdToken,
      )
      request.requestDeadline?.throwIfExpired()
      parsedMutation = parseMemoryMutationDetailed(rawMutation)
    } catch (error) {
      if (isRequestDeadlineExceeded(error)) {
        throw error
      }
      this.emit('MEMORY_TRIGGER', { trigger: 'EXPLICIT_REMEMBER', role: request.requesterRole, result: 'FAIL', reason: 'MUTATION_UNAVAILABLE' })
      return { handled: true, reply: MEMORY_WRITE_FAILURE_REPLY }
    }

    const mutation = parsedMutation.mutation
    if (mutation.operation === 'NONE') {
      this.emit('MEMORY_TRIGGER', {
        trigger: 'EXPLICIT_REMEMBER',
        role: request.requesterRole,
        result: 'FAIL',
        reason: 'MUTATION_NONE',
        mutationParseResult: parsedMutation.mutationParseResult,
        mutationType: mutation.operation,
        schemaValid: parsedMutation.schemaValid,
        contentPresent: parsedMutation.contentPresent,
        contentChars: parsedMutation.contentChars,
      })
      // A NONE that reached this line came from a message that DID look like a
      // write command, so "no memory change" means the command could not be
      // resolved: the fail-closed reply is the historical behaviour and it stays.
      //
      // There is deliberately no parse-time "was this really a command?" test
      // here. Admission (`EXPLICIT_MEMORY_KEYWORDS`) is the boundary, and a
      // second pattern would be an untestable duplicate of the same list that can
      // only drift away from it — that is how "你记得不？" ended up paying for a
      // mutation call in the first place.
      return { handled: true, reply: MEMORY_WRITE_FAILURE_REPLY }
    }

    const now = this.now()
    if (mutation.operation === 'ADD') {
      // Historical scope routing: the group keywords decide GROUP, everything
      // else is the requester's own personal scope. The model's `scope` field is
      // informational only, exactly as in v02.
      const groupScoped = GROUP_SCOPE_KEYWORDS.some((keyword) => request.question.includes(keyword))
      const requestedScopeType: MemoryScopeType = groupScoped ? MEMORY_SCOPE_GROUP : this.personalScope(request.requesterRole)
      const requestedContent = normalizeContentForWrite(mutation.content ?? '', requestedScopeType, request.requesterId)
      const kind = classifyMemoryKind(requestedContent, mutation.kind)
      const subject = classifyMemorySubject(requestedScopeType, kind, mutation.subject)
      const scopeType = isRequesterLocalPreference(subject, kind)
        ? this.personalScope(request.requesterRole)
        : requestedScopeType
      const scopeId = scopeType === MEMORY_SCOPE_GROUP ? request.conversationId : request.requesterId
      const content = normalizeContentForWrite(mutation.content ?? '', scopeType, request.requesterId)
      const policyRejection = memoryKindWriteRejection(kind, subject)
      if (policyRejection !== null) {
        this.emitCandidatePolicy(subject, kind, policyRejection)
        this.emit('MEMORY_WRITE', { scope: scopeType, visibility: 'SHARED', result: 'FAIL', reason: policyRejection })
        return { handled: true, reply: MEMORY_WRITE_FAILURE_REPLY }
      }
      const rejection = validateContent(content, [request.requesterId, request.conversationId])
      if (rejection !== null) {
        this.emit('MEMORY_WRITE', { scope: scopeType, visibility: 'SHARED', result: 'FAIL', reason: rejection })
        return { handled: true, reply: MEMORY_WRITE_FAILURE_REPLY }
      }

      const status = this.store.add({
        memoryId: this.idFactory(),
        scopeType,
        subject,
        kind,
        scopeId,
        content,
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
      return { handled: true, reply: explicitAddReply(status) }
    }

    const candidate = resolveMutationTarget(mutation.target, candidates)
    if (candidate === null) {
      this.emit('MEMORY_TRIGGER', { trigger: 'EXPLICIT_REMEMBER', role: request.requesterRole, result: 'FAIL', reason: 'TARGET_NOT_FOUND' })
      return { handled: true, reply: '没找到你说的那条记忆。' }
    }

    if (mutation.operation === 'UPDATE') {
      const content = normalizeContentForWrite(mutation.content ?? '', candidate.scopeType, request.requesterId)
      const kind = classifyMemoryKind(content, mutation.kind ?? candidate.kind)
      const subject = classifyMemorySubject(candidate.scopeType, kind, mutation.subject ?? candidate.subject)
      const policyRejection = memoryKindWriteRejection(kind, subject)
      if (policyRejection !== null) {
        this.emitCandidatePolicy(subject, kind, policyRejection)
        this.emit('MEMORY_WRITE', { scope: candidate.scopeType, visibility: 'SHARED', result: 'FAIL', reason: policyRejection })
        return { handled: true, reply: MEMORY_WRITE_FAILURE_REPLY }
      }
      const rejection = validateContent(content, [request.requesterId, request.conversationId])
      if (rejection !== null) {
        this.emit('MEMORY_WRITE', { scope: candidate.scopeType, visibility: 'SHARED', result: 'FAIL', reason: rejection })
        return { handled: true, reply: MEMORY_WRITE_FAILURE_REPLY }
      }
      const updated = this.store.update(candidate.memoryId, content, now, kind, subject)
      this.emit('MEMORY_WRITE', { scope: candidate.scopeType, visibility: 'SHARED', result: updated ? 'WRITTEN' : 'FAILED' })
      this.emit('MEMORY_TRIGGER', { trigger: 'EXPLICIT_REMEMBER', role: request.requesterRole, result: updated ? 'PASS' : 'FAIL' })
      return { handled: true, reply: updated ? '改好了。' : '这条记忆没有更新成功。' }
    }

    const deleted = this.store.delete(candidate.memoryId, now)
    this.emit('MEMORY_WRITE', { scope: candidate.scopeType, visibility: 'SHARED', result: deleted ? 'WRITTEN' : 'FAILED' })
    this.emit('MEMORY_TRIGGER', { trigger: 'EXPLICIT_REMEMBER', role: request.requesterRole, result: deleted ? 'PASS' : 'FAIL' })
    return { handled: true, reply: deleted ? '忘掉了。' : '这条记忆没有删除成功。' }
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

  private scheduleFlush(
    slot: PendingSlot,
    batch: readonly BufferedEntry[],
    trigger: MemoryFlushTrigger,
    requestDeadline?: RequestDeadline,
    msgIdToken?: string,
  ): void {
    const task: Promise<void> = this.flushAsync(slot, batch, trigger, requestDeadline, msgIdToken)
    this.pendingFlushes.add(task)
    void task.finally(() => {
      this.pendingFlushes.delete(task)
    })
  }

  private async flushAsync(
    slot: PendingSlot,
    batch: readonly BufferedEntry[],
    trigger: MemoryFlushTrigger,
    requestDeadline?: RequestDeadline,
    msgIdToken?: string,
  ): Promise<void> {
    try {
      requestDeadline?.throwIfExpired()
      const candidates = await this.extractor.extract(
        'GROUP',
        batch.map((entry) => entry.message),
        requestDeadline,
        msgIdToken,
      )
      requestDeadline?.throwIfExpired()
      let written = 0
      let skipped = 0
      for (const candidate of candidates) {
        const built = this.buildAutomaticRecord(slot, candidate)
        if ('rejection' in built) {
          const kind = classifyMemoryKind(candidate.content, candidate.kind)
          const subject = classifyMemorySubject(candidate.scopeType, kind, candidate.subject)
          const policyRejection = memoryKindWriteRejection(kind, subject)
          if (policyRejection !== null) {
            this.emitCandidatePolicy(subject, kind, policyRejection)
          }
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
    const kind = classifyMemoryKind(candidate.content, candidate.kind)
    const subject = classifyMemorySubject(candidate.scopeType, kind, candidate.subject)
    const policyRejection = memoryKindWriteRejection(kind, subject)
    if (policyRejection !== null) {
      return { rejection: policyRejection }
    }

    let scopeType: MemoryScopeType
    if (isRequesterLocalPreference(subject, kind)) {
      // The semantic subject is authoritative for requester-local preferences:
      // a malformed extractor scope must not turn one person's preference into
      // a conversation-wide memory.
      scopeType = this.personalScope(slot.requesterRole)
    } else if (candidate.scopeType === MEMORY_SCOPE_GROUP) {
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

    const content = normalizeContentForWrite(candidate.content, scopeType, slot.requesterId)
    const rejection = validateContent(content, [slot.requesterId, slot.conversationId])
    if (rejection !== null) {
      return { rejection }
    }

    const now = this.now()
    return {
      record: {
        memoryId: this.idFactory(),
        scopeType,
        subject,
        kind,
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

  private readableRecords(records: readonly MemoryRecord[]): MemoryRecord[] {
    return records.filter((record) =>
      isReadableMemoryKind(record.kind, record.content, record.subject) &&
      !isDirtyRequesterLocalPreference(record),
    )
  }

  private emitCandidatePolicy(
    subject: MemorySubject,
    kind: MemoryKind,
    reason: Exclude<MemoryCandidateRejection, 'EMPTY_FACT' | 'CONTENT_TOO_LONG' | 'RAW_IDENTITY_IN_CONTENT' | 'SCOPE_NOT_ALLOWED_FOR_ROLE' | 'SCOPE_IDENTITY_MISSING'>,
  ): void {
    emitDiagnostic(this.log, this.sink, 'MEMORY_CANDIDATE_POLICY', {
      subject,
      kind,
      result: 'REJECT',
      reason,
    })
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
export function validateContent(content: string, protectedRawIdentities: readonly string[] = []): MemoryCandidateRejection | null {
  const normalized = MemoryText.normalize(content)
  if (normalized.length === 0) {
    return 'EMPTY_FACT'
  }
  if (normalized.length > MEMORY_MAX_CONTENT_CHARS) {
    return 'CONTENT_TOO_LONG'
  }
  if (
    containsRawIdentityMarker(normalized) ||
    protectedRawIdentities.some((identity) => {
      const normalizedIdentity = identity.trim()
      return normalizedIdentity.length > 0 && normalized.includes(normalizedIdentity)
    })
  ) {
    return 'RAW_IDENTITY_IN_CONTENT'
  }
  return null
}

const MEMORY_WRITE_FAILURE_REPLY = '这条记忆没有保存成功。'

function normalizeContentForWrite(content: string, scopeType: MemoryScopeType, requesterId: string): string {
  const normalized = MemoryText.normalize(content)
  return scopeType === MEMORY_SCOPE_GROUP
    ? normalized
    : normalizeCurrentRequesterSelfReference(normalized, requesterId)
}

function isRequesterLocalPreference(subject: MemorySubject, kind: MemoryKind): boolean {
  return subject === 'CURRENT_REQUESTER' && REQUESTER_LOCAL_PREFERENCE_KINDS.includes(kind)
}

function isDirtyRequesterLocalPreference(record: MemoryRecord): boolean {
  if (record.scopeType !== MEMORY_SCOPE_GROUP || record.subject !== 'CURRENT_REQUESTER') {
    return false
  }
  const kind = classifyMemoryKind(record.content, record.kind)
  return isRequesterLocalPreference(record.subject, kind)
}

function explicitAddReply(status: MemoryWriteStatus): string {
  if (status === 'WRITTEN') {
    return '记住了。'
  }
  if (status === 'SKIPPED') {
    return '已经记得了。'
  }
  return MEMORY_WRITE_FAILURE_REPLY
}

export function mutationSystemPrompt(): string {
  return (
    '你是长期记忆变更解析器。只输出一个严格 JSON 对象，不要 Markdown，不要解释，不要输出思考过程。'
    + '格式必须是：{"operation":"ADD|UPDATE|DELETE|NONE","target":"M1","subject":"CURRENT_REQUESTER|OTHER_MEMBER|GROUP|ASSISTANT","content":"...","scope":"OWNER|GROUP","kind":"SELF_FACT|ADDRESS_PREFERENCE|CONTENT_PREFERENCE|SOFT_STYLE_PREFERENCE|THIRD_PARTY_ASSERTION|ASSISTANT_RULE|ASSISTANT_IDENTITY_ASSERTION|ASSISTANT_RELATIONSHIP_ASSERTION|EPHEMERAL_CONVENTION"}；target 可为 M1 或 null。'
    + '当 userRequest 明确要求记住一个当前请求者自己的事实时，operation 必须是 ADD，target 必须是 null；'
    + '“记住我叫某个名字”“记住我是某个名字”“记住我的代号是某个代号”都属于 ADD，'
    + '此时输出示例为 {"operation":"ADD","target":null,"content":"我叫某个名字","scope":"OWNER"}；'
    + 'content 只写无身份标识的自然事实，例如“我叫某个名字”，不要写 wxid、Signature、requesterId、senderId、conversationId 或其他内部 ID。'
    + '“叫我妈妈”只能是 subject=CURRENT_REQUESTER、kind=ADDRESS_PREFERENCE；任何关于 Assistant 是谁、叫什么、是谁的亲属/主人/宠物的断言都必须标为 subject=ASSISTANT 的对应 ASSISTANT_* 类型，运行时会拒绝保存。'
    + '当前请求者自己的称呼、内容或回答风格偏好必须 subject=CURRENT_REQUESTER；“这个群/本群”的整体偏好必须 subject=GROUP。scope 字段仅供解析，运行时会按请求文本和可信 requester role 决定实际范围。'
    + '没有候选记忆不会阻止 ADD。只有无法确定是何种记忆变更时才输出 operation=NONE。'
  )
}

export function mutationUserPrompt(question: string, candidates: readonly MemoryRecord[]): string {
  const candidateText = candidates.length === 0
    ? '（无候选记忆）'
    : candidates
        .map(
          (candidate, index) =>
            `M${index + 1}: subject=${candidate.subject ?? 'CURRENT_REQUESTER'} scope=${candidate.scopeType} kind=${candidate.kind ?? 'SELF_FACT'} visibility=${candidate.visibility} content=${MemoryText.forModel(candidate.content)}`,
        )
        .join('\n')
  return `conversationType=GROUP\ntrigger=EXPLICIT_REMEMBER\ncandidates:\n${candidateText}\n\nuserRequest:\n${question}`
}

/** Historical `ParseMutation`: strict JSON object, with narrow provider-shape normalization. */
export function parseMemoryMutation(response: string): MemoryMutation {
  return parseMemoryMutationDetailed(response).mutation
}

/**
 * Parses only a JSON object (or one complete JSON markdown fence). Known
 * provider field aliases are normalized at this boundary; free-form prose and
 * reasoning are never interpreted as a mutation.
 */
export function parseMemoryMutationDetailed(response: string): MemoryMutationParseDiagnostics {
  const boundary = sanitizeMutationText(response)
  const contentPresent = boundary.length > 0
  const contentChars = boundary.length
  if (!contentPresent) {
    return {
      mutation: noneMutation(),
      mutationParseResult: 'EMPTY_RESPONSE',
      schemaValid: false,
      contentPresent,
      contentChars,
    }
  }

  let document: unknown
  try {
    document = JSON.parse(boundary) as unknown
  } catch {
    return {
      mutation: noneMutation(),
      mutationParseResult: 'INVALID_JSON',
      schemaValid: false,
      contentPresent,
      contentChars,
    }
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return {
      mutation: noneMutation(),
      mutationParseResult: 'SCHEMA_INVALID',
      schemaValid: false,
      contentPresent,
      contentChars,
    }
  }

  const record = unwrapMutationDocument(document as Record<string, unknown>)
  if (record === null) {
    return {
      mutation: noneMutation(),
      mutationParseResult: 'SCHEMA_INVALID',
      schemaValid: false,
      contentPresent,
      contentChars,
    }
  }

  const operationValue = record.operation ?? record.type
  const operation = typeof operationValue === 'string' ? operationValue.trim().toUpperCase() : ''
  if (operation !== 'ADD' && operation !== 'UPDATE' && operation !== 'DELETE' && operation !== 'NONE') {
    return {
      mutation: noneMutation(),
      mutationParseResult: 'SCHEMA_INVALID',
      schemaValid: false,
      contentPresent,
      contentChars,
    }
  }

  if (!hasValidMutationFieldTypes(record) ||
      ((operation === 'ADD' || operation === 'UPDATE') && typeof record.content !== 'string') ||
      ((operation === 'UPDATE' || operation === 'DELETE') && typeof record.target !== 'string') ||
      (record.kind !== undefined && record.kind !== null &&
        (typeof record.kind !== 'string' ||
          !MEMORY_KINDS.includes(record.kind.trim().toUpperCase() as MemoryKind))) ||
      (record.subject !== undefined && record.subject !== null &&
        (typeof record.subject !== 'string' ||
          !MEMORY_SUBJECTS.includes(record.subject.trim().toUpperCase() as MemorySubject)))) {
    return {
      mutation: noneMutation(),
      mutationParseResult: 'SCHEMA_INVALID',
      schemaValid: false,
      contentPresent,
      contentChars,
    }
  }

  const mutation: MemoryMutation = {
    operation,
    target: typeof record.target === 'string' ? record.target : null,
    content: typeof record.content === 'string' ? record.content : null,
    scope: typeof record.scope === 'string' ? record.scope : null,
    kind: typeof record.kind === 'string' && MEMORY_KINDS.includes(record.kind.trim().toUpperCase() as MemoryKind)
      ? record.kind.trim().toUpperCase() as MemoryKind
      : null,
    subject: typeof record.subject === 'string' && MEMORY_SUBJECTS.includes(record.subject.trim().toUpperCase() as MemorySubject)
      ? record.subject.trim().toUpperCase() as MemorySubject
      : null,
  }
  return {
    mutation,
    mutationParseResult: operation === 'NONE' ? 'MODEL_NONE' : 'PARSED',
    schemaValid: true,
    contentPresent,
    contentChars,
  }
}

function sanitizeMutationText(response: string): string {
  // The FINAL_ANSWER boundary applies to memory mutation parsing too: provider
  // reasoning is stripped before anything is interpreted.
  const boundary = sanitizeFinalAnswer(response)
  if (boundary.unterminatedTag) {
    return ''
  }
  const text = boundary.text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text)
  return (fenced?.[1] ?? text).trim()
}

function noneMutation(): MemoryMutation {
  return { operation: 'NONE', target: null, content: null, scope: null, kind: null, subject: null }
}

function hasValidMutationFieldTypes(record: Record<string, unknown>): boolean {
  return ['target', 'content', 'scope', 'kind', 'subject'].every((field) => {
    if (!(field in record)) {
      return true
    }
    const value = record[field]
    return value === null || typeof value === 'string'
  })
}

/** Only a single documented wrapper is accepted; arbitrary prose is rejected. */
function unwrapMutationDocument(document: Record<string, unknown>): Record<string, unknown> | null {
  if ('operation' in document || 'type' in document) {
    return document
  }
  const nested = document.mutation
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : null
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
