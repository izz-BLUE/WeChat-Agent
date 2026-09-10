/**
 * MEMORY_RETRIEVAL_GAP — deterministic regression for the field symptom:
 *
 *   the synthetic persistent store already held "MEMBER_1 的代号是 AlphaTest", but the answer to
 *   "我的代号是什么？" was selectedCount=0 although personalCount=1.
 *
 * The historical cause was a retrieval GATE: the lexical rule was applied as
 * "visible or not" (`filterAndRank`), so one stored wording reached the prompt
 * and another wording of the same fact did not. That function is gone; the
 * classification it used is not.
 *
 * Under the CONTEXTUAL MEMORY WORKING SET the gate is gone. Authorization
 * decides what the model may see; the budget only bounds and orders it; the
 * final model judges relevance. This suite keeps exactly what is still true and
 * measurable:
 *
 *  - the lexical rule and the bounded self-identity bridge are still the
 *    deterministic RELEVANCE RULE, and `evaluateMemoryRelevance` still reports
 *    the same reasons and scores for every query/wording pair;
 *  - every wording of the same fact is now readable through the production
 *    retrieval path, including the one the lexical rule has no trigger for;
 *  - a store that IS unavailable stays a distinct, explicit failure that
 *    injects nothing, and a soft-deleted record stays out of the working set.
 *
 * The rule-level breakdown helpers below are a *diagnostic reproduction* of
 * `memory-relevance.ts` (same normalization, same stop words, same n-gram and
 * token extraction). They are only used to attribute the lexical verdict to a
 * clause; the pass/fail decision of every case always comes from the real
 * implementation.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryExtractor } from './memory-extractor.js'
import type { MemoryAccessRule, MemoryRecord, MemoryScopeType, MemoryVisibility } from './memory-models.js'
import {
  evaluateMemoryRelevance,
  evaluateRelevance,
  SELF_IDENTITY_ATTRIBUTE_BRIDGE_BONUS,
} from './memory-relevance.js'
import { MemoryService } from './memory-service.js'
import { MemoryStore, memoryFileIn } from './memory-store.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

// --------------------------------------------------------------- test harness

const temporaryDirectories: string[] = []

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-memory-retrieval-gap-'))
  temporaryDirectories.push(directory)
  return directory
}

function cleanup(): void {
  for (const directory of temporaryDirectories) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Temp cleanup must never fail the suite.
    }
  }
}

function sequentialIds(): () => string {
  let counter = 0
  return () => {
    counter += 1
    return `gap-${counter.toString().padStart(4, '0')}`
  }
}

/**
 * Synthetic codename fact that preserves the shape of the field symptom without
 * retaining identifiers copied from the runtime store.
 */
const CODENAME = 'AlphaTest'
const FIELD_RECORD_CONTENT = 'MEMBER_1 的代号是 AlphaTest'
const PARAPHRASED_FACT = '用户代号是 AlphaTest'
const REQUESTER_A = 'sig-gap-a'
const ROOM_A = 'room-gap-a@chatroom'

interface Harness {
  directory: string
  store: MemoryStore
  service: MemoryService
  /** Every diagnostic line the memory runtime emitted (counts and enums only). */
  logs: string[]
}

function createHarness(): Harness {
  const logs: string[] = []
  const directory = tempDir()
  const store = new MemoryStore({
    filePath: memoryFileIn(directory),
    log: (message) => logs.push(message),
    pathSource: 'TEST',
  })
  const service = new MemoryService({
    store,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => '{"operation":"NONE"}',
    idFactory: sequentialIds(),
    log: (message) => logs.push(message),
  })
  return { directory, store, service, logs }
}

function seed(
  store: MemoryStore,
  options: {
    memoryId: string
    scopeType: MemoryScopeType
    scopeId: string
    content: string
    visibility?: MemoryVisibility
  },
): void {
  const status = store.add({
    memoryId: options.memoryId,
    scopeType: options.scopeType,
    scopeId: options.scopeId,
    content: options.content,
    contentHash: '',
    visibility: options.visibility ?? 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: ROOM_A,
    sourceSenderId: options.scopeId,
    createdAt: 1,
    updatedAt: 1,
    isDeleted: false,
  })
  assert(status === 'WRITTEN', `seed write failed: ${status}`)
}

interface Retrieval {
  /** Records the store authorized for this request. */
  personalCount: number
  groupCount: number
  /** Records the working set carries into the prompt. */
  selectedCount: number
  items: Array<{ scope: string; content: string }>
  /** The exact production `[MEMORY_READ]` diagnostic line. */
  diagnostic: string
}

function parseReadLine(line: string): { personalCount: number; groupCount: number; selectedCount: number } {
  const read = (name: string): number => Number.parseInt(new RegExp(`${name}=(\\d+)`, 'u').exec(line)?.[1] ?? '-1', 10)
  return { personalCount: read('personalCount'), groupCount: read('groupCount'), selectedCount: read('selectedCount') }
}

/**
 * One real GROUP retrieval through the production service, plus the
 * `[MEMORY_READ]` diagnostic the field log records for it.
 */
async function retrieve(
  harness: Harness,
  question: string,
  options: { requesterId?: string; conversationId?: string } = {},
): Promise<Retrieval> {
  const items = await harness.service.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: options.conversationId ?? ROOM_A,
    requesterId: options.requesterId ?? REQUESTER_A,
    requesterRole: 'MEMBER',
    question,
  })

  const diagnostic = harness.logs.filter((line) => line.includes('[MEMORY_READ]')).pop() ?? ''
  assert(diagnostic.length > 0, 'the production retrieval emitted no [MEMORY_READ] diagnostic')
  const counts = parseReadLine(diagnostic)

  return {
    personalCount: counts.personalCount,
    groupCount: counts.groupCount,
    selectedCount: counts.selectedCount,
    items: items.map((item) => ({ scope: item.scope, content: item.content })),
    diagnostic,
  }
}

// ------------------------------------------- diagnostic rule-level breakdown

const MAX_NORMALIZED_CHARS = 512
const MAX_CHINESE_NGRAMS = 256
const MAX_NGRAM_LENGTH = 6

const ENGLISH_STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'what', 'my', 'your', 'me', 'you'])

const CHINESE_STOP_WORDS = new Set([
  '我', '你', '他', '她', '它', '的', '了', '是', '吗', '呢', '啊', '吧',
  '这个', '那个', '什么', '怎么', '一下', '刚才', '之前', '现在', '最近',
])

function isAsciiLetterOrDigit(character: string): boolean {
  return /^[A-Za-z0-9]$/u.test(character)
}

function isChinese(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
}

/** Diagnostic reproduction of the historical normalization. */
function normalize(text: string): string {
  let builder = ''
  let pendingSpace = false
  for (const character of text.trim()) {
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

function extractAsciiTokens(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+/u).filter((token) => token.length > 0)
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

interface RelevanceBreakdown {
  normalizedQuestion: string
  normalizedContent: string
  exactPhrase: boolean
  tokenOverlap: number
  sharedTokens: string[]
  maxChineseOverlap: number
  chineseTwoGramMatches: number
  /** The Chinese phrases the query contributed that the memory also contains. */
  sharedChinesePhrases: string[]
  /** Query n-grams that the memory does *not* contain, longest first. */
  unmatchedLongestPhrases: string[]
}

/** Attributes a lexical verdict to a specific clause of the rule. */
function breakdown(question: string, content: string): RelevanceBreakdown {
  const normalizedQuestion = normalize(question)
  const normalizedContent = normalize(content)

  const exactPhrase = normalizedQuestion.length >= 2 && normalizedContent.includes(normalizedQuestion)

  const contentTokens = new Set(extractAsciiTokens(normalizedContent))
  const sharedTokens = [...new Set(extractAsciiTokens(normalizedQuestion))].filter(
    (token) => !ENGLISH_STOP_WORDS.has(token) && contentTokens.has(token),
  )

  let maxChineseOverlap = 0
  let chineseTwoGramMatches = 0
  const sharedChinesePhrases: string[] = []
  const unmatched: string[] = []
  for (const phrase of extractChineseNgrams(normalizedQuestion)) {
    if (CHINESE_STOP_WORDS.has(phrase)) {
      continue
    }
    if (normalizedContent.includes(phrase)) {
      maxChineseOverlap = Math.max(maxChineseOverlap, phrase.length)
      sharedChinesePhrases.push(phrase)
      if (phrase.length === 2) {
        chineseTwoGramMatches += 1
      }
    } else {
      unmatched.push(phrase)
    }
  }

  return {
    normalizedQuestion,
    normalizedContent,
    exactPhrase,
    tokenOverlap: sharedTokens.length,
    sharedChinesePhrases,
    sharedTokens,
    maxChineseOverlap,
    chineseTwoGramMatches,
    unmatchedLongestPhrases: unmatched.sort((left, right) => right.length - left.length).slice(0, 4),
  }
}

/** The query would be lexically relevant under the historical rule. */
function breakdownIsRelevant(input: RelevanceBreakdown): boolean {
  return input.exactPhrase || input.tokenOverlap > 0 || input.maxChineseOverlap >= 3 || input.chineseTwoGramMatches >= 2
}

/** One-line, log-safe reason for the RCA table. */
function formatBreakdown(input: RelevanceBreakdown): string {
  return (
    `exactPhrase=${input.exactPhrase} tokenOverlap=${input.tokenOverlap}` +
    ` maxChineseOverlap=${input.maxChineseOverlap} chinese2gramMatches=${input.chineseTwoGramMatches}` +
    ` sharedChinese=[${input.sharedChinesePhrases.join(',') || 'NONE'}]` +
    ` sharedAscii=[${input.sharedTokens.join(',') || 'NONE'}]` +
    ` queryNgramsNotFound=[${input.unmatchedLongestPhrases.join(',') || 'NONE'}]`
  )
}

/** One query, one stored wording, and how the production path answered it. */
interface Probe {
  query: string
  memory: string
  eligible: number
  selected: number
  selectedContent: string | null
  rules: RelevanceBreakdown
}

async function probe(question: string, memory: string): Promise<Probe> {
  const harness = createHarness()
  seed(harness.store, {
    memoryId: 'gap-codename',
    scopeType: 'MEMBER',
    scopeId: REQUESTER_A,
    content: memory,
  })
  const result = await retrieve(harness, question)
  return {
    query: question,
    memory,
    eligible: result.personalCount,
    selected: result.selectedCount,
    selectedContent: result.items[0]?.content ?? null,
    rules: breakdown(question, memory),
  }
}

function report(probeResult: Probe, label: string): void {
  console.log(
    `[RETRIEVAL_GAP] case=${label} query="${probeResult.query}" memory="${probeResult.memory}"` +
    ` eligible=${probeResult.eligible} selected=${probeResult.selected}` +
    ` lexical=${breakdownIsRelevant(probeResult.rules) ? 'RELEVANT' : 'NOT_RELEVANT'}`,
  )
  console.log(`[RETRIEVAL_GAP] case=${label} ${formatBreakdown(probeResult.rules)}`)
}

/** The three questions the acceptance contract requires, verbatim. */
const REQUIRED_QUERIES = ['我的代号是什么？', '我叫什么代号？', '你还记得我的代号吗？'] as const

/** Extra questions the same personal codename record can be asked. */
const EXTRA_QUERIES = [
  '我的代号是什么',
  '用户代号',
  '代号',
  'AlphaTest',
  '我的代号是 AlphaTest 吗？',
] as const

const ALL_QUERIES = [...REQUIRED_QUERIES, ...EXTRA_QUERIES]

/** Closed current-requester identity questions accepted by the convergence. */
const SELF_IDENTITY_QUERIES = [
  '我的代号是什么？',
  '我叫什么代号？',
  '你还记得我的代号吗？',
  '我的名字是什么？',
  '我叫什么名字？',
  '我的昵称是什么？',
  '你怎么称呼我？',
  '你还记得我叫什么吗？',
  '我是谁',
  '我是谁？',
  '你知道我是谁吗',
] as const

/** Stored self-fact surface forms seen in the runtime or allowed by the extractor. */
const SELF_IDENTITY_MEMORIES = [
  FIELD_RECORD_CONTENT,
  PARAPHRASED_FACT,
  '我的代号叫 AlphaTest',
  '我叫 AlphaTest',
] as const

// ------------------------------------------------------------------ the cases

/**
 * A synthetic record with the same field shape, replayed through the production
 * retrieval path with every question the acceptance contract requires.
 *
 * The wording is no longer the variable that decides visibility: one authorized
 * record is one working-set entry, whatever the question says.
 */
async function testSyntheticFieldShapeAgainstRequiredQueries(): Promise<void> {
  const results: Probe[] = []
  for (const query of ALL_QUERIES) {
    const result = await probe(query, FIELD_RECORD_CONTENT)
    report(result, 'field-record')
    results.push(result)
  }

  const failures: string[] = []
  for (const result of results) {
    if (result.eligible !== 1) {
      failures.push(`"${result.query}": eligible=${result.eligible}, expected the single stored record`)
    }
    if (result.selected !== 1 || result.selectedContent === null) {
      failures.push(`"${result.query}": selected=${result.selected}, expected the authorized record in the working set`)
    }
  }
  assert(failures.length === 0, `the authorized fact did not reach the working set: ${failures.join('; ')}`)

  for (const field of results.slice(0, REQUIRED_QUERIES.length)) {
    assert(field.selected === 1, `"${field.query}" no longer carries the synthetic field-shape fixture`)
    assert(field.selectedContent?.includes(CODENAME) === true, 'the working-set item lost the codename content')
  }
}

/**
 * The wording the lexical rule has no trigger for is still readable, and the
 * lexical verdict itself is unchanged. That is the whole point: relevance is no
 * longer the gate, the rule is still the rule.
 */
async function testLexicallyUnreachableWordingIsStillProvided(): Promise<void> {
  const unreachable = '我叫 AlphaTest'
  const result = await probe('我的代号是什么？', unreachable)
  report(result, 'unreachable-wording')

  assert(
    result.eligible === 1,
    `the record was not eligible, so the case no longer isolates retrieval: eligible=${result.eligible}`,
  )
  assert(
    !breakdownIsRelevant(result.rules),
    `the wording now shares a rule trigger with the question: ${formatBreakdown(result.rules)}`,
  )
  assert(
    result.selected === 1 && result.selectedContent?.includes(CODENAME) === true,
    `a lexically unreachable wording did not reach the working set: selected=${result.selected}`,
  )
  const effective = evaluateMemoryRelevance('我的代号是什么？', relevanceRecord(unreachable), {
    requesterId: REQUESTER_A,
    personalScopeType: 'MEMBER',
  })
  assert(
    effective.reason === 'SELF_IDENTITY_ATTRIBUTE_BRIDGE',
    `the self-identity bridge no longer recognises the wording: reason=${effective.reason}`,
  )

  const reachable = await probe('我的代号是什么？', PARAPHRASED_FACT)
  report(reachable, 'reachable-wording')
  assert(
    reachable.selected === 1 && reachable.selectedContent?.includes(CODENAME) === true,
    `the shared-term wording did not reach the working set: selected=${reachable.selected}`,
  )
}

/**
 * Every required question against both real wordings converges: authorization
 * and the budget do not depend on the wording at all.
 */
async function testRequiredQueriesAcrossStoredWordings(): Promise<void> {
  const wordings = [FIELD_RECORD_CONTENT, PARAPHRASED_FACT]
  const rows: string[] = []
  const failures: string[] = []

  for (const memory of wordings) {
    for (const query of REQUIRED_QUERIES) {
      const result = await probe(query, memory)
      report(result, 'wording-matrix')
      rows.push(
        `query="${query}" memory="${memory}" eligible=${result.eligible}` +
        ` selected=${result.selected} lexical=${breakdownIsRelevant(result.rules) ? 'RELEVANT' : 'NOT_RELEVANT'}`,
      )
      if (result.eligible !== 1) {
        failures.push(`"${query}" / "${memory}": eligible=${result.eligible}`)
      }
      if (result.selected !== 1 || result.selectedContent?.includes(CODENAME) !== true) {
        failures.push(`"${query}" / "${memory}": selected=${result.selected}`)
      }
    }
  }

  assert(failures.length === 0, `the wording matrix disagreed with the working set: ${failures.join('; ')}`)
  console.log(`[RETRIEVAL_GAP] wordingMatrixRows=${rows.length}`)
}

/**
 * The historical lexical miss is still measurable — it just no longer hides the
 * record. `evaluateMemoryRelevance` reports the bridge for exactly those pairs,
 * and every one of them is provided to the final model.
 */
async function testHistoricalLexicalMissesAreNoLongerAGate(): Promise<void> {
  const unreachable = '我叫 AlphaTest'
  const sharedTerm: string[] = []
  const noSharedTerm: string[] = []

  for (const query of REQUIRED_QUERIES) {
    const result = await probe(query, unreachable)
    report(result, 'attribution')
    if (breakdownIsRelevant(result.rules)) {
      sharedTerm.push(query)
    } else {
      noSharedTerm.push(query)
    }
    assert(result.selected === 1, `"${query}" did not carry the authorized record into the working set`)
  }

  console.log(
    `[RETRIEVAL_GAP] attribution sharedTerm=[${sharedTerm.join('|') || 'NONE'}]` +
    ` noSharedTerm=[${noSharedTerm.join('|') || 'NONE'}]`,
  )
  assert(
    noSharedTerm.length > 0,
    'every required question now shares a rule trigger; the lexical attribution is stale',
  )
}

/**
 * Not a capacity effect: the eligible count and the working-set count are both
 * reported, and the historical explicit candidate limit is untouched.
 */
async function testWorkingSetDoesNotChangeCapacityLimits(): Promise<void> {
  const harness = createHarness()
  seed(harness.store, {
    memoryId: 'gap-codename',
    scopeType: 'MEMBER',
    scopeId: REQUESTER_A,
    content: '我叫 AlphaTest',
  })

  const eligible = harness.store.retrieve(
    [{ scopeType: 'MEMBER', scopeId: REQUESTER_A, visibility: 'SHARED' } as MemoryAccessRule],
    30,
  )
  assert(eligible.length === 1, `the store returned ${eligible.length} eligible records instead of 1`)

  const result = await retrieve(harness, '我的代号是什么？')
  assert(result.personalCount === 1, `eligible count changed: ${result.personalCount}`)
  assert(result.groupCount === 0, `an unexpected group record was eligible: ${result.groupCount}`)
  assert(result.selectedCount === 1, `the bridged fact was not provided: selectedCount=${result.selectedCount}`)
  assert(result.items[0]?.content.includes(CODENAME) === true, 'the provided fact lost its content')
  assert(
    result.diagnostic.includes('result=PASS'),
    'a retrieval outcome was reported as a store failure',
  )
}

/**
 * Retrieval no longer drops a fact for wording, so the remaining drop reasons are
 * the ones that must stay: a corrupt store fails closed and injects nothing, and
 * a soft-deleted record leaves the working set.
 */
async function testTheFactIsPersistedAndScopeReadableThroughout(): Promise<void> {
  const harness = createHarness()
  seed(harness.store, {
    memoryId: 'gap-codename',
    scopeType: 'MEMBER',
    scopeId: REQUESTER_A,
    content: '我叫 AlphaTest',
  })

  await retrieve(harness, '我的代号是什么？')

  assert(harness.store.isEnabled, 'the store disabled itself during a working-set read')
  assert(harness.store.liveRecordCount === 1, 'the working-set read changed the stored record count')

  const document = JSON.parse(readFileSync(memoryFileIn(harness.directory), 'utf8')) as {
    records: Array<{ content: string; isDeleted: boolean }>
  }
  const stored = document.records.find((record) => record.content === '我叫 AlphaTest')
  assert(stored !== undefined, 'the codename fact is no longer on disk')
  assert(stored.isDeleted === false, 'the codename fact was soft deleted by a read')

  // A soft-deleted record is not authorized, so it cannot be in the working set.
  assert(harness.store.delete('gap-codename', 2), 'the soft delete failed')
  const afterDelete = await retrieve(harness, '我的代号是什么？')
  assert(afterDelete.selectedCount === 0, 'a soft-deleted record entered the working set')

  // A corrupted store is a different failure mode: it injects nothing and
  // reports the store as unavailable instead of degrading into "no memory".
  const corruptDirectory = tempDir()
  writeFileSync(memoryFileIn(corruptDirectory), '{ "version": 1, "records": [ { broken', 'utf8')
  const corruptLogs: string[] = []
  const corruptStore = new MemoryStore({
    filePath: memoryFileIn(corruptDirectory),
    log: (message) => corruptLogs.push(message),
    pathSource: 'TEST',
  })
  const corruptService = new MemoryService({
    store: corruptStore,
    extractor: new MemoryExtractor(async () => '[]'),
    mutate: async () => '{"operation":"NONE"}',
    log: (message) => corruptLogs.push(message),
  })
  const corruptItems = await corruptService.retrieveForChat({
    conversationType: 'GROUP',
    conversationId: ROOM_A,
    requesterId: REQUESTER_A,
    requesterRole: 'MEMBER',
    question: '我的代号是什么？',
  })
  assert(corruptItems.length === 0, 'a corrupt store injected memory')
  assert(
    corruptLogs.join('\n').includes('reason=STORE_UNAVAILABLE'),
    'a corrupt store was not reported as unavailable',
  )
}

function relevanceRecord(content: string, scopeType: MemoryScopeType = 'MEMBER', scopeId = REQUESTER_A): MemoryRecord {
  return {
    memoryId: 'relevance-record',
    scopeType,
    scopeId,
    content,
    contentHash: '',
    visibility: 'SHARED',
    origin: 'AUTOMATIC',
    sourceConversationType: 'GROUP',
    sourceConversationId: ROOM_A,
    sourceSenderId: scopeId,
    createdAt: 1,
    updatedAt: 1,
    isDeleted: false,
  }
}

/**
 * Target contract, unchanged: only a current-requester self-identity question
 * may bridge the narrow lexical gap, and only to a current-requester
 * self-identity record. The rule is still exact — it is simply no longer what
 * decides whether the model may read the record.
 */
async function testSelfIdentityLexicalConvergenceContract(): Promise<void> {
  const failures: string[] = []

  for (const memory of SELF_IDENTITY_MEMORIES) {
    for (const query of SELF_IDENTITY_QUERIES) {
      const result = await probe(query, memory)
      if (result.eligible !== 1 || result.selected !== 1 || result.selectedContent?.includes(CODENAME) !== true) {
        failures.push(`positive query="${query}" memory="${memory}" eligible=${result.eligible} selected=${result.selected}`)
      }

      const lexical = evaluateRelevance(query, memory)
      const effective = evaluateMemoryRelevance(query, relevanceRecord(memory), {
        requesterId: REQUESTER_A,
        personalScopeType: 'MEMBER',
      })
      if (lexical.isRelevant) {
        if (effective.score !== lexical.score || effective.reason !== lexical.reason) {
          failures.push(`strong lexical match was boosted query="${query}" memory="${memory}"`)
        }
      } else if (
        effective.reason !== 'SELF_IDENTITY_ATTRIBUTE_BRIDGE' ||
        effective.score !== lexical.score + SELF_IDENTITY_ATTRIBUTE_BRIDGE_BONUS
      ) {
        failures.push(
          `bridge reason/score query="${query}" memory="${memory}"` +
          ` score=${effective.score} reason=${effective.reason}`,
        )
      }
    }
  }

  const nonSelfQueries = ['这个项目叫什么？', '服务器代号是什么？', '这个接口叫什么名字？'] as const
  for (const query of nonSelfQueries) {
    const result = await probe(query, PARAPHRASED_FACT)
    if (result.selected !== 1) {
      failures.push(`authorized record was withheld for a non-self query="${query}" selected=${result.selected}`)
    }
    const effective = evaluateMemoryRelevance(query, relevanceRecord(PARAPHRASED_FACT), {
      requesterId: REQUESTER_A,
      personalScopeType: 'MEMBER',
    })
    if (effective.reason === 'SELF_IDENTITY_ATTRIBUTE_BRIDGE') {
      failures.push(`the bridge fired for a non-self query="${query}"`)
    }
  }
  const serverMismatch = evaluateMemoryRelevance(
    '服务器代号是什么？',
    relevanceRecord(PARAPHRASED_FACT),
    { requesterId: REQUESTER_A, personalScopeType: 'MEMBER' },
  )
  if (serverMismatch.isRelevant || serverMismatch.reason !== 'SELF_IDENTITY_TARGET_MISMATCH') {
    failures.push(`server mismatch reason=${serverMismatch.reason} score=${serverMismatch.score}`)
  }

  for (const [memory, query] of [
    ['项目代号是 Apollo', '我叫什么？'],
    ['项目代号是 Apollo', '我的名字是什么？'],
    ['服务器名称是 DB-PROD-01', '我的名字是什么？'],
  ] as const) {
    const result = await probe(query, memory)
    if (result.selected !== 1 || result.selectedContent !== memory) {
      failures.push(`non-self memory="${memory}" query="${query}" selected=${result.selected}`)
    }
    const effective = evaluateMemoryRelevance(query, relevanceRecord(memory), {
      requesterId: REQUESTER_A,
      personalScopeType: 'MEMBER',
    })
    if (effective.reason === 'SELF_IDENTITY_ATTRIBUTE_BRIDGE') {
      failures.push(`the bridge fired for a non-self memory="${memory}" query="${query}"`)
    }
  }

  // Authorization is still the gate that matters: another requester's personal
  // memory is not eligible and therefore cannot be provided either.
  const isolated = createHarness()
  seed(isolated.store, {
    memoryId: 'other-requester',
    scopeType: 'MEMBER',
    scopeId: 'sig-gap-b',
    content: 'MEMBER_2 的代号叫 Alice',
  })
  const isolatedResult = await retrieve(isolated, '我叫什么？', { requesterId: REQUESTER_A })
  if (isolatedResult.personalCount !== 0 || isolatedResult.selectedCount !== 0) {
    failures.push(
      `cross-requester personal=${isolatedResult.personalCount} selected=${isolatedResult.selectedCount}`,
    )
  }

  const conflict = createHarness()
  seed(conflict.store, {
    memoryId: 'memory-test-alpha',
    scopeType: 'MEMBER',
    scopeId: REQUESTER_A,
    content: PARAPHRASED_FACT,
  })
  seed(conflict.store, {
    memoryId: 'group-apollo',
    scopeType: 'GROUP',
    scopeId: ROOM_A,
    content: '项目代号是 Apollo',
  })
  const conflictResult = await retrieve(conflict, '我叫什么？')
  if (
    conflictResult.selectedCount !== 2 ||
    conflictResult.items.some((item) => item.content.includes(CODENAME)) !== true ||
    conflictResult.items.some((item) => item.content.includes('Apollo')) !== true
  ) {
    failures.push(
      `authorized working set selected=${conflictResult.selectedCount}` +
      ` contents=${conflictResult.items.map((item) => item.content).join('|') || 'NONE'}`,
    )
  }

  assert(failures.length === 0, `self-identity lexical convergence failed: ${failures.join('; ')}`)
}

// ------------------------------------------------------------------ execution

const CASES: Array<[string, () => Promise<void>]> = [
  ['synthetic-field-shape-against-required-queries', testSyntheticFieldShapeAgainstRequiredQueries],
  ['lexically-unreachable-wording-is-still-provided', testLexicallyUnreachableWordingIsStillProvided],
  ['required-queries-across-stored-wordings', testRequiredQueriesAcrossStoredWordings],
  ['lexical-misses-are-no-longer-a-gate', testHistoricalLexicalMissesAreNoLongerAGate],
  ['working-set-does-not-change-capacity-limits', testWorkingSetDoesNotChangeCapacityLimits],
  ['fact-stays-persisted-and-scope-readable', testTheFactIsPersistedAndScopeReadableThroughout],
  ['self-identity-lexical-convergence', testSelfIdentityLexicalConvergenceContract],
]

let failures = 0
for (const [name, run] of CASES) {
  try {
    await run()
    console.log(`[RETRIEVAL_GAP_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    const message = error instanceof Error ? error.message : String(error)
    console.log(`[RETRIEVAL_GAP_CASE] name=${name} result=FAIL message=${message}`)
  }
}

cleanup()
console.log(`[RETRIEVAL_GAP_TEST_SUMMARY] cases=${CASES.length} failures=${failures}`)
if (failures > 0) {
  console.log('[MEMORY_RETRIEVAL_GAP] result=BLOCKED')
  process.exitCode = 1
} else {
  console.log('[MEMORY_RETRIEVAL_GAP] result=CONVERGED')
}
