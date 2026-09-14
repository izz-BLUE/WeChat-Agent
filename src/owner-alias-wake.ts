/**
 * Deterministic conversational wake for a small, closed Owner-alias set.
 *
 * This module only answers "does this canonical group sentence contain one of
 * the configured phrases?" It never resolves identity, authority or intent.
 */

export const OWNER_ALIAS_WAKE_TERMS = ['辞老师', '辞山时', '辞老'] as const

export type OwnerAliasClass = 'ALIAS_1' | 'ALIAS_2' | 'ALIAS_3'

export interface OwnerAliasWakeMatch {
  matchedAliasClass: OwnerAliasClass
  /** UTF-16 offset in the canonical text; never logged by the runtime. */
  index: number
}

const ALIASES_BY_LONGEST = OWNER_ALIAS_WAKE_TERMS
  .map((term, index) => ({
    term,
    aliasClass: `ALIAS_${index + 1}` as OwnerAliasClass,
  }))
  .sort((left, right) => right.term.length - left.term.length ||
    OWNER_ALIAS_WAKE_TERMS.indexOf(left.term) - OWNER_ALIAS_WAKE_TERMS.indexOf(right.term))

/**
 * Finds the earliest phrase occurrence, preferring the longest phrase at the
 * same offset. Matching deliberately stays substring-based: no tokenizer,
 * fuzzy matching or natural-language classification is involved.
 */
export function detectOwnerAliasWake(canonicalText: string): OwnerAliasWakeMatch | null {
  let best: OwnerAliasWakeMatch | null = null
  for (const alias of ALIASES_BY_LONGEST) {
    const index = canonicalText.indexOf(alias.term)
    if (index < 0) continue
    if (best === null || index < best.index) {
      best = { matchedAliasClass: alias.aliasClass, index }
    }
  }
  return best
}

export const DEFAULT_OWNER_ALIAS_WAKE_COOLDOWN_MS = 30_000
const MAX_SEEN_ALIAS_MESSAGE_IDS_PER_GROUP = 2_048

export type OwnerAliasWakeGateResult =
  | { allowed: true; reason: 'OWNER_ALIAS' }
  | { allowed: false; reason: 'COOLDOWN' | 'DUPLICATE' }

interface GroupWakeState {
  lastWakeAt?: number
  seenMessageIds: Set<string>
  seenOrder: string[]
}

/** Process-local per-group admission gate for already-detected alias wakes. */
export class OwnerAliasWakeGate {
  private readonly groups = new Map<string, GroupWakeState>()

  public constructor(
    private readonly cooldownMs = DEFAULT_OWNER_ALIAS_WAKE_COOLDOWN_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isInteger(cooldownMs) || cooldownMs < 0) {
      throw new Error('cooldownMs must be a non-negative integer')
    }
  }

  public admit(groupConversationId: string, messageId: string): OwnerAliasWakeGateResult {
    const state = this.groups.get(groupConversationId) ?? {
      seenMessageIds: new Set<string>(),
      seenOrder: [],
    }

    if (state.seenMessageIds.has(messageId)) {
      return { allowed: false, reason: 'DUPLICATE' }
    }
    state.seenMessageIds.add(messageId)
    state.seenOrder.push(messageId)
    while (state.seenOrder.length > MAX_SEEN_ALIAS_MESSAGE_IDS_PER_GROUP) {
      const expiredMessageId = state.seenOrder.shift()
      if (expiredMessageId !== undefined) state.seenMessageIds.delete(expiredMessageId)
    }
    this.groups.set(groupConversationId, state)

    const now = this.now()
    if (state.lastWakeAt !== undefined && now >= state.lastWakeAt && now - state.lastWakeAt < this.cooldownMs) {
      return { allowed: false, reason: 'COOLDOWN' }
    }
    state.lastWakeAt = now
    return { allowed: true, reason: 'OWNER_ALIAS' }
  }
}
