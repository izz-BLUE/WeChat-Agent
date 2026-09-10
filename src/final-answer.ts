/**
 * Provider response boundary for the Agent.
 *
 * The WeChat outbound path may only ever carry a FINAL_ANSWER. Anything a
 * provider emits about its own reasoning is a separate, non-sendable channel,
 * so this module is the single place that decides what a final answer is.
 *
 * Measured provider shapes (2026-09, OpenAI-compatible endpoints):
 *  - MiniMax-M3 (`api.minimaxi.com/v1`): `message` has only `content` + `role`.
 *    The reasoning is inlined into `content` as a balanced `<think>...</think>`
 *    pair that precedes the answer.
 *  - DeepSeek-style gateways: a sibling `reasoning_content` string next to a
 *    clean `content`.
 * Both shapes are handled here, and a reasoning carrier is never a reply
 * fallback: an empty final answer fails closed instead.
 */

export const REASONING_FIELD_NAMES = [
  'reasoning_content',
  'reasoning',
  'reasoning_details',
  'thinking',
  'analysis',
] as const

export const THINKING_TAG_NAMES = ['think', 'thinking', 'reasoning', 'analysis', 'mm:think'] as const

export interface SanitizedFinalAnswer {
  /** Sendable text; an empty string means nothing may be sent. */
  text: string
  /** Balanced provider thinking blocks removed from the text. */
  removedBlocks: number
  /**
   * An opening thinking tag without its closing tag. The boundary cannot tell
   * reasoning from answer, so nothing from this text may be sent.
   */
  unterminatedTag: boolean
}

export interface FinalAnswerExtraction extends SanitizedFinalAnswer {
  /** `content` was present and a string. */
  contentPresent: boolean
  /** Reasoning carriers found next to `content`; never used as a reply. */
  reasoningFields: readonly string[]
}

function escapeTagName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const TAG_ALTERNATION = THINKING_TAG_NAMES.map(escapeTagName).join('|')

const BLOCK_PATTERNS = THINKING_TAG_NAMES.map(
  (name) => new RegExp(`<${escapeTagName(name)}>[\\s\\S]*?</${escapeTagName(name)}>`, 'gi'),
)
const STRAY_CLOSE_TAG = new RegExp(`</(?:${TAG_ALTERNATION})>`, 'gi')
const UNCLOSED_OPEN_TAG = new RegExp(`<(?:${TAG_ALTERNATION})>`, 'i')

/**
 * Second line of defence at the Agent outbound boundary. It only removes
 * provider thinking markup: balanced blocks first, then leftover closing tags.
 * Ordinary reply text is never rewritten, and a thinking tag that is left open
 * makes the whole text unsendable instead of being guessed at.
 */
export function sanitizeFinalAnswer(input: string): SanitizedFinalAnswer {
  let text = input
  let removedBlocks = 0

  for (const pattern of BLOCK_PATTERNS) {
    text = text.replace(pattern, () => {
      removedBlocks += 1
      return ''
    })
  }

  text = text.replace(STRAY_CLOSE_TAG, '')

  return {
    text: text.trim(),
    removedBlocks,
    unterminatedTag: UNCLOSED_OPEN_TAG.test(text),
  }
}

function carriesReasoning(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0
  }
  if (Array.isArray(value)) {
    return value.length > 0
  }
  return false
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/**
 * Provider adapter step. The only field that can become a reply is
 * `choices[0].message.content`; reasoning carriers are reported for
 * diagnostics and then ignored, including when `content` is empty.
 */
export function extractFinalAnswer(message: unknown): FinalAnswerExtraction {
  const record = asRecord(message)
  const reasoningFields = REASONING_FIELD_NAMES.filter((name) => carriesReasoning(record[name]))

  if (typeof record.content !== 'string') {
    return {
      text: '',
      removedBlocks: 0,
      unterminatedTag: false,
      contentPresent: false,
      reasoningFields,
    }
  }

  const sanitized = sanitizeFinalAnswer(record.content)
  return {
    text: sanitized.unterminatedTag ? '' : sanitized.text,
    removedBlocks: sanitized.removedBlocks,
    unterminatedTag: sanitized.unterminatedTag,
    contentPresent: true,
    reasoningFields,
  }
}
