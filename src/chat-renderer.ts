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
export type GroupReplyBoundaryType = 'NONE' | 'PARAGRAPH' | 'SENTENCE' | 'BULK_OUTPUT_BLOCKED' | 'BYPASS_DETAILED'

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
 * complete natural boundary. DETAILED is handled as an explicit detail bypass.
 */
export const GROUP_REPLY_LENGTH_BUDGETS = Object.freeze({
  SHORT: Object.freeze({ HIGH: 120, MEDIUM: 160, LOW: 200 }),
  NORMAL: Object.freeze({ HIGH: 240, MEDIUM: 360, LOW: 480 }),
  DETAILED: Object.freeze({ HIGH: 720, MEDIUM: 960, LOW: 1_200 }),
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
    return {
      text: normalized,
      beforeChars,
      afterChars: normalized.length,
      bounded: false,
      boundaryType: 'BYPASS_DETAILED',
      bulkOutput,
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
  return markers.every((marker, index) => boundedMarkers[index] === marker)
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
