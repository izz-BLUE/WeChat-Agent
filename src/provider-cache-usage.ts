export type ProviderPhase =
  | 'FINAL_ANSWER'
  | 'WEB_SEARCH_PLANNER'
  | 'MEMORY_EXTRACTOR'
  | 'MEMORY_MUTATION'
  | 'TOPIC_CAPSULE'
  | 'OWNER_DISPATCH_PLANNER'
  | 'OWNER_PRIVATE_DISPATCH_PLANNER'
  | 'PROVIDER_CONTROL_REPAIR'
  | 'ANSWER_GUARD_REGENERATION'
  | 'GROUNDING_REPAIR'
  | 'STRUCTURED_PROVIDER'

export type ProviderCacheUsageValue = number | 'UNKNOWN'

export interface ProviderCacheUsageDiagnostics {
  promptTokens: ProviderCacheUsageValue
  cachedTokens: ProviderCacheUsageValue
  cacheMissTokens: ProviderCacheUsageValue
  cacheHitRate: ProviderCacheUsageValue
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null ? value as UnknownRecord : undefined
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/**
 * Normalize provider-specific prompt-cache usage without treating an absent
 * field as a zero. The parser is deliberately independent of prompt content.
 */
export function parseProviderCacheUsage(response: unknown): ProviderCacheUsageDiagnostics {
  const usage = asRecord(asRecord(response)?.usage)
  if (usage === undefined) {
    return {
      promptTokens: 'UNKNOWN',
      cachedTokens: 'UNKNOWN',
      cacheMissTokens: 'UNKNOWN',
      cacheHitRate: 'UNKNOWN',
    }
  }

  const promptTokens = tokenCount(usage.prompt_tokens)
  const details = asRecord(usage.prompt_tokens_details)
  const cachedTokens = details !== undefined && hasOwn(details, 'cached_tokens')
    ? tokenCount(details.cached_tokens)
    : hasOwn(usage, 'prompt_cache_hit_tokens')
      ? tokenCount(usage.prompt_cache_hit_tokens)
      : undefined
  const explicitCacheMissTokens = hasOwn(usage, 'prompt_cache_miss_tokens')
    ? tokenCount(usage.prompt_cache_miss_tokens)
    : undefined

  const derivedCacheMissTokens = explicitCacheMissTokens === undefined &&
      promptTokens !== undefined && cachedTokens !== undefined && cachedTokens <= promptTokens
    ? promptTokens - cachedTokens
    : undefined
  const derivedCachedTokens = cachedTokens === undefined &&
      promptTokens !== undefined && explicitCacheMissTokens !== undefined && explicitCacheMissTokens <= promptTokens
    ? promptTokens - explicitCacheMissTokens
    : undefined
  const resolvedCachedTokens = cachedTokens ?? derivedCachedTokens
  const resolvedCacheMissTokens = explicitCacheMissTokens ?? derivedCacheMissTokens
  const cacheHitRate = promptTokens !== undefined && promptTokens > 0 &&
      resolvedCachedTokens !== undefined && resolvedCachedTokens <= promptTokens
    ? resolvedCachedTokens / promptTokens
    : 'UNKNOWN'

  return {
    promptTokens: promptTokens ?? 'UNKNOWN',
    cachedTokens: resolvedCachedTokens ?? 'UNKNOWN',
    cacheMissTokens: resolvedCacheMissTokens ?? 'UNKNOWN',
    cacheHitRate,
  }
}
