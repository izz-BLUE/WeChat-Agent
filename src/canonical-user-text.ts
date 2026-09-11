/**
 * CANONICAL USER TEXT — the one projection of an inbound contract message into
 * the text the Agent treats as "what the user said".
 *
 * WHY THIS EXISTS. The contract carries no canonical body: the runtime hands the
 * raw WeChat body through verbatim (`message.Content`) and the Agent's normalizer
 * only trims it. The group mention envelope — `@` + a display name + U+2005
 * (FOUR-PER-EM SPACE), the character WeChat's own @ picker writes and a keyboard
 * cannot produce — is the one piece of framing that has to come off before a
 * command can be read. `LegacyMentionClassifier` documents that the token is
 * POSITION INDEPENDENT: "a real mention may open the message, sit inside a
 * sentence, close it, or land on any line of a multi-line body".
 *
 * WHY IT NEEDS THE RUNTIME'S SPANS. U+2005 marks a real mention, but it does not
 * say WHOSE. A body may mention another member, the bot, or both, and the visible
 * name proves nothing: a member may be named like the bot, and the bot may be
 * renamed in the group. Stripping every `@name\u2005` therefore deletes real user
 * content — and, worse, can turn a sentence addressed to a member into a command:
 *
 *   raw:      "@张三\u2005记住我不吃香菜\n@bot\u2005你怎么看"
 *   global:   "记住我不吃香菜\n你怎么看"      <- the first line now opens a command
 *
 * So the ids to remove come from the runtime, which is the only party that knows
 * which tokens are the bot's: `botMentionSpans`, computed by the same single scan
 * that decides the mention state (see `MentionSpan` in the C# runtime). This module
 * removes exactly those spans and nothing else. A member mention survives, and a
 * text that was not a command cannot become one.
 *
 * WHAT IT IS NOT. No name matching (the Agent is never told the bot's group display
 * name and must not guess it), no mention regex of its own, no natural-language
 * understanding. The work is: validate the spans, delete them back to front, and
 * normalize line structure.
 *
 * FAIL CLOSED. Missing, malformed or out-of-range spans leave the text alone
 * (newline normalization only) and are reported as untrusted. Chat still works; a
 * persistent-memory side effect does not — see `MemoryService.tryHandleExplicit`.
 */

/** The mention separator WeChat's @ picker writes: U+2005 FOUR-PER-EM SPACE. */
export const MENTION_SEPARATOR = '\u2005'

/**
 * Invisible formatting characters — zero-width space, non-joiner, joiner, word
 * joiner and the BOM. They carry no user-visible content, JavaScript `trim()`
 * does NOT treat them as whitespace, and a client that pads a removed token would
 * otherwise leave a "first line" that looks empty in the UI and is not empty to
 * the command gate.
 */
const INVISIBLE = '\\u200b\\u200c\\u200d\\u2060\\ufeff'

/** Trim a line of whitespace AND invisible padding. */
const LINE_EDGE = new RegExp(`^[\\s${INVISIBLE}]+|[\\s${INVISIBLE}]+$`, 'gu')

const ANY_INVISIBLE = new RegExp(`[${INVISIBLE}]`, 'gu')

/** Contract shape the runtime guarantees for a removal span. */
export interface BotMentionSpan {
  /** UTF-16 code unit offset into the RAW body. */
  start: number
  /** UTF-16 code unit length of the token. */
  length: number
}

/**
 * Whether the runtime's span claim can be used.
 *
 * `VALID` — structurally coherent spans, verified against the raw body.
 * `INVALID` — the runtime made a claim that does not hold; the text is left intact
 *   and every side effect that would depend on framing is refused.
 * `ABSENT` — an older runtime that makes no claim at all. Chat proceeds; memory
 *   side effects do not.
 */
export type BotMentionSpanTrust = 'VALID' | 'INVALID' | 'ABSENT'

export interface BotMentionSpanFacts {
  trust: BotMentionSpanTrust
  spans: readonly BotMentionSpan[]
}

export const ABSENT_BOT_MENTION_SPANS: BotMentionSpanFacts = { trust: 'ABSENT', spans: [] }

/** Trusted suffix coordinates published by the runtime for GROUP framing. */
export interface UserContentSpan {
  /** UTF-16 code unit offset into the RAW body. */
  start: number
  /** UTF-16 code unit length of the trusted user suffix. */
  length: number
}

export type UserContentSpanTrust = 'VALID' | 'INVALID' | 'ABSENT'

export interface UserContentSpanFacts {
  trust: UserContentSpanTrust
  span: UserContentSpan | null
}

export const ABSENT_USER_CONTENT_SPAN: UserContentSpanFacts = { trust: 'ABSENT', span: null }

export interface UserTextShape {
  /** Lines in the raw body, as the runtime delivered it. */
  lineCount: number
  /** Lines in the canonical text after the projection. */
  canonicalLineCount: number
  /**
   * Character class of the FIRST canonical line.
   *
   * The field failure this exists for: a body whose line before the command is not
   * empty reaches the anchored command gate with that line still attached, and the
   * verdict is "not a command" — indistinguishable from a sentence that simply has
   * no command shape. The class separates a machine-looking prefix (`ASCII_ONLY`:
   * ids, brackets, latin framing) from natural language (`CJK_ONLY`: a quoted
   * Chinese message, a nickname line), which is the one question the available field
   * evidence could not answer. It is a coarse class over characters, never a
   * substring: no text ever reaches a log.
   */
  leadingLineClass: LeadingLineClass
  /** Coarse length bucket of that line. Never an exact length. */
  leadingLineLengthBucket: LeadingLineLengthBucket
  /** Bot mention spans the runtime claimed. */
  botMentionSpanCount: number
  /** True when the claim was structurally usable. */
  botMentionSpanValid: boolean
  /** True when the claim was absent (older runtime). */
  botMentionSpanAbsent: boolean
  /** Whether the runtime's trusted GROUP user-content suffix claim is usable. */
  userContentSpanTrust: UserContentSpanTrust
  /** Invisible formatting characters found (padding, not content). */
  invisibleCharacterCount: number
  /** True when the projection changed the text at all. */
  canonicalized: boolean
  /** False when nothing user-visible is left. */
  canonicalBodyPresent: boolean
}

/** What the first canonical line is made of. */
export type LeadingLineClass = 'NONE' | 'ASCII_ONLY' | 'CJK_ONLY' | 'MIXED'

/** Coarse size of the first canonical line; buckets, never the length itself. */
export type LeadingLineLengthBucket = 'NONE' | 'SHORT' | 'MEDIUM' | 'LONG'

/**
 * Validates the runtime's span claim against the raw body.
 *
 * A span must be inside the body, non-empty, non-overlapping, ascending, and cover
 * the contract's token shape (`@` … picker separator). That last check is a
 * structural integrity check of the TOKEN, never of the name: the Agent does not
 * know the bot's display name and does not try to learn it.
 *
 * Never throws, never repairs, never widens: one bad span makes the whole claim
 * `INVALID`, because a partially trusted framing removal is exactly the failure
 * mode this contract exists to prevent.
 */
export function resolveUserContentSpan(raw: string, wire: unknown): UserContentSpanFacts {
  if (wire === null || wire === undefined) {
    return ABSENT_USER_CONTENT_SPAN
  }
  if (typeof wire !== 'object' || Array.isArray(wire)) {
    return { trust: 'INVALID', span: null }
  }
  const record = wire as Record<string, unknown>
  const start = record.start
  const length = record.length
  if (typeof start !== 'number' || typeof length !== 'number' ||
      !Number.isInteger(start) || !Number.isInteger(length) ||
      start < 0 || length < 0) {
    return { trust: 'INVALID', span: null }
  }
  const end = start + length
  if (end > raw.length || end !== raw.length) {
    return { trust: 'INVALID', span: null }
  }
  return { trust: 'VALID', span: { start, length } }
}

export function resolveBotMentionSpans(
  raw: string,
  wire: unknown,
  userContentSpan: UserContentSpanFacts = ABSENT_USER_CONTENT_SPAN,
): BotMentionSpanFacts {
  if (wire === null || wire === undefined) {
    return ABSENT_BOT_MENTION_SPANS
  }
  if (!Array.isArray(wire)) {
    return { trust: 'INVALID', spans: [] }
  }
  if (wire.length === 0) {
    // A coherent claim of "no bot token in this body".
    return { trust: 'VALID', spans: [] }
  }

  const spans: BotMentionSpan[] = []
  let previousEnd = -1
  for (const entry of wire) {
    if (typeof entry !== 'object' || entry === null) {
      return { trust: 'INVALID', spans: [] }
    }
    const record = entry as Record<string, unknown>
    const start = record.start
    const length = record.length
    if (typeof start !== 'number' || typeof length !== 'number') {
      return { trust: 'INVALID', spans: [] }
    }
    if (!Number.isInteger(start) || !Number.isInteger(length)) {
      return { trust: 'INVALID', spans: [] }
    }
    if (start < 0 || length <= 0 || start + length > raw.length) {
      return { trust: 'INVALID', spans: [] }
    }
    if (userContentSpan.trust === 'VALID' && userContentSpan.span !== null) {
      const bodyStart = userContentSpan.span.start
      const bodyEnd = bodyStart + userContentSpan.span.length
      if (start < bodyStart || start + length > bodyEnd) {
        return { trust: 'INVALID', spans: [] }
      }
    }
    if (start < previousEnd) {
      // Overlapping or unordered spans cannot be removed independently.
      return { trust: 'INVALID', spans: [] }
    }
    const token = raw.slice(start, start + length)
    if (!isMentionTokenShape(token)) {
      return { trust: 'INVALID', spans: [] }
    }
    spans.push({ start, length })
    previousEnd = start + length
  }

  return { trust: 'VALID', spans }
}

/**
 * The contract's token shape: leading `@`, at least one name character, and the
 * picker separator closing the name (optionally through invisible padding).
 */
function isMentionTokenShape(token: string): boolean {
  if (!token.startsWith('@')) {
    return false
  }
  const body = token.slice(1).replace(ANY_INVISIBLE, '')
  const separator = body.indexOf(MENTION_SEPARATOR)
  if (separator <= 0) {
    return false
  }
  // Everything after the first separator must be padding only: the span is the
  // token, not the text behind it.
  return body.slice(separator + 1).trim().length === 0
}

/**
 * The user-visible body of one inbound message. Never the raw transport text.
 *
 * With a trusted claim, exactly the bot's tokens are removed; without one, the body
 * is passed through with newline normalization only, so no user content is ever
 * deleted on a guess.
 */
export function canonicalUserText(
  raw: string,
  facts: BotMentionSpanFacts = ABSENT_BOT_MENTION_SPANS,
  userContentSpan: UserContentSpanFacts = ABSENT_USER_CONTENT_SPAN,
): string {
  const body = userContentSpan.trust === 'VALID' && userContentSpan.span !== null
    ? raw.slice(userContentSpan.span.start, userContentSpan.span.start + userContentSpan.span.length)
    : raw
  const rebasedSpans = userContentSpan.trust === 'VALID' && userContentSpan.span !== null
    ? facts.spans.map((span) => ({ start: span.start - userContentSpan.span!.start, length: span.length }))
    : facts.spans
  const projected = facts.trust === 'VALID' ? removeSpans(body, rebasedSpans) : body
  const normalized = normalizeNewlines(projected)
  const withoutTokens = normalized
  return withoutTokens
    .split('\n')
    .map((line) => line.replace(LINE_EDGE, ''))
    .filter((line) => line.length > 0)
    .join('\n')
}

/** Removes spans from the END backwards so earlier offsets stay valid. */
function removeSpans(text: string, spans: readonly BotMentionSpan[]): string {
  let result = text
  const ordered = [...spans].sort((left, right) => right.start - left.start)
  for (const span of ordered) {
    result = result.slice(0, span.start) + result.slice(span.start + span.length)
  }
  return result
}

/**
 * Structural facts about one projection, for diagnostics.
 *
 * Booleans and counts only: no body text, no mention name, no conversation. This is
 * what makes an admission decision answerable from the field log alone.
 */
export function describeUserText(
  raw: string,
  facts: BotMentionSpanFacts = ABSENT_BOT_MENTION_SPANS,
  userContentSpan: UserContentSpanFacts = ABSENT_USER_CONTENT_SPAN,
): UserTextShape {
  const normalized = normalizeNewlines(raw)
  const canonical = canonicalUserText(raw, facts, userContentSpan)
  const canonicalLines = canonical.length === 0 ? [] : canonical.split('\n')
  const leadingLine = canonicalLines[0] ?? ''
  return {
    lineCount: normalized.length === 0 ? 0 : normalized.split('\n').length,
    canonicalLineCount: canonicalLines.length,
    leadingLineClass: classifyLeadingLine(leadingLine),
    leadingLineLengthBucket: bucketLeadingLine(leadingLine),
    botMentionSpanCount: facts.spans.length,
    botMentionSpanValid: facts.trust === 'VALID',
    botMentionSpanAbsent: facts.trust === 'ABSENT',
    userContentSpanTrust: userContentSpan.trust,
    invisibleCharacterCount: (normalized.match(ANY_INVISIBLE) ?? []).length,
    canonicalized: canonical !== raw,
    canonicalBodyPresent: canonical.length > 0,
  }
}

/**
 * Coarse character class of one line: ASCII-only, CJK-only, or a mix.
 *
 * Punctuation, spaces and emoji are neutral and do not by themselves make a line
 * "mixed", so a pure-Chinese quoted line with a colon stays CJK_ONLY while an id or
 * a bracketed transport marker reads ASCII_ONLY. This is a class, not a value.
 */
function classifyLeadingLine(line: string): LeadingLineClass {
  if (line.length === 0) {
    return 'NONE'
  }
  let ascii = false
  let cjk = false
  for (const character of line) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x80) {
      if (/[A-Za-z0-9]/u.test(character)) {
        ascii = true
      }
      continue
    }
    if ((code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)) {
      cjk = true
    }
  }
  if (ascii && cjk) {
    return 'MIXED'
  }
  return ascii ? 'ASCII_ONLY' : cjk ? 'CJK_ONLY' : 'MIXED'
}

/** Buckets only: the operator needs "a short machine marker or a long quoted line". */
function bucketLeadingLine(line: string): LeadingLineLengthBucket {
  if (line.length === 0) {
    return 'NONE'
  }
  if (line.length < 8) {
    return 'SHORT'
  }
  return line.length < 32 ? 'MEDIUM' : 'LONG'
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/gu, '\n')
}
