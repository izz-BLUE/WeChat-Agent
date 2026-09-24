import { detectProviderControlMarkup, ProviderControlMarkupError } from './final-answer.js'
import type { RequestDeadline } from './request-deadline.js'
import { isRequestDeadlineExceeded } from './request-deadline.js'
import type { StructuredCompletion } from './web-search-planner.js'
import type { WebSearchMode, WebSearchResult, WebSearchWindow } from './web-search.js'

export type RetrievalQualityDecision = 'ANSWERABLE' | 'RETRY' | 'STOP'
export type RetrievalQualityAuthority =
  | 'PRIMARY_OFFICIAL'
  | 'AUTHORITATIVE_SECONDARY'
  | 'GENERAL_SECONDARY'
  | 'UGC'
  | 'AGGREGATION_LOW_SIGNAL'

export type RetrievalQualityCheapBlocker =
  | 'HIGH_EVIDENCE_CLAIM'
  | 'NO_PAGE_EVIDENCE'
  | 'NO_FRESHNESS_EVIDENCE'
  | 'NO_PRIMARY_SOURCE'
  | 'NO_DIRECT_EVIDENCE'
  | 'NONE'

export interface RetrievalQualityResultMetadata {
  title: string
  hostname: string
  snippet: string
  publishedAt?: string | null
  pageFetchStatus?: WebSearchResult['pageFetchStatus']
  pageEvidence?: string
}

export interface RetrievalQualityGateInput {
  question: string
  round: 1
  mode: WebSearchMode
  primaryQuery: string
  alternateQuery?: string | null
  results: readonly RetrievalQualityResultMetadata[]
}

export interface RetrievalQualityGateDecision {
  decision: RetrievalQualityDecision
  reason: string
  missingEvidence: string
  retryQuery: string | null
  retryAlternateQuery: string | null
  mode: WebSearchMode
  window: WebSearchWindow
}

export type RetrievalQualityGateFailure =
  | 'INVALID_PROTOCOL'
  | 'IDENTITY_GUARD'
  | 'COMPLETION_ERROR'
  | 'PROVIDER_CONTROL_MARKUP'

export interface RetrievalQualityGateResult {
  result: 'PASS' | 'FAIL'
  decision: RetrievalQualityGateDecision
  failureReason?: RetrievalQualityGateFailure
}

export interface RetrievalQualityGateLike {
  decide(input: RetrievalQualityGateInput, forbiddenValues?: readonly string[], deadline?: RequestDeadline, msgIdToken?: string): Promise<RetrievalQualityGateResult>
}

export interface RetrievalQualitySignals {
  resultCount: number
  fetchedCount: number
  uniqueHostCount: number
  authorityHighCount: number
  authorityLowCount: number
  missingEvidencePresent: boolean
  shouldRunGate: boolean
  cheapEligible: boolean
  cheapBlocker: RetrievalQualityCheapBlocker
}

export interface RetrievalQualityAssessmentOptions {
  mode?: WebSearchMode
  window?: WebSearchWindow
  datedResultCount?: number
}

const STOP_DECISION: RetrievalQualityGateDecision = {
  decision: 'STOP',
  reason: 'GATE_FAILED_CLOSED',
  missingEvidence: '',
  retryQuery: null,
  retryAlternateQuery: null,
  mode: 'GENERAL',
  window: 'GENERAL',
}

const RETRIEVAL_QUALITY_SYSTEM_PROMPT = `你是 Retrieval Quality Gate，只负责判断第一轮公开检索证据是否足以回答当前问题。
你不生成最终答案，不调用工具，不解释事实，只输出下面严格的七行协议：
DECISION=ANSWERABLE 或 DECISION=RETRY 或 DECISION=STOP
REASON=<只使用大写字母、数字和下划线的短原因>
MISSING_EVIDENCE=<缺失证据的短描述；足够时为空>
RETRY_QUERY=<仅 RETRY 时填写一次有针对性的公开检索 query，否则为空>
RETRY_ALT_QUERY=<可选的第二个互补 query，否则为空>
SEARCH_MODE=GENERAL 或 SEARCH_MODE=NEWS_RECENT
RECENCY_WINDOW=NONE 或 RECENCY_WINDOW=DAY_1 或 RECENCY_WINDOW=DAY_3

ANSWERABLE 只表示当前证据足以回答 CURRENT QUESTION；仅仅提到同一实体不算足够。
RETRY 必须针对 MISSING_EVIDENCE 补证据，不能只是原 query 的同义改写：排名要补排名、粉丝、并发或热度比较数据；配音要补 CV、声优或官方资料；名字由来要补官方设定、制作组、访谈或明确出处。
STOP 表示当前不应继续补搜。不要把网页推测当作事实。SEARCH_MODE=NEWS_RECENT 只能用于明确近期动态，且 RECENCY_WINDOW 只能是 DAY_1 或 DAY_3。
不要输出身份、会话标识、Memory、群聊历史或任何内部字段。`

function unwrapProtocolFence(raw: string): string {
  const trimmed = raw.trim()
  const match = /^```(?:text)?\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed)
  return match?.[1] ?? trimmed
}

function containsInternalValue(value: string): boolean {
  return /(?:^|[^A-Z0-9_])(?:MEMBER|SPEAKER|AMBIENT_SPEAKER)_\d+(?:$|[^A-Z0-9_])|CURRENT_REQUESTER|ASSISTANT|CURRENTREQUESTER|REQUESTERID|SENDERID|CONVERSATIONID|OWNERID|WXID|MEMORYID/iu.test(value)
}

function containsForbiddenValue(value: string, forbiddenValues: readonly string[]): boolean {
  return forbiddenValues.some((forbidden) => forbidden.length > 0 && value.includes(forbidden))
}

function invalid(failureReason: RetrievalQualityGateFailure): { valid: false; decision: RetrievalQualityDecision; failureReason: RetrievalQualityGateFailure } {
  return { valid: false, decision: STOP_DECISION.decision, failureReason }
}

export function parseRetrievalQualityProtocol(
  raw: string,
  input: Pick<RetrievalQualityGateInput, 'primaryQuery'>,
  forbiddenValues: readonly string[] = [],
): { valid: true; decision: RetrievalQualityGateDecision } | { valid: false; decision: RetrievalQualityDecision; failureReason: RetrievalQualityGateFailure } {
  const lines = unwrapProtocolFence(raw).split(/\r\n|\n|\r/u)
  const prefixes = ['DECISION=', 'REASON=', 'MISSING_EVIDENCE=', 'RETRY_QUERY=', 'RETRY_ALT_QUERY=', 'SEARCH_MODE=', 'RECENCY_WINDOW=']
  if (lines.length !== prefixes.length || prefixes.some((prefix, index) => !lines[index]?.startsWith(prefix))) {
    return invalid('INVALID_PROTOCOL')
  }
  const value = (index: number, prefix: string): string => lines[index]!.slice(prefix.length).trim()
  const decision = value(0, prefixes[0]!)
  const reason = value(1, prefixes[1]!)
  const missingEvidence = value(2, prefixes[2]!)
  const retryQuery = value(3, prefixes[3]!)
  const retryAlternateQuery = value(4, prefixes[4]!)
  const mode = value(5, prefixes[5]!)
  const window = value(6, prefixes[6]!)
  if (decision === null || reason === null || missingEvidence === null || retryQuery === null ||
      retryAlternateQuery === null || mode === null || window === null ||
      !/^[A-Z0-9_]{1,80}$/u.test(reason) || missingEvidence.length > 240 ||
      retryQuery.length > 240 || retryAlternateQuery.length > 240 ||
      [missingEvidence, retryQuery, retryAlternateQuery].some((value) => containsInternalValue(value) || containsForbiddenValue(value, forbiddenValues))) {
    return invalid(containsInternalValue(`${missingEvidence ?? ''} ${retryQuery ?? ''} ${retryAlternateQuery ?? ''}`) ||
      containsForbiddenValue(`${missingEvidence ?? ''} ${retryQuery ?? ''} ${retryAlternateQuery ?? ''}`, forbiddenValues)
      ? 'IDENTITY_GUARD'
      : 'INVALID_PROTOCOL')
  }
  if ((decision !== 'ANSWERABLE' && decision !== 'RETRY' && decision !== 'STOP') ||
      (mode !== 'GENERAL' && mode !== 'NEWS_RECENT') ||
      (window !== 'NONE' && window !== 'DAY_1' && window !== 'DAY_3')) {
    return invalid('INVALID_PROTOCOL')
  }
  if (decision === 'RETRY') {
    if (missingEvidence.length === 0 || retryQuery.length === 0 || retryQuery === input.primaryQuery ||
        (mode === 'GENERAL' && window !== 'NONE') || (mode === 'NEWS_RECENT' && window === 'NONE')) {
      return invalid('INVALID_PROTOCOL')
    }
  } else if (retryQuery.length > 0 || retryAlternateQuery.length > 0 || mode !== 'GENERAL' || window !== 'NONE') {
    return invalid('INVALID_PROTOCOL')
  }
  return {
    valid: true,
    decision: {
      decision,
      reason,
      missingEvidence,
      retryQuery: retryQuery || null,
      retryAlternateQuery: retryAlternateQuery || null,
      mode,
      window: window === 'NONE' ? 'GENERAL' : window,
    },
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLocaleLowerCase()
  } catch {
    return ''
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLocaleLowerCase()
  } catch {
    return ''
  }
}

function isUploaderClaim(question: string): boolean {
  return /(?:主播|UP主|博主|作者|账号|个人主页|上传|发布|B站|哔哩哔哩|视频)/iu.test(question)
}

function isComparativeClaim(question: string): boolean {
  return /(?:最大|最高|最多|排名|第一|榜|粉丝|关注|热度|流量|并发|同时在线|人气|比较)/u.test(question)
}

function isExactEntityMappingClaim(question: string): boolean {
  return /(?:是谁.*(?:配音|声优|CV)|(?:配音|声优|CV).*是谁|配音演员|声优|CV|饰演|扮演)/iu.test(question)
}

function isOriginClaim(question: string): boolean {
  return /(?:为什么|为何|由来|来源|命名|名字.{0,8}(?:来|来源)|起因|原因)/u.test(question)
}

function isCurrentClaim(question: string, mode: WebSearchMode): boolean {
  return mode === 'NEWS_RECENT' || /(?:目前|现在|当前|最新|最近|今天|价格|版本|实时|现状)/u.test(question)
}

export function classifyRetrievalAuthority(question: string, result: WebSearchResult): RetrievalQualityAuthority {
  const host = hostOf(result.url)
  const path = pathOf(result.url)
  const text = `${result.title} ${result.snippet}`
  if (/(?:\.gov(?:\.[a-z]{2})?$|\.edu(?:\.[a-z]{2})?$|openai\.com$|deepseek\.com$|microsoft\.com$|google\.com$)/iu.test(host) ||
      /(?:\/docs?(?:\/|$)|\/developer(?:\/|$)|\/api(?:\/|$)|\/official(?:\/|$)|\/about(?:\/|$)|\/newsroom(?:\/|$)|\/press(?:\/|$))/u.test(path)) {
    return 'PRIMARY_OFFICIAL'
  }
  if (/(?:wikipedia|wikimedia|reuters|apnews|bbc|thepaper|36kr|caixin|gov\.cn|cnki)/iu.test(host) ||
      /(?:百科|资料库|数据库|档案|访谈|专访)/u.test(text)) {
    return 'AUTHORITATIVE_SECONDARY'
  }
  if (/(?:bilibili|douyin|youtube|weibo|xiaohongshu|zhihu)\.(?:com|cn)$/iu.test(host)) {
    return 'UGC'
  }
  if (/(?:search|result|feed|tag|recommend|aggregat|content-farm)/iu.test(`${host}${path}`)) {
    return 'AGGREGATION_LOW_SIGNAL'
  }
  if (isComparativeClaim(question) || isExactEntityMappingClaim(question)) {
    return 'GENERAL_SECONDARY'
  }
  return 'GENERAL_SECONDARY'
}

function hasQuestionOverlap(question: string, result: WebSearchResult): boolean {
  const normalized = question.normalize('NFKC').toLocaleLowerCase()
  const text = `${result.title} ${result.snippet}`.normalize('NFKC').toLocaleLowerCase()
  const chinese = [...normalized.matchAll(/[\p{Script=Han}]{2,}/gu)].map((match) => match[0] ?? '')
  const english = [...normalized.matchAll(/[a-z0-9][a-z0-9._-]{1,}/giu)].map((match) => (match[0] ?? '').toLocaleLowerCase())
  return normalized.length > 0 && (text.includes(normalized) || chinese.some((part) => text.includes(part)) || english.some((part) => text.includes(part)))
}

function resultText(result: WebSearchResult): string {
  return `${result.title} ${result.snippet} ${result.pageText ?? ''}`
}

function isPrimaryOfficial(authority: RetrievalQualityAuthority): boolean {
  return authority === 'PRIMARY_OFFICIAL'
}

function hasPageEvidence(result: WebSearchResult): boolean {
  return result.pageFetchStatus === 'PASS' && (result.pageText?.length ?? 0) > 0
}

function hasDirectAnswerSignal(question: string, result: WebSearchResult): boolean {
  const text = resultText(result)
  const explicitFact = /(?:API\s*Base|默认值|默认参数|版本(?:号|是)?|当前版本|配音(?:演员)?\s*[:：是为]|声优\s*[:：是为]|CV\s*[:：=]|名字由来|命名|取名|排名|粉丝|关注|并发|同接|热度)/iu.test(text)
  return explicitFact || (hasQuestionOverlap(question, result) && hasPageEvidence(result))
}

function hasExplicitMappingEvidence(result: WebSearchResult): boolean {
  return /(?:配音(?:演员)?\s*[:：是为]|声优\s*[:：是为]|CV\s*[:：=]|由[^。！？]{0,40}(?:配音|声优))/iu.test(resultText(result))
}

function hasExplicitOriginEvidence(result: WebSearchResult): boolean {
  return /(?:名字由来|命名原因|命名\s*[:：][^。！？]{1,80}|因[^。！？]{0,40}得名|名字[^。！？]{0,40}(?:因为|源于|来自))/u.test(resultText(result))
}

function hasExplicitComparativeEvidence(result: WebSearchResult): boolean {
  const text = resultText(result)
  const metric = /(?:排名|排行|粉丝|关注|并发|同接|在线|热度)/u.test(text)
  const quantified = /(?:第[一二三四五六七八九十百千万\d]+\s*[名位]?|第一|最多|最高|\d[\d,.万亿]*\s*(?:万|亿)?)/u.test(text)
  return metric && quantified
}

function hasCurrentEvidence(result: WebSearchResult): boolean {
  return /(?:当前|目前|最新|截至|版本\s*\d|v\d|价格|实时|今天|最近)/iu.test(resultText(result))
}

export function assessRetrievalQuality(
  question: string,
  results: readonly WebSearchResult[],
  options: RetrievalQualityAssessmentOptions = {},
): RetrievalQualitySignals {
  const authorities = results.map((result) => classifyRetrievalAuthority(question, result))
  const uploaderClaim = isUploaderClaim(question)
  const authorityHighCount = authorities.filter((authority, index) =>
    authority === 'PRIMARY_OFFICIAL' || authority === 'AUTHORITATIVE_SECONDARY' || (uploaderClaim && authority === 'UGC' &&
      (hasQuestionOverlap(question, results[index]!) || /(?:主播|UP主|博主|账号|上传|发布|B站|哔哩哔哩|视频)/iu.test(`${results[index]!.title} ${results[index]!.snippet}`))),
  ).length
  const authorityLowCount = authorities.filter((authority, index) =>
    authority === 'AGGREGATION_LOW_SIGNAL' || (authority === 'UGC' && !(uploaderClaim &&
      (hasQuestionOverlap(question, results[index]!) || /(?:主播|UP主|博主|账号|上传|发布|B站|哔哩哔哩|视频)/iu.test(`${results[index]!.title} ${results[index]!.snippet}`)))),
  ).length
  const fetchedCount = results.filter((result) => result.pageFetchStatus === 'PASS' && (result.pageText?.length ?? 0) > 0).length
  const uniqueHostCount = new Set(results.map((result) => hostOf(result.url)).filter(Boolean)).size
  const mode = options.mode ?? 'GENERAL'
  const datedResultCount = options.datedResultCount ?? results.filter((result) => typeof result.publishedAt === 'string' && result.publishedAt.trim().length > 0).length
  const comparativeClaim = isComparativeClaim(question)
  const exactMappingClaim = isExactEntityMappingClaim(question)
  const originClaim = isOriginClaim(question)
  const currentClaim = isCurrentClaim(question, mode)
  const directEvidenceResults = results.filter((result) => hasDirectAnswerSignal(question, result))
  const primaryOfficialDirect = results.some((result, index) => isPrimaryOfficial(authorities[index]!) && hasDirectAnswerSignal(question, result))
  const primaryOfficialPageDirect = results.some((result, index) => isPrimaryOfficial(authorities[index]!) && hasDirectAnswerSignal(question, result) && hasPageEvidence(result))
  const authoritativeDirect = results.some((result, index) => authorities[index] === 'AUTHORITATIVE_SECONDARY' && hasDirectAnswerSignal(question, result))
  const authoritativePageDirect = results.some((result, index) => authorities[index] === 'AUTHORITATIVE_SECONDARY' && hasDirectAnswerSignal(question, result) && hasPageEvidence(result))
  const officialSnippetException = primaryOfficialDirect && !primaryOfficialPageDirect && !currentClaim && !comparativeClaim && !exactMappingClaim && !originClaim
  const freshnessEvidencePresent = datedResultCount > 0 || results.some((result, index) =>
    currentClaim && isPrimaryOfficial(authorities[index]!) && hasPageEvidence(result) && hasDirectAnswerSignal(question, result) && hasCurrentEvidence(result),
  )
  const extremeHighEvidence = results.some((result, index) => {
    const authority = authorities[index]!
    if (!isPrimaryOfficial(authority) || !hasPageEvidence(result) || !hasDirectAnswerSignal(question, result)) return false
    if (comparativeClaim) return hasExplicitComparativeEvidence(result)
    if (exactMappingClaim) return hasExplicitMappingEvidence(result)
    if (originClaim) return hasExplicitOriginEvidence(result)
    if (currentClaim) return freshnessEvidencePresent && hasCurrentEvidence(result)
    return false
  })
  const highEvidenceClaim = comparativeClaim || currentClaim || exactMappingClaim || originClaim
  const suitableSource = primaryOfficialPageDirect || authoritativePageDirect || officialSnippetException
  const sourceQualityPresent = primaryOfficialDirect || authoritativeDirect
  const directEvidencePresent = directEvidenceResults.length > 0
  let cheapBlocker: RetrievalQualityCheapBlocker = 'NONE'
  if (highEvidenceClaim && !extremeHighEvidence) {
    cheapBlocker = 'HIGH_EVIDENCE_CLAIM'
  } else if (currentClaim && !freshnessEvidencePresent) {
    cheapBlocker = 'NO_FRESHNESS_EVIDENCE'
  } else if (!directEvidencePresent) {
    cheapBlocker = 'NO_DIRECT_EVIDENCE'
  } else if (!sourceQualityPresent) {
    cheapBlocker = 'NO_PRIMARY_SOURCE'
  } else if (!suitableSource) {
    cheapBlocker = 'NO_PAGE_EVIDENCE'
  }
  const cheapEligible = results.length > 0 && cheapBlocker === 'NONE'
  const missingEvidencePresent = results.length === 0 || !cheapEligible || authorityLowCount > authorityHighCount
  return {
    resultCount: results.length,
    fetchedCount,
    uniqueHostCount,
    authorityHighCount,
    authorityLowCount,
    missingEvidencePresent,
    shouldRunGate: results.length > 0 && !cheapEligible,
    cheapEligible,
    cheapBlocker,
  }
}

export function buildRetrievalQualityGateUserPrompt(input: RetrievalQualityGateInput): string {
  const renderedResults = input.results.map((result, index) => {
    const page = result.pageEvidence === undefined ? '' : `\nPageEvidence: ${result.pageEvidence.slice(0, 1200)}`
    return `[R${index + 1}] hostname=${result.hostname}\nTitle: ${result.title}\nSnippet: ${result.snippet.slice(0, 1200)}\nPublishedAt: ${result.publishedAt ?? 'NONE'}\nPageFetchStatus: ${result.pageFetchStatus ?? 'SKIPPED'}${page}`
  }).join('\n')
  return `[Canonical Current Question]\n${input.question}\n\n` +
    `[Round]\n${input.round}\n\n` +
    `[Search Plan]\nmode=${input.mode}\nprimaryQuery=${input.primaryQuery}\nalternateQuery=${input.alternateQuery ?? ''}\n\n` +
    `[Selected Evidence Metadata]\n${renderedResults || '（无）'}`
}

export class RetrievalQualityGate {
  public constructor(private readonly completeStructured: StructuredCompletion) {}

  public async decide(
    input: RetrievalQualityGateInput,
    forbiddenValues: readonly string[] = [],
    deadline?: RequestDeadline,
    msgIdToken = 'NONE',
  ): Promise<RetrievalQualityGateResult> {
    try {
      deadline?.throwIfExpired()
      const raw = await this.completeStructured(
        RETRIEVAL_QUALITY_SYSTEM_PROMPT,
        buildRetrievalQualityGateUserPrompt(input),
        deadline,
        msgIdToken,
        'RETRIEVAL_QUALITY_GATE',
      )
      deadline?.throwIfExpired()
      const control = detectProviderControlMarkup(raw)
      if (control.providerControlMarkup) {
        return { result: 'FAIL', decision: STOP_DECISION, failureReason: 'PROVIDER_CONTROL_MARKUP' }
      }
      const parsed = parseRetrievalQualityProtocol(raw, input, forbiddenValues)
      return parsed.valid
        ? { result: 'PASS', decision: parsed.decision }
        : { result: 'FAIL', decision: STOP_DECISION, failureReason: parsed.failureReason }
    } catch (error) {
      if (isRequestDeadlineExceeded(error)) {
        return { result: 'FAIL', decision: STOP_DECISION, failureReason: 'COMPLETION_ERROR' }
      }
      if (error instanceof ProviderControlMarkupError) {
        return { result: 'FAIL', decision: STOP_DECISION, failureReason: 'PROVIDER_CONTROL_MARKUP' }
      }
      return { result: 'FAIL', decision: STOP_DECISION, failureReason: 'COMPLETION_ERROR' }
    }
  }
}
