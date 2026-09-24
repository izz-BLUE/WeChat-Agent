import { strict as assert } from 'node:assert'
import {
  assessRetrievalQuality,
  buildRetrievalQualityGateUserPrompt,
  classifyRetrievalAuthority,
  parseRetrievalQualityProtocol,
  RetrievalQualityGate,
  type RetrievalQualityGateInput,
} from './retrieval-quality.js'
import { inspectGroundedSources, normalizeWebSearchResults, rankWebSearchResults, type WebSearchResult } from './web-search.js'
import { ChatService } from './chat.js'
import { ProductionChatAgent } from './production-agent-receiver.js'
import type { AgentRequest } from './agent-adapter.js'
import type { WebSearchProvider } from './web-search.js'
import { RequestDeadline } from './request-deadline.js'

function result(sourceId: string, title: string, url: string, snippet: string, pageText?: string, pageFetchStatus?: WebSearchResult['pageFetchStatus'], retrievalRound?: 1 | 2): WebSearchResult {
  return { sourceId, title, url, snippet, pageText, pageFetchStatus, retrievalRound }
}

function retryProtocol(query: string, alternateQuery = ''): string {
  return [
    'DECISION=RETRY',
    'REASON=MISSING_COMPARATIVE_EVIDENCE',
    'MISSING_EVIDENCE=ranking and follower comparison data',
    `RETRY_QUERY=${query}`,
    `RETRY_ALT_QUERY=${alternateQuery}`,
    'SEARCH_MODE=GENERAL',
    'RECENCY_WINDOW=NONE',
  ].join('\n')
}

function request(text: string): AgentRequest {
  return {
    conversationKey: 'direct:retrieval-quality-test',
    messageId: 'retrieval-quality-message',
    conversationType: 'DIRECT',
    conversationId: 'retrieval-quality-conversation',
    senderId: 'retrieval-quality-sender',
    requesterId: 'retrieval-quality-sender',
    requesterSource: 'Signature',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    ownerDisplayName: null,
    publicDisplayName: null,
    privateDispatchTargetConversationId: null,
    senderName: '测试用户',
    text,
    rawText: text,
    timestamp: Date.now(),
    mentionState: 'NOT_MENTIONED',
    botMentionSpans: { trust: 'VALID', spans: [] },
    userContentSpan: { trust: 'VALID', span: { start: 0, length: text.length } },
    metadata: { rawMessageType: 1 },
  }
}

async function main(): Promise<void> {
  const high = result(
    'S1',
    'DeepSeek API Base 官方文档',
    'https://api.deepseek.com/docs',
    '官方文档明确给出 API Base。',
    'API Base: https://api.deepseek.com',
    'PASS',
    1,
  )
  const highSignals = assessRetrievalQuality('DeepSeek 官方 API Base 是什么', [high])
  assert.equal(highSignals.shouldRunGate, false)
  console.log('RETRIEVAL_QUALITY_HIGH_NO_RETRY=PASS')
  console.log('CHEAP_SUFFICIENT_DIRECT_OFFICIAL_FACT=PASS')

  const originalProductionFetch = globalThis.fetch
  let productionGateCalls = 0
  let productionFinalCalls = 0
  globalThis.fetch = (async () => {
    productionFinalCalls += 1
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'API Base 是 https://api.deepseek.com[S1]' } }] }) } as Response
  }) as typeof fetch
  try {
    const productionAgent = new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'key', 'test-model'), {
      webSearchPlanner: {
        plan: async () => ({
          result: 'PASS' as const,
          decision: {
            action: 'SEARCH' as const,
            query: 'DeepSeek API Base',
            alternateQuery: null,
            reasonCode: 'EXTERNAL_VERIFICATION' as const,
            mode: 'GENERAL' as const,
            recencyWindow: 'NONE' as const,
          },
        }),
      },
      webSearchProvider: { search: async () => ({ results: [high] }) },
      retrievalQualityGate: { decide: async () => { productionGateCalls += 1; throw new Error('cheap path called the gate') } },
      requestDeadlineMs: 20_000,
    })
    const answer = await productionAgent.complete(request('DeepSeek 官方 API Base 是什么'))
    // /docs is the trusted result URL. A different path on the same host is
    // not an exact result URL and must not survive final grounding.
    assert.doesNotMatch(answer, /api\.deepseek\.com/u)
    assert.equal(productionGateCalls, 0)
    assert.equal(productionFinalCalls, 1)
  } finally {
    globalThis.fetch = originalProductionFetch
  }
  console.log('CHEAP_SUFFICIENT_PRODUCTION_SKIPS_GATE=PASS')

  const currentOfficialSignals = assessRetrievalQuality(
    'Node.js 25 当前官方版本号是多少',
    [result('N1', 'Node.js 当前版本', 'https://nodejs.org/docs/latest/api', '当前版本号：25.0.0', '当前版本号：25.0.0', 'PASS', 1)],
    { mode: 'GENERAL', window: 'GENERAL', datedResultCount: 0 },
  )
  assert.equal(currentOfficialSignals.cheapEligible, true)
  assert.equal(currentOfficialSignals.shouldRunGate, false)
  console.log('CHEAP_SUFFICIENT_CURRENT_OFFICIAL_FACT=PASS')

  const defaultOfficialSignals = assessRetrievalQuality(
    '某官方文档中的参数默认值是什么',
    [result('D2', '官方参数文档', 'https://example.com/docs/parameters', '默认值：42', '参数默认值：42', 'PASS', 1)],
  )
  assert.equal(defaultOfficialSignals.cheapEligible, true)
  assert.equal(defaultOfficialSignals.shouldRunGate, false)
  console.log('CHEAP_SUFFICIENT_OFFICIAL_DEFAULT_FACT=PASS')

  const rankingResults = [
    result('R1', '游戏直播相关报道', 'https://wikipedia.org/wiki/Streamer_topic', '介绍游戏直播内容。', undefined, 'SKIPPED', 1),
    result('R2', '游戏直播相关报道', 'https://www.reuters.com/world/streamer-topic', '介绍游戏直播内容。', undefined, 'SKIPPED', 1),
    result('R3', '游戏直播相关报道', 'https://www.36kr.com/p/streamer-topic', '介绍游戏直播内容。', undefined, 'SKIPPED', 1),
    result('R4', '游戏直播相关报道', 'https://www.caixin.com/streamer-topic', '介绍游戏直播内容。', undefined, 'SKIPPED', 1),
    result('R5', '直播内容汇总', 'https://content-farm.example/search/streamer', '直播内容汇总。', undefined, 'SKIPPED', 1),
    result('R6', '直播内容汇总', 'https://example.net/streamer-a', '直播内容汇总。', undefined, 'SKIPPED', 1),
    result('R7', '直播内容汇总', 'https://example.net/streamer-b', '直播内容汇总。', undefined, 'SKIPPED', 1),
    result('R8', '直播内容汇总', 'https://portal.example.org/streamer', '直播内容汇总。', undefined, 'SKIPPED', 1),
  ]
  const rankingSignals = assessRetrievalQuality('燕云十六声目前最大的主播是谁', rankingResults, {
    mode: 'NEWS_RECENT',
    window: 'DAY_3',
    datedResultCount: 0,
  })
  assert.equal(rankingSignals.authorityHighCount, 4)
  assert.equal(rankingSignals.uniqueHostCount, 7)
  assert.equal(rankingSignals.cheapEligible, false)
  assert.equal(rankingSignals.cheapBlocker, 'HIGH_EVIDENCE_CLAIM')
  assert.equal(rankingSignals.shouldRunGate, true)
  console.log('CHEAP_SUFFICIENT_RANKING_BLOCKED=PASS')
  console.log('CHEAP_SUFFICIENT_AUTHORITY_COUNT_NOT_SUFFICIENT=PASS')

  const currentUndatedSignals = assessRetrievalQuality(
    '某产品目前最新版本是什么',
    [result('C1', '产品版本信息汇总', 'https://product.example.com/release', '版本信息汇总。', undefined, 'SKIPPED', 1)],
    { mode: 'NEWS_RECENT', window: 'DAY_3', datedResultCount: 0 },
  )
  assert.equal(currentUndatedSignals.cheapEligible, false)
  assert.equal(currentUndatedSignals.shouldRunGate, true)
  console.log('CHEAP_SUFFICIENT_CURRENT_UNDATED_BLOCKED=PASS')

  const noPageSignals = assessRetrievalQuality(
    '某产品的默认参数是什么',
    [result('P1', '产品参数说明', 'https://www.reuters.com/product-defaults', '默认值是 42。', undefined, 'FAILED', 1)],
  )
  assert.equal(noPageSignals.cheapEligible, false)
  assert.equal(noPageSignals.cheapBlocker, 'NO_PAGE_EVIDENCE')
  assert.equal(noPageSignals.shouldRunGate, true)
  console.log('CHEAP_SUFFICIENT_NO_PAGE_EVIDENCE_BLOCKED=PASS')

  const mappingSignals = assessRetrievalQuality(
    '容鸢是谁配音的？',
    [result('M1', '容鸢角色介绍与配音表', 'https://example.com/role', '包含角色介绍和配音表。', undefined, 'SKIPPED', 1)],
  )
  assert.equal(mappingSignals.cheapEligible, false)
  assert.equal(mappingSignals.cheapBlocker, 'HIGH_EVIDENCE_CLAIM')
  assert.equal(mappingSignals.shouldRunGate, true)
  console.log('CHEAP_SUFFICIENT_EXACT_MAPPING_BLOCKED=PASS')

  const originSignals = assessRetrievalQuality(
    '容鸢为什么叫这个名字？',
    [result('O1', '木鸢角色背景', 'https://example.com/background', '介绍角色背景和剧情。', undefined, 'SKIPPED', 1)],
  )
  assert.equal(originSignals.cheapEligible, false)
  assert.equal(originSignals.cheapBlocker, 'HIGH_EVIDENCE_CLAIM')
  assert.equal(originSignals.shouldRunGate, true)
  console.log('CHEAP_SUFFICIENT_ORIGIN_CLAIM_BLOCKED=PASS')

  const officialSnippetSignals = assessRetrievalQuality(
    'DeepSeek API Base 是什么',
    [result('D1', 'DeepSeek API Base 官方文档', 'https://api.deepseek.com/docs', 'API Base: https://api.deepseek.com', undefined, 'FAILED', 1)],
  )
  assert.equal(officialSnippetSignals.cheapEligible, true)
  assert.equal(officialSnippetSignals.cheapBlocker, 'NONE')
  assert.equal(officialSnippetSignals.shouldRunGate, false)
  console.log('CHEAP_SUFFICIENT_OFFICIAL_SNIPPET_EXCEPTION=PASS')

  const weak = [
    result('S1', '主播相关视频合集', 'https://video.example/search', '多个主播相关视频。', undefined, 'SKIPPED', 1),
    result('S2', '热门内容推荐', 'https://feed.example/recommend', '热门内容列表。', undefined, 'SKIPPED', 1),
  ]
  const weakSignals = assessRetrievalQuality('谁是最大主播', weak)
  assert.equal(weakSignals.shouldRunGate, true)
  console.log('RETRIEVAL_WEAK_EVIDENCE_RETRY=PASS')

  const originalFetch = globalThis.fetch
  try {
    const providerQueries: string[] = []
    const provider: WebSearchProvider = {
      search: async ({ query }) => {
        providerQueries.push(query)
        return { results: [query.includes('粉丝')
          ? result('S1', '主播粉丝排名与关注人数', 'https://rank.example/2', '排名和关注人数对比', undefined, 'SKIPPED', 2)
          : result('S1', '主播相关视频', 'https://www.bilibili.com/video/1', '主播相关视频合集', undefined, 'SKIPPED', 1)] }
      },
    }
    let finalCalls = 0
    globalThis.fetch = (async () => {
      finalCalls += 1
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '结论[S1]' } }] }) } as Response
    }) as typeof fetch
    const gate = {
      decide: async () => ({
        result: 'PASS' as const,
        decision: {
          decision: 'RETRY' as const,
          reason: 'MISSING_COMPARATIVE_EVIDENCE',
          missingEvidence: 'ranking and follower data',
          retryQuery: '主播 粉丝排名 关注人数 对比',
          retryAlternateQuery: null,
          mode: 'GENERAL' as const,
          window: 'GENERAL' as const,
        },
      }),
    }
    const agent = new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'key', 'test-model'), {
      webSearchPlanner: {
        plan: async () => ({
          result: 'PASS' as const,
          decision: {
            action: 'SEARCH' as const,
            query: '谁是最大主播',
            alternateQuery: null,
            reasonCode: 'EXTERNAL_VERIFICATION' as const,
            mode: 'GENERAL' as const,
            recencyWindow: 'NONE' as const,
          },
        }),
      },
      webSearchProvider: provider,
      retrievalQualityGate: gate,
      requestDeadlineMs: 20_000,
    })
    const answer = await agent.complete(request('谁是最大主播'))
    assert.equal(providerQueries.length, 2)
    assert.match(providerQueries[1] ?? '', /粉丝|排名/u)
    assert.equal(finalCalls, 1)
    assert.ok(!answer.includes('https://rank.example/2'), 'trusted result URL was appended to the final answer')
    assert.ok(!/\[S\d+\]/u.test(answer), 'internal source marker reached the final answer')
  } finally {
    globalThis.fetch = originalFetch
  }
  console.log('RETRIEVAL_PRODUCTION_SHARED_RETRY=PASS')

  const parsed = parseRetrievalQualityProtocol(retryProtocol('主播 粉丝排名 关注人数 对比'), { primaryQuery: '谁是最大主播' })
  assert.equal(parsed.valid, true)
  if (parsed.valid) {
    assert.match(parsed.decision.retryQuery ?? '', /排名|粉丝|关注/u)
    assert.notEqual(parsed.decision.retryQuery, '谁是最大主播')
  }
  console.log('RETRIEVAL_TARGETED_QUERY=PASS')

  const merged = normalizeWebSearchResults([
    result('S1', 'Round1 evidence', 'https://one.example/a', '第一轮', undefined, 'SKIPPED', 1),
    result('S1', 'Round2 evidence', 'https://two.example/b', '第二轮', undefined, 'SKIPPED', 2),
    result('S2', 'Duplicate URL', 'https://two.example/b?utm_source=x', '重复', undefined, 'SKIPPED', 2),
  ], { preserveInternalEvidence: true })
  const mergedRanked = rankWebSearchResults(merged, {
    query: 'evidence',
    additionalQueries: ['第二轮'],
    mode: 'GENERAL',
  })
  assert.deepEqual(mergedRanked.results.map((item) => item.sourceId), ['S1', 'S2'])
  assert.equal(new Set(mergedRanked.results.map((item) => item.sourceId)).size, mergedRanked.results.length)
  assert.ok(mergedRanked.results.every((item) => item.retrievalRound === 1 || item.retrievalRound === 2))
  console.log('RETRIEVAL_MAX_TWO_ROUNDS=PASS')
  console.log('RETRIEVAL_SOURCE_ID_UNIQUE=PASS')

  const failSoftFetch = globalThis.fetch
  try {
    let providerCalls = 0
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Round1 证据[S1]' } }] }),
    })) as unknown as typeof fetch
    const failSoftAgent = new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'key', 'test-model'), {
      webSearchPlanner: {
        plan: async () => ({
          result: 'PASS' as const,
          decision: {
            action: 'SEARCH' as const,
            query: '谁是最大主播',
            alternateQuery: null,
            reasonCode: 'EXTERNAL_VERIFICATION' as const,
            mode: 'GENERAL' as const,
            recencyWindow: 'NONE' as const,
          },
        }),
      },
      webSearchProvider: {
        search: async ({ query }) => {
          providerCalls += 1
          if (query.includes('粉丝')) throw new Error('round2 provider timeout')
          return { results: [result('S1', '主播相关视频', 'https://www.bilibili.com/video/fail-soft', '主播相关视频合集', undefined, 'SKIPPED', 1)] }
        },
      },
      retrievalQualityGate: {
        decide: async () => ({
          result: 'PASS' as const,
          decision: {
            decision: 'RETRY' as const,
            reason: 'MISSING_COMPARATIVE_EVIDENCE',
            missingEvidence: 'ranking data',
            retryQuery: '主播 粉丝排名',
            retryAlternateQuery: null,
            mode: 'GENERAL' as const,
            window: 'GENERAL' as const,
          },
        }),
      },
      requestDeadlineMs: 20_000,
    })
    const answer = await failSoftAgent.complete(request('谁是最大主播'))
    assert.equal(providerCalls, 2)
    assert.ok(!answer.includes('https://www.bilibili.com/video/fail-soft'), 'trusted result URL was appended after a failed retry')
    assert.ok(!/\[S\d+\]/u.test(answer), 'internal source marker reached the final answer after a failed retry')
  } finally {
    globalThis.fetch = failSoftFetch
  }
  console.log('RETRIEVAL_ROUND2_FAIL_SOFT=PASS')

  const failingGate = new RetrievalQualityGate(async () => {
    throw new Error('quality gate failure')
  })
  const failed = await failingGate.decide({
    question: '问题',
    round: 1,
    mode: 'GENERAL',
    primaryQuery: '问题',
    alternateQuery: null,
    results: [],
  }, [], new RequestDeadline(5_000), 'msg-token')
  assert.equal(failed.result, 'FAIL')
  console.log('RETRIEVAL_GATE_FAIL_SOFT=PASS')

  const expired = await failingGate.decide({
    question: '问题',
    round: 1,
    mode: 'GENERAL',
    primaryQuery: '问题',
    alternateQuery: null,
    results: [],
  }, [], new RequestDeadline(1, () => Date.now(), Date.now() - 10), 'msg-token')
  assert.equal(expired.result, 'FAIL')
  console.log('RETRIEVAL_DEADLINE_GUARD=PASS')

  const uploader = result('S1', '某主播本人上传的视频', 'https://www.bilibili.com/video/BV1', '某主播本人账号发布的视频')
  assert.equal(classifyRetrievalAuthority('某主播最近上传的 B站视频是什么', uploader), 'UGC')
  assert.equal(assessRetrievalQuality('某主播最近上传的 B站视频是什么', [uploader]).authorityHighCount, 1)
  console.log('RETRIEVAL_UGC_NOT_BLINDLY_BLOCKED=PASS')

  const grounded = inspectGroundedSources('结论[S1]', [result('S1', '证据', 'https://source.example/1', '摘要')])
  assert.equal(grounded.result, 'PASS')
  console.log('RETRIEVAL_GROUNDING_REUSED=PASS')

  const input: RetrievalQualityGateInput = {
    question: '问题',
    round: 1,
    mode: 'GENERAL',
    primaryQuery: '问题',
    alternateQuery: null,
    results: [{ title: '标题', hostname: 'example.com', snippet: '摘要', pageFetchStatus: 'SKIPPED' }],
  }
  const prompt = buildRetrievalQualityGateUserPrompt(input)
  assert.ok(!prompt.includes('conversationId') && !prompt.includes('memoryId'))
  assert.equal(parseRetrievalQualityProtocol(retryProtocol('问题 MEMORYID=secret'), { primaryQuery: '原问题' }).valid, false)
  console.log('RETRIEVAL_ADAPTIVE_SEARCH_SHARED_PATH=PASS')
  console.log('RETRIEVAL_NO_RAW_PRIVATE_LOG=PASS')
}

await main()
