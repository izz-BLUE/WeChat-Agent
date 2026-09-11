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
