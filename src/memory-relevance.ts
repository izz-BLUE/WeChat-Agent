/**
 * Memory relevance filtering.
 *
 * HISTORICAL_SEMANTIC (v02 `MemoryRelevance.cs`): lexical relevance, no
 * embeddings, no vector store. A candidate is relevant when the question is an
 * exact substring of the memory, or an ASCII token overlaps, or a Chinese
 * 3+ gram overlaps, or two Chinese 2-grams overlap; ranking is score desc, then
 * `updatedAt` desc, then `memoryId` asc, truncated to `topK`.
 *
 * The port keeps the same constants, stop words, weights and tie-breaking so the
 * retrieval decision is reproducible across both implementations.
 */
import type { MemoryRecord } from './memory-models.js'

const MAX_NORMALIZED_CHARS = 512
const MAX_CHINESE_NGRAMS = 256
const MAX_NGRAM_LENGTH = 6

const ENGLISH_STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'what', 'my', 'your', 'me', 'you'])

const CHINESE_STOP_WORDS = new Set([
  '我', '你', '他', '她', '它', '的', '了', '是', '吗', '呢', '啊', '吧',
  '这个', '那个', '什么', '怎么', '一下', '刚才', '之前', '现在', '最近',
])

export interface MemoryRelevanceResult {
  score: number
  isRelevant: boolean
  reason: MemoryRelevanceReason
}

export type MemoryRelevanceReason =
  | 'EXACT_PHRASE'
  | 'ASCII_TOKEN_OVERLAP'
  | 'CHINESE_NGRAM_OVERLAP'
  | 'NO_RELEVANCE_TRIGGER'
  | 'SELF_IDENTITY_ATTRIBUTE_BRIDGE'
  | 'SELF_IDENTITY_TARGET_MISMATCH'

export interface MemoryRetrievalIdentityContext {
  requesterId: string
  personalScopeType: 'OWNER' | 'MEMBER'
}

export interface SelfIdentityBridgeResult {
  matched: boolean
  bonus: number
  reason: 'SELF_IDENTITY_ATTRIBUTE_BRIDGE' | 'NO_RELEVANCE_TRIGGER'
}

/** Small enough not to outrank an existing 3+ gram lexical match. */
export const SELF_IDENTITY_ATTRIBUTE_BRIDGE_BONUS = 2

const SELF_IDENTITY_ATTRIBUTE_PATTERN = /(?:代号|名字|姓名|昵称|称呼)/u
const IDENTITY_ATTRIBUTE_PATTERN = /(?:代号|名字|姓名|昵称|称呼|名称|叫什么|怎么称呼|如何称呼)/u

function isAsciiLetterOrDigit(character: string): boolean {
  return /^[A-Za-z0-9]$/u.test(character)
}

function isChinese(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
}

function normalize(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return ''
  }

  let builder = ''
  let pendingSpace = false
  for (const character of trimmed) {
    if (builder.length >= MAX_NORMALIZED_CHARS) {
      break
    }

    if (isChinese(character)) {
      if (pendingSpace && builder.length > 0 && !builder.endsWith(' ')) {
        builder += ' '
      }
      pendingSpace = false
      builder += character
    } else if (isAsciiLetterOrDigit(character)) {
      if (pendingSpace && builder.length > 0 && !builder.endsWith(' ')) {
        builder += ' '
      }
      pendingSpace = false
      builder += character.toLowerCase()
    } else if (/\s/u.test(character) || /[\p{P}\p{S}]/u.test(character)) {
      pendingSpace = builder.length > 0
    }
  }

  return builder.trim()
}

function extractAsciiTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  let start = -1
  for (let index = 0; index <= text.length; index += 1) {
    const isTokenChar = index < text.length && isAsciiLetterOrDigit(text[index] as string)
    if (isTokenChar && start < 0) {
      start = index
    } else if (!isTokenChar && start >= 0) {
      tokens.add(text.slice(start, index))
      start = -1
    }
  }
  return tokens
}

function extractChineseNgrams(text: string): string[] {
  const emitted = new Set<string>()
  const result: string[] = []
  let runStart = -1

  for (let index = 0; index <= text.length; index += 1) {
    const isChineseChar = index < text.length && isChinese(text[index] as string)
    if (isChineseChar && runStart < 0) {
      runStart = index
      continue
    }

    if (!isChineseChar && runStart >= 0) {
      const run = text.slice(runStart, index)
      for (let length = MAX_NGRAM_LENGTH; length >= 2; length -= 1) {
        for (let start = 0; start + length <= run.length; start += 1) {
          if (result.length >= MAX_CHINESE_NGRAMS) {
            return result
          }
          const phrase = run.slice(start, start + length)
          if (!emitted.has(phrase)) {
            emitted.add(phrase)
            result.push(phrase)
          }
        }
      }
      runStart = -1
    }
  }

  return result
}

export function evaluateRelevance(question: string, content: string): MemoryRelevanceResult {
  const questionText = normalize(question)
  const contentText = normalize(content)
  if (questionText.length === 0 || contentText.length === 0) {
    return { score: 0, isRelevant: false, reason: 'NO_RELEVANCE_TRIGGER' }
  }

  let score = 0
  const exactPhrase = questionText.length >= 2 && contentText.includes(questionText)

  const contentTokens = extractAsciiTokens(contentText)
  const questionTokens = extractAsciiTokens(questionText)
  const tokenOverlap = [...new Set([...questionTokens].filter((token) => !ENGLISH_STOP_WORDS.has(token)))]
    .filter((token) => contentTokens.has(token))
    .length
  score += tokenOverlap * 20

  let chineseTwoGramMatches = 0
  let maxChineseOverlap = 0
  for (const phrase of extractChineseNgrams(questionText)) {
    if (CHINESE_STOP_WORDS.has(phrase) || !contentText.includes(phrase)) {
      continue
    }

    maxChineseOverlap = Math.max(maxChineseOverlap, phrase.length)
    if (phrase.length === 2) {
      chineseTwoGramMatches += 1
    }
    score += phrase.length === 2 ? 2 : phrase.length === 3 ? 4 : 8
  }

  if (exactPhrase) {
    score += 100
  }

  const isRelevant = exactPhrase || tokenOverlap > 0 || maxChineseOverlap >= 3 || chineseTwoGramMatches >= 2
  const reason: MemoryRelevanceReason = exactPhrase
    ? 'EXACT_PHRASE'
    : tokenOverlap > 0
      ? 'ASCII_TOKEN_OVERLAP'
      : maxChineseOverlap >= 3 || chineseTwoGramMatches >= 2
        ? 'CHINESE_NGRAM_OVERLAP'
        : 'NO_RELEVANCE_TRIGGER'

  return { score, isRelevant, reason }
}

function compact(text: string): string {
  return normalize(text).replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Closed detection for questions about the current speaker's own name/codename. */
export function isCurrentSelfIdentityQuery(question: string): boolean {
  const text = compact(question)
  if (text.length === 0) {
    return false
  }
  return (
    /我的(?:代号|名字|姓名|昵称|称呼)/u.test(text) ||
    /我叫什么(?:代号|名字|姓名|昵称|称呼)?(?:吗|呢|来着)?$/u.test(text) ||
    /(?:怎么|如何)称呼我(?:吗|呢)?$/u.test(text) ||
    /(?:叫我什么|称呼我什么)(?:代号|名字|姓名|昵称|称呼)?(?:吗|呢)?$/u.test(text)
  )
}

/**
 * A non-self target must be explicit. A bare “代号” keeps the historical
 * lexical behaviour; “服务器代号” / “这个项目叫什么” are explicit other targets.
 */
function isExplicitOtherIdentityQuery(question: string): boolean {
  const text = compact(question)
  if (text.length === 0 || isCurrentSelfIdentityQuery(text) || !IDENTITY_ATTRIBUTE_PATTERN.test(text)) {
    return false
  }
  if (/^(?:代号|名字|姓名|昵称|称呼|名称)(?:是|叫|为|是什么|叫什么)?(?:吗|呢)?$/u.test(text)) {
    return false
  }
  return true
}

function isIdentityAttributeMemory(content: string): boolean {
  const text = compact(content)
  return SELF_IDENTITY_ATTRIBUTE_PATTERN.test(text) || /^我叫/u.test(text)
}

/**
 * Candidate evidence is deliberately two-part: the record must be in this
 * requester's trusted personal scope and its stored subject must be one of the
 * narrow self forms produced by the current extractor/runtime.
 */
export function isCurrentRequesterSelfIdentityMemory(
  record: MemoryRecord,
  context: MemoryRetrievalIdentityContext,
): boolean {
  if (record.scopeType !== context.personalScopeType || record.scopeId !== context.requesterId) {
    return false
  }

  const text = compact(record.content)
  return (
    /^member\d+的?(?:代号|名字|姓名|昵称|称呼)(?:叫|是|为)/u.test(text) ||
    /^用户的?(?:代号|名字|姓名|昵称|称呼)(?:叫|是|为)/u.test(text) ||
    /^我的(?:代号|名字|姓名|昵称|称呼)(?:叫|是|为)/u.test(text) ||
    /^我叫(?!什么|啥|谁).+/u.test(text)
  )
}

export function evaluateSelfIdentityBridge(
  question: string,
  record: MemoryRecord,
  context: MemoryRetrievalIdentityContext,
): SelfIdentityBridgeResult {
  const matched = isCurrentSelfIdentityQuery(question) && isCurrentRequesterSelfIdentityMemory(record, context)
  return matched
    ? {
        matched: true,
        bonus: SELF_IDENTITY_ATTRIBUTE_BRIDGE_BONUS,
        reason: 'SELF_IDENTITY_ATTRIBUTE_BRIDGE',
      }
    : { matched: false, bonus: 0, reason: 'NO_RELEVANCE_TRIGGER' }
}

/** Record-aware policy layered around the unchanged historical lexical rule. */
export function evaluateMemoryRelevance(
  question: string,
  record: MemoryRecord,
  context: MemoryRetrievalIdentityContext,
): MemoryRelevanceResult {
  const lexical = evaluateRelevance(question, record.content)
  const selfMemory = isCurrentRequesterSelfIdentityMemory(record, context)

  if (
    isIdentityAttributeMemory(record.content) &&
    selfMemory &&
    isExplicitOtherIdentityQuery(question)
  ) {
    return { score: 0, isRelevant: false, reason: 'SELF_IDENTITY_TARGET_MISMATCH' }
  }

  if (lexical.isRelevant) {
    return lexical
  }

  const bridge = evaluateSelfIdentityBridge(question, record, context)
  return bridge.matched
    ? { score: lexical.score + bridge.bonus, isRelevant: true, reason: bridge.reason }
    : lexical
}

export function filterAndRank(
  question: string,
  eligible: readonly MemoryRecord[],
  topK: number,
  identityContext?: MemoryRetrievalIdentityContext,
): MemoryRecord[] {
  if (topK <= 0 || eligible.length === 0) {
    return []
  }

  return eligible
    .map((record) => ({
      record,
      relevance: identityContext === undefined
        ? evaluateRelevance(question, record.content)
        : evaluateMemoryRelevance(question, record, identityContext),
    }))
    .filter((item) => item.relevance.isRelevant && item.relevance.score > 0)
    .sort((left, right) => {
      if (right.relevance.score !== left.relevance.score) {
        return right.relevance.score - left.relevance.score
      }
      if (right.record.updatedAt !== left.record.updatedAt) {
        return right.record.updatedAt - left.record.updatedAt
      }
      return left.record.memoryId < right.record.memoryId ? -1 : left.record.memoryId > right.record.memoryId ? 1 : 0
    })
    .slice(0, topK)
    .map((item) => item.record)
}
