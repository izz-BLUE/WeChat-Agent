/**
 * FINAL-ANSWER safety guard for internal runtime labels.
 *
 * The GROUP transcript is deliberately pseudonymous: the reply model sees
 * `MEMBER_1`, `MEMBER_2`, ... instead of a requester id, and `CurrentSpeakerLabel`
 * tells it which of those labels is speaking right now. Those labels are a
 * provider-facing device only. The person on the other side of WeChat must never
 * receive them: "you are MEMBER_1" tells a user nothing true about themselves and
 * exposes runtime bookkeeping instead.
 *
 * The guard is the second line of defence behind the prompt rules:
 *  - a pseudonymous label is replaced by a natural phrase, so the sentence still
 *    works ("你就是正在和我说话的人");
 *  - a claim that the current requester *is* another member's label is refused
 *    outright, because rewriting it would invent an identity claim about the
 *    person asking;
 *  - a runtime field name, raw requester/sender/conversation id or token is never
 *    guessed away: nothing is sent.
 *  - an ungrounded self-identity answer that turns authorization into a social
 *    role is blocked for one bounded regeneration; ordinary quoted language is
 *    outside that mode.
 *
 * Like every other identity-safe diagnostic in this Agent, the guard reports kinds
 * and counts only. It never puts a detected label or raw value into a log line.
 */
import { ASSISTANT_LABEL, CURRENT_REQUESTER_LABEL } from './group-ambient-context.js'
import { isInternalSpeakerLabel } from './speaker-labels.js'

/** Why a draft was touched. Kinds are safe to log; values are not. */
export type InternalLeakKind =
  | 'SPEAKER_LABEL_CURRENT'
  | 'SPEAKER_LABEL_OTHER'
  | 'SPEAKER_LABEL_CONFLATION'
  | 'PUBLIC_DISPLAY_ALIAS'
  | 'INTERNAL_FIELD_NAME'
  | 'UNGROUNDED_IDENTITY_CLAIM'
  | 'INTERNAL_VALUE'

export interface InternalLeakCount {
  kind: InternalLeakKind
  count: number
}

export type AnswerGuardOutcome = 'CLEAN' | 'REWRITTEN' | 'BLOCKED'

export interface AnswerGuardFacts {
  /** Conversation-stable pseudonymous label of the current requester. */
  currentSpeakerLabel?: string
  /** Every pseudonymous label that appears in this conversation's transcript. */
  speakerLabels?: readonly string[]
  /** Runtime-only raw values (requester id, sender id, conversation id, tokens). */
  internalValues?: readonly string[]
  /** Grounding facts for the narrow current-requester identity path. */
  selfIdentityQuery?: boolean
  retrievedPersonalMemoryCount?: number
  /** Exact provider-only duplicate-name labels generated for this prompt. */
  publicDisplayAliases?: readonly PublicDisplayAlias[]
}

/** A generated duplicate-name label and the safe public name it may collapse to. */
export interface PublicDisplayAlias {
  rendered: string
  publicName: string
}

export interface AnswerGuardResult {
  /** Sendable text. Empty exactly when the outcome is BLOCKED. */
  text: string
  outcome: AnswerGuardOutcome
  detections: readonly InternalLeakCount[]
  /**
   * A provider re-generation may still produce a safe answer from this draft.
   * False when nothing may be sent to any provider either: a raw identity value
   * is not provider-safe material, not even for a rewrite request.
   */
  regenerable: boolean
}

/**
 * Runtime-only field names the prompt uses to state trusted facts. Seeing one in a
 * reply means the model answered in runtime vocabulary instead of talking to a
 * person.
 */
export const INTERNAL_FIELD_NAMES = [
  'CurrentSpeakerLabel',
  'CurrentRequesterRole',
  'CurrentBotMentioned',
  'OwnerConfigured',
  'RequesterId',
  'SenderId',
  'OwnerId',
  'requesterToken',
  'senderToken',
  'conversationToken',
  'scopeId',
  'scopeKey',
  'memoryId',
  'contentHash',
  'scopeType',
] as const

/**
 * A raw value is only blanked when it is long enough to be a real runtime
 * identifier. Anything shorter is indistinguishable from ordinary text, and
 * guessing there would mangle legitimate replies.
 */
export const MIN_INTERNAL_VALUE_LENGTH = 6

/** Natural phrase used where the current requester's label was rendered. */
export const CURRENT_SPEAKER_PHRASE = '正在和我说话的人'

/** Natural phrase used where another member's label was rendered. */
export const OTHER_MEMBER_PHRASE = '群里的另一位成员'

/**
 * Pseudonymous label shape, matched even when this conversation never used it.
 *
 * `AMBIENT_SPEAKER` must stay ahead of `SPEAKER` in the alternation: the ambient
 * namespace is a distinct one, and a match that started one character later would
 * leave a bare `AMBIENT_` behind in the reply.
 */
const SPEAKER_LABEL_PATTERN = /(?:AMBIENT_SPEAKER|MEMBER|SPEAKER)_\d+/gi

/** Natural phrase used where the bot's own ambient label was rendered. */
export const ASSISTANT_SELF_PHRASE = '我'

const FIELD_ALTERNATION = INTERNAL_FIELD_NAMES.join('|')
const FIELD_PREFIX_PATTERN = new RegExp(`(?:${FIELD_ALTERNATION})\\s*[=:：]\\s*`, 'gi')
const FIELD_ANY_PATTERN = new RegExp(`(?:${FIELD_ALTERNATION})`, 'i')

/** These terms are unsafe only for an ungrounded self-identity answer. */
const UNGROUNDED_IDENTITY_CLAIM_PATTERN = /主人|群主|管理员|老板/gu

const DETECTION_ORDER: readonly InternalLeakKind[] = [
  'SPEAKER_LABEL_CURRENT',
  'SPEAKER_LABEL_OTHER',
  'SPEAKER_LABEL_CONFLATION',
  'PUBLIC_DISPLAY_ALIAS',
  'INTERNAL_FIELD_NAME',
  'UNGROUNDED_IDENTITY_CLAIM',
  'INTERNAL_VALUE',
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) {
    return 0
  }
  let count = 0
  let index = text.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = text.indexOf(needle, index + needle.length)
  }
  return count
}

function replaceGeneratedPublicDisplayAliases(
  text: string,
  aliases: readonly PublicDisplayAlias[] | undefined,
): { text: string; replaced: number } {
  const isWordScalar = (value: string | undefined): boolean => value !== undefined && /[\p{L}\p{N}]/u.test(value)
  const candidates = [...(aliases ?? [])]
    .filter((alias) => alias.rendered.length > 0 && alias.publicName.length > 0)
    .sort((left, right) => right.rendered.length - left.rendered.length)

  // Scan the original draft once. Replacements are never rescanned, so a real
  // public name containing another alias cannot be modified by a later pass.
  let cursor = 0
  let replaced = 0
  let normalized = ''
  while (cursor < text.length) {
    const alias = candidates.find((candidate) => text.startsWith(candidate.rendered, cursor))
    if (alias === undefined) {
      normalized += text[cursor]
      cursor++
      continue
    }

    normalized += alias.publicName
    const following = [...text.slice(cursor + alias.rendered.length)][0]
    const lastPublicScalar = [...alias.publicName].at(-1)
    if (isWordScalar(lastPublicScalar) && isWordScalar(following)) normalized += ' '
    cursor += alias.rendered.length
    replaced++
  }
  return { text: normalized, replaced }
}

function sameLabel(left: string, right: string): boolean {
  return left.length > 0 && left.toLowerCase() === right.toLowerCase()
}

/**
 * True when the text makes the *current* requester the owner of another member's
 * label ("你就是 MEMBER_1"). That is a misattribution, not a cosmetic leak: the
 * person asking is being handed somebody else's identity.
 */
function claimsCurrentIsOther(text: string, label: string): boolean {
  const pattern = escapeRegExp(label)
  return (
    new RegExp(`(你|您)(就)?是\\s*${pattern}`, 'iu').test(text) ||
    new RegExp(`${pattern}\\s*(就是|是)\\s*(你|您)`, 'iu').test(text)
  )
}

interface LabelRewrite {
  text: string
  rewritten: number
}

/** Replaces the current requester's label with a natural self-reference. */
function rewriteCurrentLabel(text: string, label: string): LabelRewrite {
  const pattern = escapeRegExp(label)
  let rewritten = 0

  let next = text.replace(
    new RegExp(`(你|您)(就)?是\\s*${pattern}`, 'gu'),
    (_match: string, who: string, emphasis: string | undefined) => {
      rewritten += 1
      return `${who}${emphasis ?? ''}是${CURRENT_SPEAKER_PHRASE}`
    },
  )

  next = next.replace(new RegExp(`\\s*${pattern}\\s*`, 'gu'), () => {
    rewritten += 1
    return '你'
  })

  return { text: next, rewritten }
}

/** Replaces another member's label with a natural third-person reference. */
function rewriteOtherLabel(text: string, label: string): LabelRewrite {
  let rewritten = 0
  const next = text.replace(new RegExp(`\\s*${escapeRegExp(label)}\\s*`, 'gu'), () => {
    rewritten += 1
    return OTHER_MEMBER_PHRASE
  })
  return { text: next, rewritten }
}

/**
 * Replaces one ambient-transcript label with a natural phrase.
 *
 * The ambient labels are resolved before the pseudonym loop, and by meaning
 * rather than by position: `CURRENT_REQUESTER` is the person asking, so a
 * third-person rewrite would misattribute their own words, and `ASSISTANT` is
 * this bot, not "another member".
 */
function rewriteAmbientLabel(text: string, label: string, phrase: string): LabelRewrite {
  let rewritten = 0
  const next = text.replace(new RegExp(`\\s*${escapeRegExp(label)}\\s*`, 'gu'), () => {
    rewritten += 1
    return phrase
  })
  return { text: next, rewritten }
}

/**
 * Inspects a final answer and returns the text that may be sent.
 *
 * `CLEAN` returns the draft untouched (trimmed); `REWRITTEN` returns a safe
 * rewrite; `BLOCKED` returns an empty text, which the caller must treat as "send
 * nothing" rather than as "send the original".
 */
export function guardFinalAnswer(input: string, facts: AnswerGuardFacts = {}): AnswerGuardResult {
  const counts = new Map<InternalLeakKind, number>()
  const bump = (kind: InternalLeakKind, count = 1): void => {
    if (count <= 0) {
      return
    }
    counts.set(kind, (counts.get(kind) ?? 0) + count)
  }

  const current = (facts.currentSpeakerLabel ?? '').trim()
  const registered = new Set<string>()
  for (const candidate of [...(facts.speakerLabels ?? []), current]) {
    const label = candidate.trim()
    if (isInternalSpeakerLabel(label)) {
      registered.add(label)
    }
  }

  const internalValues = [...new Set((facts.internalValues ?? []).map((value) => value.trim()))].filter(
    (value) => value.length >= MIN_INTERNAL_VALUE_LENGTH,
  )

  let text = input
  let blocked = false
  let regenerable = true

  // Only exact aliases emitted by this turn's presentation are collapsed. This
  // is a deterministic provider-only cleanup, not a regex guess about names.
  const aliases = replaceGeneratedPublicDisplayAliases(text, facts.publicDisplayAliases)
  if (aliases.replaced > 0) {
    bump('PUBLIC_DISPLAY_ALIAS', aliases.replaced)
    text = aliases.text
  }

  // Ambient-section labels first, and by meaning: they are runtime vocabulary with
  // a known referent, so they resolve to a natural phrase instead of being folded
  // into the pseudonym loop, where `CURRENT_REQUESTER` would have been rewritten
  // as "another member" — the exact misattribution this guard exists to prevent.
  const requesterLabel = rewriteAmbientLabel(text, CURRENT_REQUESTER_LABEL, CURRENT_SPEAKER_PHRASE)
  if (requesterLabel.rewritten > 0) {
    bump('SPEAKER_LABEL_CURRENT', requesterLabel.rewritten)
    text = requesterLabel.text
  }
  const assistantLabel = rewriteAmbientLabel(text, ASSISTANT_LABEL, ASSISTANT_SELF_PHRASE)
  if (assistantLabel.rewritten > 0) {
    bump('SPEAKER_LABEL_OTHER', assistantLabel.rewritten)
    text = assistantLabel.text
  }

  // A raw identity value is never rewritten into a guess and never handed back to
  // a provider: the whole reply fails closed, exactly like an unterminated
  // thinking tag does at the FINAL_ANSWER boundary.
  for (const value of internalValues) {
    const occurrences = countOccurrences(text, value)
    if (occurrences > 0) {
      bump('INTERNAL_VALUE', occurrences)
      blocked = true
      regenerable = false
    }
  }

  const labels = new Set<string>(registered)
  for (const match of text.matchAll(SPEAKER_LABEL_PATTERN)) {
    labels.add(match[0])
  }

  // Longest first: overlapping label spellings can never shadow a longer one.
  for (const label of [...labels].sort((left, right) => right.length - left.length)) {
    if (sameLabel(label, current)) {
      const rewrite = rewriteCurrentLabel(text, label)
      text = rewrite.text
      bump('SPEAKER_LABEL_CURRENT', rewrite.rewritten)
      continue
    }

    if (claimsCurrentIsOther(text, label)) {
      // Misattribution: the label is still removed so nothing can leak, but the
      // sentence is not sent either.
      const rewrite = rewriteOtherLabel(text, label)
      text = rewrite.text
      bump('SPEAKER_LABEL_CONFLATION', rewrite.rewritten)
      blocked = true
      continue
    }

    const rewrite = rewriteOtherLabel(text, label)
    text = rewrite.text
    bump('SPEAKER_LABEL_OTHER', rewrite.rewritten)
  }

  // Runtime vocabulary: a `Field=value` prefix can be dropped safely, a bare field
  // name inside a sentence cannot be turned back into human language.
  const prefixed = [...text.matchAll(FIELD_PREFIX_PATTERN)].length
  if (prefixed > 0) {
    bump('INTERNAL_FIELD_NAME', prefixed)
    text = text.replace(FIELD_PREFIX_PATTERN, '')
  }
  if (FIELD_ANY_PATTERN.test(text)) {
    bump('INTERNAL_FIELD_NAME')
    blocked = true
  }

  if (facts.selfIdentityQuery === true && facts.retrievedPersonalMemoryCount === 0) {
    // Public names are presentation metadata, never an exemption for the
    // fail-closed self-identity boundary. A name such as 管理员 must not make
    // "我是管理员" or "你是主人" acceptable here.
    const claims = [...text.matchAll(UNGROUNDED_IDENTITY_CLAIM_PATTERN)].length
    if (claims > 0) {
      bump('UNGROUNDED_IDENTITY_CLAIM', claims)
      blocked = true
    }
  }

  // Re-scan: nothing rewritten above may survive, and nothing may be re-created by
  // the replacements themselves. The module-level pattern is stateful (`g`), so
  // its position is reset first: a stale `lastIndex` from an earlier reply would
  // let a label through the very check that exists to stop it.
  SPEAKER_LABEL_PATTERN.lastIndex = 0
  if (SPEAKER_LABEL_PATTERN.test(text)) {
    bump('SPEAKER_LABEL_OTHER')
    blocked = true
  }
  for (const value of internalValues) {
    if (text.includes(value)) {
      blocked = true
      regenerable = false
    }
  }

  const detections = DETECTION_ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0).map<InternalLeakCount>(
    (kind) => ({ kind, count: counts.get(kind) ?? 0 }),
  )
  const trimmed = text.trim()

  // An empty draft is not sendable either: the guard never turns "nothing" into a
  // reply, and the caller already fails closed on an empty FINAL_ANSWER.
  if (blocked || trimmed.length === 0) {
    return { text: '', outcome: 'BLOCKED', detections, regenerable }
  }

  return detections.length > 0
    ? { text: trimmed, outcome: 'REWRITTEN', detections, regenerable }
    : { text: trimmed, outcome: 'CLEAN', detections, regenerable }
}

/** Diagnostics form: kinds and counts only, never a detected value. */
export function formatGuardDetections(detections: readonly InternalLeakCount[]): string {
  return detections.length === 0 ? 'NONE' : detections.map((entry) => `${entry.kind}:${entry.count}`).join('|')
}
