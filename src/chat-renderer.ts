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

/**
 * Add the fixed Yeye display signature without changing the answer's meaning.
 * This is deliberately separate from `renderHumanChat`: the renderer cleans up
 * ordinary model presentation, while this decorator is the final deterministic
 * outbound display concern.
 */
export function decorateYeyeReplySignature(text: string): string {
  if (text.trim().length === 0) {
    return ''
  }

  const lines = splitLines(text)
  const output: string[] = []
  let inCodeBlock = false

  for (const line of lines) {
    if (isFence(line.content)) {
      inCodeBlock = !inCodeBlock
      output.push(line.content + line.eol)
      continue
    }
    if (inCodeBlock) {
      output.push(line.content + line.eol)
      continue
    }
    output.push(decorateNaturalLanguageLine(line.content) + line.eol)
  }

  return output.join('')
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

function decorateNaturalLanguageLine(line: string): string {
  const { prefix, body } = splitLinePrefix(line)
  if (body.trim().length === 0) {
    return line
  }

  const protectedRanges = collectProtectedRanges(body)
  if (isProtectedOrStructuralLine(body, protectedRanges)) {
    return line
  }

  let rendered = ''
  let rangeIndex = 0
  for (let index = 0; index < body.length;) {
    const protectedRange = protectedRanges[rangeIndex]
    if (protectedRange !== undefined && protectedRange.start === index) {
      rendered += body.slice(protectedRange.start, protectedRange.end)
      index = protectedRange.end
      rangeIndex += 1
      continue
    }

    const character = body[index] ?? ''
    rendered += character
    if (isSentenceEnding(body, index, character, protectedRanges) && !hasSignatureAfter(body, index + 1)) {
      rendered += YEYE_REPLY_SIGNATURE
      if (body[index + 1] === '[' && /^\[S\d+\]/u.test(body.slice(index + 1))) {
        rendered += ' '
      }
    }
    index += 1
  }

  return prefix + appendLineEndingSignature(rendered, body)
}

function splitLinePrefix(line: string): { prefix: string; body: string } {
  const match = /^(\s*(?:(?:[-+*]|\d+[.)]|>|#{1,6})\s+)?)/u.exec(line)
  const prefix = match?.[1] ?? ''
  return { prefix, body: line.slice(prefix.length) }
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
  if (isSourceUrlLine(trimmed)) return true

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

function hasSignatureAfter(text: string, start: number): boolean {
  return /^[ \t]*🌴˙ᵕ˙/u.test(text.slice(start))
}

function appendLineEndingSignature(rendered: string, original: string): string {
  const trailingWhitespace = rendered.match(/[ \t]+$/u)?.[0] ?? ''
  const core = trailingWhitespace.length === 0 ? rendered : rendered.slice(0, -trailingWhitespace.length)
  if (core.length === 0 || core.endsWith(YEYE_REPLY_SIGNATURE)) return rendered

  const citationTail = /((?:\s*\[S\d+\])+)$/.exec(core)
  if (citationTail !== null && citationTail.index !== undefined) {
    const beforeCitation = core.slice(0, citationTail.index)
    if (beforeCitation.trim().length > 0 && beforeCitation.endsWith(YEYE_REPLY_SIGNATURE)) return rendered
    if (beforeCitation.trim().length > 0) {
      const citation = citationTail[1] ?? ''
      return `${beforeCitation}${YEYE_REPLY_SIGNATURE}${citation.startsWith(' ') ? '' : ' '}${citation}${trailingWhitespace}`
    }
  }

  if (isSourceUrlLine(original.trim())) return rendered
  return `${core}${YEYE_REPLY_SIGNATURE}${trailingWhitespace}`
}
