/**
 * Conservative presentation normalization for a final chat answer.
 * Semantic content, bullets, URLs, source ids and fenced code blocks are kept.
 */

export function renderHumanChat(answer: string): string {
  const trimmed = answer.trim()
  if (trimmed.length === 0) {
    return ''
  }

  const lines = splitLines(trimmed)
  const output: string[] = []
  let inCodeBlock = false
  let blankLines = 0

  for (const line of lines) {
    if (isFence(line.content)) {
      inCodeBlock = !inCodeBlock
      output.push(line.content + line.eol)
      blankLines = 0
      continue
    }

    if (inCodeBlock) {
      output.push(line.content + line.eol)
      continue
    }

    const normalized = normalizePresentationLine(line.content)
    if (normalized.trim().length === 0) {
      blankLines += 1
      if (blankLines <= 1) {
        output.push(normalized + line.eol)
      }
      continue
    }

    blankLines = 0
    output.push(normalized + line.eol)
  }

  return output.join('').trim()
}

export const YEYE_REPLY_SIGNATURE = '🌴˙ᵕ˙'

const SENTENCE_ENDINGS = new Set(['。', '！', '？', '!', '?', '.'])

export type GroupReplyResponseDepth = 'SHORT' | 'NORMAL' | 'DETAILED'
export type GroupReplyPressure = 'LOW' | 'MEDIUM' | 'HIGH'
export type GroupBulkOutputKind =
  | 'NONE'
  | 'FENCED_CODE'
  | 'STRUCTURED_MARKUP'
  | 'JSON'
  | 'SQL'
  | 'LOG'
  | 'BASE64'
  | 'CODE_DENSE'
export type GroupBulkOutputResult = 'PASS' | 'BLOCKED'
export type GroupReplyBoundaryType =
  | 'NONE'
  | 'PARAGRAPH'
  | 'SENTENCE'
  | 'BULK_OUTPUT_BLOCKED'
  | 'SOCIAL_LIMIT'

export const GROUP_CODE_MAX_CHARS = 800
export const GROUP_CODE_MAX_LINES = 24
export const GROUP_CODE_MAX_BLOCKS = 2
export const GROUP_STRUCTURED_MAX_CHARS = 900
export const GROUP_BASE64_MIN_CHARS = 384
export const GROUP_BULK_OUTPUT_FALLBACK = '这段内容太长，不直接在群里刷屏。可以问我具体实现点，我给关键片段。'

export interface GroupReplyPresentationPolicy {
  responseDepth: GroupReplyResponseDepth
  groupReplyPressure: GroupReplyPressure
}

export interface GroupReplyBoundaryResult {
  text: string
  beforeChars: number
  afterChars: number
  bounded: boolean
  boundaryType: GroupReplyBoundaryType
  bulkOutput?: GroupBulkOutputBoundaryResult
  socialOutput?: GroupSocialOutputBoundaryResult
}

export interface GroupBulkOutputBoundaryResult {
  text: string
  beforeChars: number
  afterChars: number
  beforeLines: number
  codeBlockCount: number
  kind: GroupBulkOutputKind
  detected: boolean
  result: GroupBulkOutputResult
  reason: 'NONE' | 'GROUP_STRUCTURED_OUTPUT_LIMIT'
}

/**
 * Presentation-only budgets for ordinary group replies. They are deliberately
 * generous enough for a useful answer, while making a runaway story stop at a
 * complete natural boundary. SHORT/NORMAL are pressure-dependent; DETAILED is
 * governed by the separate GROUP social output boundary, which bounds it
 * instead of bypassing the length check.
 */
export const GROUP_REPLY_LENGTH_BUDGETS = Object.freeze({
  SHORT: Object.freeze({ HIGH: 120, MEDIUM: 160, LOW: 200 }),
  NORMAL: Object.freeze({ HIGH: 240, MEDIUM: 360, LOW: 480 }),
})

/**
 * Apply the deterministic anti-flood boundary before ordinary group reply
 * presentation. The classifier only inspects the final answer payload; it
 * never uses the user's request text or an LLM decision.
 */
export function boundGroupBulkOutput(text: string): GroupBulkOutputBoundaryResult {
  const beforeChars = text.length
  const normalized = text.trim()
  const beforeLines = normalized.length === 0 ? 0 : splitLines(normalized).length
  const metrics = inspectBulkOutput(normalized)
  if (metrics.kind === 'NONE') {
    return {
      text: normalized,
      beforeChars,
      afterChars: normalized.length,
      beforeLines,
      codeBlockCount: metrics.codeBlockCount,
      kind: 'NONE',
      detected: false,
      result: 'PASS',
      reason: 'NONE',
    }
  }

  return {
    text: GROUP_BULK_OUTPUT_FALLBACK,
    beforeChars,
    afterChars: GROUP_BULK_OUTPUT_FALLBACK.length,
    beforeLines,
    codeBlockCount: metrics.codeBlockCount,
    kind: metrics.kind,
    detected: true,
    result: 'BLOCKED',
    reason: 'GROUP_STRUCTURED_OUTPUT_LIMIT',
  }
}

/**
 * Apply ordinary group presentation after the anti-flood boundary. Bulk
 * output is replaced as a whole, so no structured payload is ever cut in the
 * middle or sent in multiple messages.
 */
export function boundGroupReply(
  text: string,
  policy: GroupReplyPresentationPolicy,
): GroupReplyBoundaryResult {
  const beforeChars = text.length
  const normalized = text.trim()
  const bulkOutput = boundGroupBulkOutput(text)
  if (normalized.length === 0) {
    return { text: normalized, beforeChars, afterChars: normalized.length, bounded: false, boundaryType: 'NONE', bulkOutput }
  }

  if (bulkOutput.result === 'BLOCKED') {
    return {
      text: bulkOutput.text,
      beforeChars,
      afterChars: bulkOutput.text.length,
      bounded: true,
      boundaryType: 'BULK_OUTPUT_BLOCKED',
      bulkOutput,
    }
  }

  if (policy.responseDepth === 'DETAILED') {
    // DETAILED is a wider social budget, not an unbounded bypass: the same
    // deterministic social hard cap applies to it.
    const social = boundGroupSocialOutput(normalized, 'DETAILED')
    return {
      text: social.text,
      beforeChars,
      afterChars: social.afterChars,
      bounded: social.bounded,
      boundaryType: social.bounded ? 'SOCIAL_LIMIT' : 'NONE',
      bulkOutput,
      socialOutput: social,
    }
  }

  const pressure = policy.groupReplyPressure
  const budget = GROUP_REPLY_LENGTH_BUDGETS[policy.responseDepth][pressure]
  if (normalized.length <= budget) {
    return { text: normalized, beforeChars, afterChars: normalized.length, bounded: false, boundaryType: 'NONE', bulkOutput }
  }

  const boundary = findSafeBoundary(normalized, budget)
  if (boundary === null) {
    return { text: normalized, beforeChars, afterChars: normalized.length, bounded: false, boundaryType: 'NONE', bulkOutput }
  }

  const boundedText = normalized.slice(0, boundary.end).trimEnd()
  if (!preservesSourceMarkers(normalized, boundedText)) {
    return { text: normalized, beforeChars, afterChars: normalized.length, bounded: false, boundaryType: 'NONE', bulkOutput }
  }
  return {
    text: boundedText,
    beforeChars,
    afterChars: boundedText.length,
    bounded: true,
    boundaryType: boundary.type,
    bulkOutput,
  }
}

/**
 * GROUP Social Output Boundary.
 *
 * WeChat groups are a social space: one natural-language reply must not fill
 * several screens. Structured payloads are already replaced as a whole by the
 * bulk boundary above; this layer bounds the ordinary natural-language reply.
 * It is a readability budget, not a transport capability budget, and no request
 * wording ("详细说", "写一章", "分段发") can lift the hard cap. The truncation
 * is deterministic: paragraph boundary, then sentence boundary, then a
 * code-point-safe cut, closed by one fixed short tail line.
 */
export type GroupSocialOutputDepth = 'NORMAL' | 'DETAILED'
export type GroupSocialOutputResult = 'PASS' | 'BOUNDED'
export type GroupSocialOutputReason = 'WITHIN_BUDGET' | 'GROUP_SOCIAL_HARD_LIMIT'
export type GroupSocialBoundaryType =
  | 'NONE'
  | 'PARAGRAPH'
  | 'SENTENCE'
  | 'CODE_POINT'
  | 'STRUCTURED_FALLBACK'
  | 'PROTECTED_SPAN_FALLBACK'
  | 'SUFFIX_ONLY'
  | 'COMPACT_FALLBACK'

/**
 * Two-tier natural-language budgets. The target guides the prompt; the hard cap
 * is enforced deterministically, including on the final outbound text. DETAILED
 * is a wider budget, never an unbounded mode.
 */
export const GROUP_SOCIAL_OUTPUT_BUDGETS = Object.freeze({
  NORMAL: Object.freeze({ targetChars: 280, hardChars: 500 }),
  DETAILED: Object.freeze({ targetChars: 550, hardChars: 900 }),
})

/** Deterministic footprint of the outbound signature decoration (signature plus separator). */
export const GROUP_REPLY_SIGNATURE_RESERVE_CHARS = YEYE_REPLY_SIGNATURE.length + 1

export const GROUP_SOCIAL_CLOSING_TAIL = '先说到这里，核心结论就是这些。'

/**
 * Fixed deterministic social fallback for GROUP outputs that cannot be
 * shortened safely at all and whose protected suffix cannot fit the cap.
 * Fixed copy, never generated by an LLM.
 */
export const GROUP_SOCIAL_COMPACT_FALLBACK = '这段内容太长了，我先收住。想聊哪一部分，再点一下我就展开。'

/** Smallest body budget worth keeping when a protected suffix shares the cap. */
const SOCIAL_MIN_BODY_BUDGET = 120

export interface GroupSocialOutputBoundaryOptions {
  /** UTF-16 chars reserved for deterministic outbound decorations added after this boundary. */
  reserveChars?: number
  /** A trusted fixed runtime suffix that is already part of the text and must stay intact. */
  protectedSuffix?: string
}

export interface GroupSocialOutputBoundaryResult {
  text: string
  beforeChars: number
  afterChars: number
  paragraphCount: number
  responseDepth: GroupSocialOutputDepth
  bounded: boolean
  result: GroupSocialOutputResult
  reason: GroupSocialOutputReason
  boundaryType: GroupSocialBoundaryType
  structuredKind: GroupBulkOutputKind
}

/**
 * Apply the GROUP social hard cap to natural-language text. Callers run the
 * bulk boundary first. This boundary is FAIL-CLOSED: once the text exceeds the
 * cap it never returns the original text — it shortens at a safe boundary
 * (paragraph → sentence → whitespace-preferring code-point-safe cut) or
 * replaces the payload whole with a fixed compact fallback. `reserveChars`
 * keeps room for decorations added after this boundary (the reply signature),
 * so the final outbound stays within the hard cap.
 */
export function boundGroupSocialOutput(
  text: string,
  responseDepth: GroupSocialOutputDepth,
  options: GroupSocialOutputBoundaryOptions = {},
): GroupSocialOutputBoundaryResult {
  const beforeChars = text.length
  const normalized = text.trim()
  const paragraphCount = countSocialParagraphs(normalized)
  const frame = { beforeChars, paragraphCount, responseDepth }
  const reserve = Math.max(0, options.reserveChars ?? 0)
  // Total UTF-16 budget for everything this boundary returns; the receiver's
  // deterministic signature footprint is already reserved.
  const hardLimit = Math.max(1, GROUP_SOCIAL_OUTPUT_BUDGETS[responseDepth].hardChars - reserve)

  const failClosed = (
    boundedText: string,
    boundaryType: GroupSocialBoundaryType,
    structuredKind: GroupBulkOutputKind = 'NONE',
  ): GroupSocialOutputBoundaryResult => {
    // Defence against parameter pathology only: with the real constants every
    // fixed fallback sits far below the cap. The clamp keeps the invariant
    // absolute even if a caller passes an oversized reserve.
    const safe = boundedText.length <= hardLimit
      ? boundedText
      : boundedText.slice(0, codePointSafeCut(boundedText, hardLimit))
    return {
      text: safe,
      afterChars: safe.length,
      bounded: true,
      result: 'BOUNDED',
      reason: 'GROUP_SOCIAL_HARD_LIMIT',
      boundaryType,
      structuredKind,
      ...frame,
    }
  }

  if (normalized.length === 0) {
    return {
      text: '',
      afterChars: 0,
      bounded: false,
      result: 'PASS',
      reason: 'WITHIN_BUDGET',
      boundaryType: 'NONE',
      structuredKind: 'NONE',
      ...frame,
    }
  }

  const suffix = options.protectedSuffix
  const suffixText = suffix !== undefined && suffix.length > 0 && normalized.endsWith(suffix) ? suffix : ''
  const suffixBlock = suffixText.length > 0 ? suffixText.length + 2 : 0
  const body = suffixText.length > 0 ? normalized.slice(0, normalized.length - suffixText.length).trimEnd() : normalized

  if (body.length === 0) {
    // The whole text is the protected suffix itself: keep it while it fits.
    if (suffixText.length <= hardLimit) {
      return {
        text: normalized,
        afterChars: normalized.length,
        bounded: false,
        result: 'PASS',
        reason: 'WITHIN_BUDGET',
        boundaryType: 'NONE',
        structuredKind: 'NONE',
        ...frame,
      }
    }
    return failClosed(GROUP_SOCIAL_COMPACT_FALLBACK, 'COMPACT_FALLBACK')
  }

  if (body.length <= hardLimit - suffixBlock) {
    return {
      text: normalized,
      afterChars: normalized.length,
      bounded: false,
      result: 'PASS',
      reason: 'WITHIN_BUDGET',
      boundaryType: 'NONE',
      structuredKind: 'NONE',
      ...frame,
    }
  }

  // FAIL-CLOSED from here on: every branch returns a fixed bounded text. The
  // trusted protected suffix (e.g. the search-failure disclosure) is kept
  // whenever it can share the cap with a meaningful body; an abnormally long
  // suffix collapses to the compact fallback instead of pushing the output
  // over the cap.
  let suffixOut = ''
  if (suffixText.length > 0) {
    if (suffixBlock <= hardLimit - SOCIAL_MIN_BODY_BUDGET) {
      suffixOut = suffixText
    } else if (suffixText.length <= hardLimit) {
      // Keep the disclosure, drop the body entirely.
      return failClosed(suffixText, 'SUFFIX_ONLY')
    } else {
      // The suffix itself cannot fit the cap: fixed short compact disclosure,
      // while the body still gets whatever budget the compact suffix leaves.
      suffixOut = GROUP_SOCIAL_COMPACT_FALLBACK
    }
  }
  const bodyLimit = suffixOut.length > 0 ? hardLimit - (suffixOut.length + 2) : hardLimit

  if (body.length <= bodyLimit) {
    // Only reachable when the oversized original suffix was replaced by the
    // compact one and the body still fits beside it.
    return failClosed(suffixOut.length > 0 ? `${body}\n\n${suffixOut}` : body, 'COMPACT_FALLBACK')
  }

  const structuredKind = detectStructuredPayloadShape(body)
  if (structuredKind !== 'NONE') {
    return failClosed(
      suffixOut.length > 0 ? `${GROUP_BULK_OUTPUT_FALLBACK}\n\n${suffixOut}` : GROUP_BULK_OUTPUT_FALLBACK,
      'STRUCTURED_FALLBACK',
      structuredKind,
    )
  }

  const shortened = shortenAtSocialBoundary(body, bodyLimit)
  if (shortened !== null) {
    return failClosed(
      suffixOut.length > 0 ? `${shortened.text}\n\n${suffixOut}` : shortened.text,
      shortened.boundaryType,
    )
  }

  // No linguistic, whitespace or code-point-safe cut exists: the head is one
  // unbreakable protected span (giant inline code, URL). Protected-content
  // semantics: replace the payload whole instead of passing it through.
  return failClosed(
    suffixOut.length > 0 ? `${GROUP_BULK_OUTPUT_FALLBACK}\n\n${suffixOut}` : GROUP_BULK_OUTPUT_FALLBACK,
    'PROTECTED_SPAN_FALLBACK',
  )
}

const SOCIAL_TAIL_BLOCK = `\n\n${GROUP_SOCIAL_CLOSING_TAIL}`
const SOCIAL_ELLIPSIS = '……'

/**
 * Shorten one natural-language body to `limit` UTF-16 chars, ending at a
 * paragraph boundary, then a sentence boundary, then a code-point-safe cut
 * that prefers a whitespace position, always closed by the fixed short tail
 * line. Returns null only when no cut position exists at all — the head is
 * dominated by one unbreakable protected span — so the caller replaces the
 * payload whole (fail-closed).
 */
function shortenAtSocialBoundary(
  body: string,
  limit: number,
): { text: string; boundaryType: 'PARAGRAPH' | 'SENTENCE' | 'CODE_POINT' } | null {
  const contentLimit = limit - SOCIAL_TAIL_BLOCK.length
  if (contentLimit < 1) return null

  const boundary = findSocialSafeBoundary(body, contentLimit)
  if (boundary !== null) {
    const boundedBody = body.slice(0, boundary.end).trimEnd()
    if (boundedBody.length > 0 && preservesSourceMarkers(body, boundedBody)) {
      return { text: `${boundedBody}${SOCIAL_TAIL_BLOCK}`, boundaryType: boundary.type }
    }
  }

  const cutLimit = contentLimit - SOCIAL_ELLIPSIS.length
  if (cutLimit >= 1) {
    const ranges = collectProtectedRanges(body)
    const whitespaceEnd = findWhitespaceCut(body, cutLimit, ranges)
    if (whitespaceEnd !== null) {
      const boundedBody = body.slice(0, whitespaceEnd).trimEnd()
      if (boundedBody.length > 0 && preservesSourceMarkers(body, boundedBody)) {
        return { text: `${boundedBody}${SOCIAL_ELLIPSIS}${SOCIAL_TAIL_BLOCK}`, boundaryType: 'CODE_POINT' }
      }
    }
    const cut = codePointSafeCut(body, cutLimit)
    const boundedBody = body.slice(0, cut).trimEnd()
    if (cut > 0 && boundedBody.length > 0 && preservesSourceMarkers(body, boundedBody)) {
      return { text: `${boundedBody}${SOCIAL_ELLIPSIS}${SOCIAL_TAIL_BLOCK}`, boundaryType: 'CODE_POINT' }
    }
  }
  return null
}

/**
 * Last whitespace position within the cap that is not inside a protected
 * span. It gives the code-point-safe hard cut a whole-word boundary whenever
 * one exists, without ever splitting a URL, inline-code span or marker.
 */
function findWhitespaceCut(text: string, maxChars: number, ranges: readonly ProtectedRange[]): number | null {
  const lastIndex = Math.min(text.length, maxChars) - 1
  for (let index = lastIndex; index >= 0; index -= 1) {
    if (!/\s/u.test(text[index] ?? '')) continue
    if (isProtectedIndex(index, ranges)) continue
    return index + 1
  }
  return null
}

/**
 * Fence-aware safe-boundary search. Candidates only exist outside fenced code
 * blocks, so a cut either keeps a fenced block whole or drops it whole; it can
 * never leave an unterminated fence behind. Paragraph and sentence ends are
 * both complete natural boundaries; the latest one within the cap preserves the
 * most content, matching the ordinary reply boundary's behaviour.
 */
function findSocialSafeBoundary(
  text: string,
  maxChars: number,
): { end: number; type: 'PARAGRAPH' | 'SENTENCE' } | null {
  const ranges = collectProtectedRanges(text)
  const candidates: Array<{ end: number; type: 'PARAGRAPH' | 'SENTENCE' }> = []
  let offset = 0
  let inFence = false
  for (const line of splitLines(text)) {
    const lineStart = offset
    const lineEnd = lineStart + line.content.length
    offset = lineEnd + line.eol.length
    if (isFence(line.content)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    for (let index = lineStart; index < lineEnd; index += 1) {
      const character = text[index] ?? ''
      if (!isSentenceEnding(text, index, character, ranges)) continue
      candidates.push({ end: includeCitationTail(text, index + 1), type: 'SENTENCE' })
    }
    if (line.content.trim().length === 0 && line.eol.length > 0) {
      candidates.push({ end: offset, type: 'PARAGRAPH' })
    }
  }

  let best: { end: number; type: 'PARAGRAPH' | 'SENTENCE' } | null = null
  for (const candidate of candidates) {
    if (candidate.end > maxChars) continue
    if (best === null || candidate.end > best.end) best = candidate
  }
  return best
}

/**
 * Last-resort cut that never splits a UTF-16 surrogate pair and never ends
 * inside a protected span (URL, inline code, citation marker); a cut that
 * would land inside one drops that whole span instead.
 */
function codePointSafeCut(text: string, maxChars: number): number {
  const ranges = collectProtectedRanges(text)
  let end = Math.max(0, Math.min(text.length, maxChars))
  for (;;) {
    const range = ranges.find((candidate) => end > candidate.start && end < candidate.end)
    if (range !== undefined) {
      end = range.start
      continue
    }
    if (end > 0 && isHighSurrogateUnit(text.charCodeAt(end - 1)) && isLowSurrogateUnit(text.charCodeAt(end))) {
      end -= 1
      continue
    }
    return end
  }
}

function isHighSurrogateUnit(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}

function isLowSurrogateUnit(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff
}

/**
 * Structural shape check without the bulk size gate. It only runs on text that
 * already exceeds the social hard cap, so "structured" here means shape, not
 * size: such a payload must be replaced whole, never cut mid-way. Fenced code
 * and code-dense text are not shape-deferred — the fence-aware boundary search
 * drops fenced blocks whole, and the bulk boundary already blocks them above
 * its own size gate.
 */
function detectStructuredPayloadShape(text: string): GroupBulkOutputKind {
  const fenced = inspectFencedCode(text)
  if (fenced.codeBlockCount > 0 && isHighDensityBase64(fenced.codeText)) return 'BASE64'
  if (isHighDensityBase64(text)) return 'BASE64'
  if (isStructuredMarkup(text)) return 'STRUCTURED_MARKUP'
  if (isLargeJsonPayload(text)) return 'JSON'
  if (isLargeSqlPayload(text)) return 'SQL'
  if (isLargeLogPayload(text)) return 'LOG'
  return 'NONE'
}

function countSocialParagraphs(normalized: string): number {
  if (normalized.length === 0) return 0
  return normalized.split(/\n{2,}/u).filter((part) => part.trim().length > 0).length
}

/**
 * Add the fixed Yeye display signature without changing the answer's meaning.
 * This is deliberately separate from `renderHumanChat`: the renderer cleans up
 * ordinary model presentation, while this decorator is the final deterministic
 * outbound display concern.
 */
export function decorateYeyeReplySignature(text: string): string {
  return decorateYeyeReplySignatureWithDiagnostics(text).text
}

export interface YeyeReplySignatureResult {
  text: string
  beforeCount: number
  afterCount: number
  placement: 'FINAL_NATURAL_LANGUAGE' | 'EXISTING' | 'NONE'
}

/** Decorate one whole reply, preserving protected and source regions. */
export function decorateYeyeReplySignatureWithDiagnostics(text: string): YeyeReplySignatureResult {
  if (text.trim().length === 0) {
    return { text: '', beforeCount: 0, afterCount: 0, placement: 'NONE' }
  }

  const lines = splitLines(text)
  const sourceStart = findSourceAreaStart(lines)
  const bodyLines = sourceStart < 0 ? lines : lines.slice(0, sourceStart)
  const sourceLines = sourceStart < 0 ? [] : lines.slice(sourceStart)
  let inCodeBlock = false
  let beforeCount = 0
  let lastNaturalLine = -1
  const cleanedBody: SourceLine[] = []

  for (const line of bodyLines) {
    if (isFence(line.content)) {
      inCodeBlock = !inCodeBlock
      cleanedBody.push(line)
      continue
    }
    if (inCodeBlock) {
      cleanedBody.push(line)
      continue
    }

    const protectedRanges = collectProtectedRanges(line.content)
    if (isProtectedOrStructuralLine(line.content, protectedRanges)) {
      cleanedBody.push(line)
      continue
    }

    beforeCount += countNaturalSignatures(line.content, protectedRanges)
    const cleaned = removeNaturalSignatures(line.content, protectedRanges)
    const cleanedRanges = collectProtectedRanges(cleaned)
    if (hasNaturalLanguage(cleaned, cleanedRanges)) {
      lastNaturalLine = cleanedBody.length
    }
    cleanedBody.push({ ...line, content: cleaned })
  }

  let placement: YeyeReplySignatureResult['placement'] = 'NONE'
  if (lastNaturalLine >= 0) {
    const line = cleanedBody[lastNaturalLine]
    if (line !== undefined) {
      cleanedBody[lastNaturalLine] = {
        ...line,
        content: appendReplyLevelSignature(line.content),
      }
      placement = 'FINAL_NATURAL_LANGUAGE'
    }
  } else if (beforeCount > 0) {
    placement = 'EXISTING'
  }

  const rendered = [...cleanedBody, ...sourceLines].map((line) => line.content + line.eol).join('')
  const afterCount = countNaturalSignatures(rendered)
  return { text: rendered, beforeCount, afterCount, placement }
}

interface SourceLine {
  content: string
  eol: string
}

function splitLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\r' && text[index] !== '\n') {
      continue
    }
    const eol = text[index] === '\r' && text[index + 1] === '\n' ? '\r\n' : text[index]
    lines.push({ content: text.slice(start, index), eol })
    start = index + eol.length
    if (eol.length === 2) {
      index += 1
    }
  }
  lines.push({ content: text.slice(start), eol: '' })
  return lines
}

function isFence(line: string): boolean {
  return /^\s*```/u.test(line)
}

interface BulkOutputMetrics {
  kind: GroupBulkOutputKind
  codeBlockCount: number
}

interface FencedCodeMetrics {
  codeBlockCount: number
  codeChars: number
  codeLines: number
  codeText: string
}

function inspectBulkOutput(text: string): BulkOutputMetrics {
  const fenced = inspectFencedCode(text)
  if (fenced.codeBlockCount > 0) {
    if (isHighDensityBase64(fenced.codeText)) {
      return { kind: 'BASE64', codeBlockCount: fenced.codeBlockCount }
    }
    if (
      fenced.codeChars > GROUP_CODE_MAX_CHARS ||
      fenced.codeLines > GROUP_CODE_MAX_LINES ||
      fenced.codeBlockCount > GROUP_CODE_MAX_BLOCKS
    ) {
      return { kind: 'FENCED_CODE', codeBlockCount: fenced.codeBlockCount }
    }
    return { kind: 'NONE', codeBlockCount: fenced.codeBlockCount }
  }

  if (text.length > GROUP_STRUCTURED_MAX_CHARS && isStructuredMarkup(text)) {
    return { kind: 'STRUCTURED_MARKUP', codeBlockCount: 0 }
  }
  if (text.length > GROUP_STRUCTURED_MAX_CHARS && isLargeJsonPayload(text)) {
    return { kind: 'JSON', codeBlockCount: 0 }
  }
  if (text.length > GROUP_STRUCTURED_MAX_CHARS && isLargeSqlPayload(text)) {
    return { kind: 'SQL', codeBlockCount: 0 }
  }
  if (text.length > GROUP_STRUCTURED_MAX_CHARS && isLargeLogPayload(text)) {
    return { kind: 'LOG', codeBlockCount: 0 }
  }
  if (isHighDensityBase64(text)) {
    return { kind: 'BASE64', codeBlockCount: 0 }
  }

  const codeLike = inspectCodeLikeLines(text)
  if (codeLike.chars > GROUP_CODE_MAX_CHARS || codeLike.lines > GROUP_CODE_MAX_LINES) {
    return { kind: 'CODE_DENSE', codeBlockCount: 0 }
  }
  return { kind: 'NONE', codeBlockCount: 0 }
}

function inspectFencedCode(text: string): FencedCodeMetrics {
  let inCodeBlock = false
  let codeBlockCount = 0
  let codeChars = 0
  let codeLines = 0
  const codeLinesText: string[] = []
  for (const line of splitLines(text)) {
    if (isFence(line.content)) {
      if (inCodeBlock) {
        inCodeBlock = false
      } else {
        inCodeBlock = true
        codeBlockCount += 1
      }
      continue
    }
    if (!inCodeBlock) continue
    codeChars += line.content.length
    codeLines += 1
    codeLinesText.push(line.content)
  }
  return { codeBlockCount, codeChars, codeLines, codeText: codeLinesText.join('\n') }
}

function isStructuredMarkup(text: string): boolean {
  const tags = text.match(/<\/?[A-Za-z][^>\r\n]*>/gu) ?? []
  if (tags.length < 4) return false
  const hasKnownRoot = /<\s*(?:svg|html|xml)\b/iu.test(text) || /<\?xml\b/iu.test(text)
  const closingTagCount = tags.filter((tag) => /^<\//u.test(tag)).length
  return hasKnownRoot || closingTagCount >= 2
}

function isLargeJsonPayload(text: string): boolean {
  const normalized = text.trim()
  const candidates = [normalized]
  const embedded = /(?:^|\r?\n)\s*([\[{][\s\S]*[\]}])\s*$/u.exec(normalized)?.[1]
  if (embedded !== undefined && embedded !== normalized) {
    candidates.push(embedded)
  }
  for (const candidate of candidates) {
    const first = candidate[0]
    if (first !== '{' && first !== '[') continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object') return true
    } catch {
      // A prose prefix or a non-JSON code block is not a structured payload.
    }
  }
  return false
}

function isLargeSqlPayload(text: string): boolean {
  const statementCount = text.match(/(?:^|[;\r\n])\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(?:TABLE|DATABASE|INDEX)|ALTER\s+TABLE|DROP\s+(?:TABLE|DATABASE|INDEX)|WITH)\b/giu)?.length ?? 0
  const semicolonCount = text.match(/;/gu)?.length ?? 0
  return statementCount >= 2 || (statementCount >= 1 && semicolonCount >= 2)
}

function isLargeLogPayload(text: string): boolean {
  const logLikeLines = splitLines(text).filter((line) =>
    /^(?:\[?\d{4}[-/]\d{2}[-/]\d{2}|(?:DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b|Traceback \(|(?:[A-Za-z_$][\w$]*(?:Error|Exception))\b|at\s+\S+)/iu.test(line.content.trim()),
  ).length
  return logLikeLines >= 4
}

function isHighDensityBase64(text: string): boolean {
  const compact = text.replace(/\s+/gu, '')
  if (compact.length < GROUP_BASE64_MIN_CHARS || /[\p{Script=Han}<>{};]/u.test(text)) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) return false
  // Long prose is not an encoded payload merely because it contains letters.
  // Require an encoding-shaped signal when whitespace is present.
  return !/\s/u.test(text) || /[0-9+/=]/u.test(compact)
}

function inspectCodeLikeLines(text: string): { lines: number; chars: number } {
  let lines = 0
  let chars = 0
  for (const line of splitLines(text)) {
    if (!isCodeLikeLine(line.content)) continue
    lines += 1
    chars += line.content.length
  }
  return { lines, chars }
}

function isCodeLikeLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  if (isClearlyCodeOrDiagnostic(trimmed)) return true
  if (/^(?:public|private|protected|static|async|await|def|fn|func|using|package)\b/iu.test(trimmed)) return true
  if (/^(?:echo|set|export|source|grep|sed|awk|chmod|mkdir|touch|#!\/|then|else|elif|fi|done|esac)\b/iu.test(trimmed)) return true
  if (/^(?:int|long|short|float|double|boolean|bool|char|string|String|var|List|Map|Set)\b[^=\r\n]*=/u.test(trimmed)) return true
  return /[A-Za-z_$][\w$]*\s*[({=].*[;{}]?$/.test(trimmed) && !/[\p{Script=Han}]/u.test(trimmed)
}

function normalizePresentationLine(line: string): string {
  const heading = /^\s{0,3}#{1,6}(?:\s+|$)(.*?)\s*#*\s*$/u.exec(line)
  const withoutHeading = heading === null ? line : (heading[1] ?? '')
  return withoutHeading
    .replace(/\*\*([^*\r\n]+?)\*\*/gu, '$1')
    .replace(/__([^_\r\n]+?)__/gu, '$1')
}

interface ProtectedRange {
  start: number
  end: number
}

function collectProtectedRanges(text: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = []
  const addMatches = (pattern: RegExp): void => {
    for (const match of text.matchAll(pattern)) {
      const start = match.index
      const value = match[0]
      if (start === undefined || value === undefined) continue
      ranges.push({ start, end: start + value.length })
    }
  }

  // Protect the complete Markdown link, not just its URL, so punctuation in
  // the label cannot be mistaken for a sentence boundary.
  addMatches(/\[[^\]\r\n]*\]\(\s*[^)\r\n]+\s*\)/gu)
  addInlineCodeRanges(text, ranges)
  addMatches(/https?:\/\/[^\s<>()]+/gu)
  addMatches(/\[S\d+\]/gu)

  return mergeRanges(ranges)
}

function addInlineCodeRanges(text: string, ranges: ProtectedRange[]): void {
  for (let index = 0; index < text.length;) {
    if (text[index] !== '`') {
      index += 1
      continue
    }

    let delimiterLength = 1
    while (text[index + delimiterLength] === '`') delimiterLength += 1
    const delimiter = '`'.repeat(delimiterLength)
    const closing = text.indexOf(delimiter, index + delimiterLength)
    const end = closing < 0 ? text.length : closing + delimiterLength
    ranges.push({ start: index, end })
    index = end
  }
}

function mergeRanges(ranges: ProtectedRange[]): ProtectedRange[] {
  ranges.sort((left, right) => left.start - right.start || right.end - left.end)
  const merged: ProtectedRange[] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous === undefined || range.start > previous.end) {
      merged.push({ ...range })
    } else {
      previous.end = Math.max(previous.end, range.end)
    }
  }
  return merged
}

function isProtectedOrStructuralLine(line: string, ranges: readonly ProtectedRange[]): boolean {
  const trimmed = line.trim()
  if (/^来源\s*[:：]?\s*$/u.test(trimmed)) return true
  if (isSourceUrlLine(trimmed)) {
    const unprotected = removeProtectedRanges(line, ranges).trim()
    if (unprotected.length === 0 || !/[\p{Script=Han}\p{Letter}]/u.test(unprotected)) return true
    if (/^\s*\d+[.)]\s+/u.test(trimmed)) return true
  }

  const unprotected = removeProtectedRanges(line, ranges).trim()
  if (unprotected.length === 0 || !/[\p{Script=Han}\p{Letter}]/u.test(unprotected)) return true
  return isClearlyCodeOrDiagnostic(trimmed)
}

function removeProtectedRanges(text: string, ranges: readonly ProtectedRange[]): string {
  let result = ''
  let cursor = 0
  for (const range of ranges) {
    result += text.slice(cursor, range.start)
    cursor = range.end
  }
  return result + text.slice(cursor)
}

function isSourceUrlLine(line: string): boolean {
  const withoutCitation = line.replace(/(?:\s*\[S\d+\])+\s*$/u, '').trimEnd()
  const urlMatch = /https?:\/\/[^\s<>()]+$/u.exec(withoutCitation)
  if (urlMatch === null) return false

  // A Chinese sentence may put its full stop immediately after a URL. The
  // URL regex conservatively consumes it, so allow the natural-language line
  // to continue through the decorator in that one unambiguous shape.
  const beforeUrl = withoutCitation.slice(0, urlMatch.index)
  const url = urlMatch[0]
  if (beforeUrl.trim().length > 0 && /[。！？]$/u.test(url)) return false
  return true
}

function isClearlyCodeOrDiagnostic(line: string): boolean {
  const trimmed = line.trim()
  const shellLine = trimmed.replace(/^\$\s*/u, '')
  if (/^(?:const|let|var|function|class|interface|type|import|export|return|throw|if|for|while|switch|case|try|catch|new)\b/u.test(trimmed)) {
    return true
  }
  if (/^(?:PS\s*>|npm|pnpm|yarn|node|npx|git|curl|wget|docker|python|pytest|powershell|pwsh)\b/iu.test(shellLine)) {
    return true
  }
  if (/^(?:Error|TypeError|ReferenceError|SyntaxError|Traceback)\b/iu.test(trimmed) || /^at\s+\S+/u.test(trimmed)) {
    return true
  }
  if (/^[\[{][\s\S]*[\]}]$/u.test(trimmed)) return true
  if (/=>|===|!==|&&|\|\|/u.test(trimmed) && !/[\p{Script=Han}]/u.test(trimmed)) return true
  if (/[{};]/u.test(trimmed) && !/[\p{Script=Han}]/u.test(trimmed)) return true
  return false
}

function isSentenceEnding(
  text: string,
  index: number,
  character: string,
  ranges: readonly ProtectedRange[],
): boolean {
  if (!SENTENCE_ENDINGS.has(character) || isProtectedIndex(index, ranges)) return false
  if (character !== '.') return true

  const previous = text[index - 1] ?? ''
  const next = text[index + 1] ?? ''
  if (previous === '.' || next === '.') return false
  if (/\d/u.test(previous) && /\d/u.test(next)) return false
  return next.length === 0 || /\s/u.test(next) || next === '['
}

function isProtectedIndex(index: number, ranges: readonly ProtectedRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end)
}

function findSafeBoundary(text: string, maxChars: number): { end: number; type: 'PARAGRAPH' | 'SENTENCE' } | null {
  const ranges = collectProtectedRanges(text)
  const candidates: Array<{ end: number; type: 'PARAGRAPH' | 'SENTENCE' }> = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n' && text[index + 1] === '\n') {
      const end = index + 2
      if (end <= maxChars) candidates.push({ end, type: 'PARAGRAPH' })
    }

    const character = text[index] ?? ''
    if (!isSentenceEnding(text, index, character, ranges)) continue
    const end = includeCitationTail(text, index + 1)
    if (end <= maxChars) candidates.push({ end, type: 'SENTENCE' })
  }

  return candidates.length === 0 ? null : candidates[candidates.length - 1] ?? null
}

function includeCitationTail(text: string, start: number): number {
  let cursor = start
  while (/[ \t]/u.test(text[cursor] ?? '')) cursor += 1

  let foundCitation = false
  while (text[cursor] === '[') {
    const citation = /^\[S\d+\]/u.exec(text.slice(cursor))
    if (citation === null) break
    foundCitation = true
    cursor += citation[0].length
    while (/[ \t]/u.test(text[cursor] ?? '')) cursor += 1
  }
  return foundCitation ? cursor : start
}

function preservesSourceMarkers(original: string, bounded: string): boolean {
  const markers = original.match(/\[S\d+\]/gu) ?? []
  if (markers.length === 0) return true
  const boundedMarkers = bounded.match(/\[S\d+\]/gu) ?? []
  // A prefix cut may drop trailing markers together with the content they
  // anchor; every marker that survives must keep its original sequence, and a
  // fully markerless remainder is re-grounded by the repair gate downstream.
  if (boundedMarkers.length > markers.length) return false
  return boundedMarkers.every((marker, index) => markers[index] === marker)
}

function findSourceAreaStart(lines: readonly SourceLine[]): number {
  let inCodeBlock = false
  for (const [index, line] of lines.entries()) {
    if (isFence(line.content)) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (!inCodeBlock && /^\s*来源\s*[:：]?\s*$/u.test(line.content)) return index
  }
  return -1
}

function removeNaturalSignatures(text: string, ranges: readonly ProtectedRange[]): string {
  let result = ''
  for (let index = 0; index < text.length;) {
    if (text.startsWith(YEYE_REPLY_SIGNATURE, index) && !isProtectedIndex(index, ranges)) {
      index += YEYE_REPLY_SIGNATURE.length
      continue
    }
    result += text[index] ?? ''
    index += 1
  }
  return result
}

function countNaturalSignatures(text: string, ranges?: readonly ProtectedRange[]): number {
  if (ranges !== undefined) {
    let count = 0
    for (let index = 0; index <= text.length - YEYE_REPLY_SIGNATURE.length; index += 1) {
      if (text.startsWith(YEYE_REPLY_SIGNATURE, index) && !isProtectedIndex(index, ranges)) count += 1
    }
    return count
  }

  const lines = splitLines(text)
  const sourceStart = findSourceAreaStart(lines)
  const bodyLines = sourceStart < 0 ? lines : lines.slice(0, sourceStart)
  let inCodeBlock = false
  let count = 0
  for (const line of bodyLines) {
    if (isFence(line.content)) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) continue
    const lineRanges = collectProtectedRanges(line.content)
    if (isProtectedOrStructuralLine(line.content, lineRanges)) continue
    count += countNaturalSignatures(line.content, lineRanges)
  }
  return count
}

function hasNaturalLanguage(text: string, ranges: readonly ProtectedRange[]): boolean {
  return /[\p{Script=Han}\p{Letter}]/u.test(removeProtectedRanges(text, ranges).replaceAll(YEYE_REPLY_SIGNATURE, ''))
}

function appendReplyLevelSignature(line: string): string {
  const trailingWhitespace = line.match(/[ \t]+$/u)?.[0] ?? ''
  const core = trailingWhitespace.length === 0 ? line : line.slice(0, -trailingWhitespace.length)
  if (core.length === 0) return line

  const citationTail = /((?:\s*\[S\d+\])+)$/.exec(core)
  if (citationTail !== null && citationTail.index !== undefined) {
    const beforeCitation = core.slice(0, citationTail.index)
    if (beforeCitation.trim().length > 0) {
      const citation = citationTail[1] ?? ''
      return `${appendSignatureBeforeTrailingUrl(beforeCitation)}${citation.startsWith(' ') ? '' : ' '}${citation}${trailingWhitespace}`
    }
  }

  return `${appendSignatureBeforeTrailingUrl(core)}${trailingWhitespace}`
}

function appendSignatureBeforeTrailingUrl(text: string): string {
  const urlMatch = /https?:\/\/[^\s<>()]+$/u.exec(text)
  if (urlMatch !== null && urlMatch.index > 0) {
    if (/[。！？]$/u.test(urlMatch[0])) return `${text}${YEYE_REPLY_SIGNATURE}`
    const beforeUrl = text.slice(0, urlMatch.index).trimEnd()
    if (/[\p{Script=Han}\p{Letter}]/u.test(beforeUrl)) {
      const url = text.slice(urlMatch.index)
      return `${beforeUrl}${YEYE_REPLY_SIGNATURE} ${url}`
    }
  }
  return `${text}${YEYE_REPLY_SIGNATURE}`
}
