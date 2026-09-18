/**
 * MEMORY EVIDENCE FOUNDATION P1 — cross-batch evidence accumulator.
 *
 * Phase 1 could only count REPEATED_BEHAVIOR evidence inside one extractor
 * batch, so a preference a user restates across separate requests never reached
 * the two-item threshold and was lost with every flush. This module is the
 * short-term evidence pool between the extractor and the admission gate:
 *
 *   MemoryCandidate → EvidenceAccumulator (this file, in memory only)
 *                   → Evidence Admission Gate → MemoryRecord
 *
 * Hard contracts:
 *  - NEVER persisted. The pool lives in a Map inside the running process, has
 *    no save/load path, and disappears on restart. Losing unadmitted evidence
 *    across a restart is accepted design. memory.json and MemoryRecord stay
 *    untouched.
 *  - NO raw text. Entries hold a deterministic candidate key, counts, the
 *    latest batch-local reference labels and timestamps — never the memory
 *    content and never a raw identity outside the internal scope key.
 *  - REPEATED_BEHAVIOR only. Any other evidence class is rejected; inference
 *    stays non-durable (phase-1 rule).
 *  - Runtime-owned counts. The accumulated count is the sum of per-batch
 *    DISTINCT references counted HERE, never a provider-supplied number. An
 *    entry's `evidenceRefs` carries the latest contribution's batch-local
 *    labels — they have no cross-batch meaning and are never persisted.
 *  - Sliding TTL with an opportunistic sweep. Every contribution refreshes
 *    `lastSeenAt` and sweeps all entries idle beyond the TTL, so the pool
 *    stays bounded; the current key's own staleness is decided BEFORE the
 *    sweep so the EXPIRED outcome survives it.
 */
import { MemoryText } from './memory-models.js'
import type { MemoryEvidenceType } from './memory-evidence.js'

/** Entries idle longer than this are purged (sliding TTL, refreshed per contribution). */
export const REPEATED_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Deterministic candidate-key normalization for phase 1: whitespace collapse,
 * lowercase, punctuation strip, then a CLOSED set of pronoun/degree/particle
 * fillers (longest first) so "我喜欢猫" and "我挺喜欢猫的" share one key.
 * Negations (不/没/别) are fillers-never and stay, so "我不喜欢猫" never
 * merges with "我喜欢猫". If the filler pass strips everything, the
 * punctuation-stripped form is kept so a key component can never be empty.
 * This is deliberately lexical, not semantic — a paraphrase outside the closed
 * filler set simply counts as separate evidence.
 */
const KEY_FILLER_TOKENS: readonly string[] = [
  '我们', '咱们', '你们', '他们', '她们', '它们',
  '非常', '特别', '比较', '相当', '真的', '确实', '好像', '似乎', '感觉', '觉得', '平时', '一直', '一般',
  '我', '你', '他', '她', '它', '挺', '很', '蛮', '超', '太',
  '的', '了', '呢', '吧', '啊', '呀', '哦', '嘛', '啦', '哟',
]

export function normalizeEvidenceKeyContent(content: string): string {
  const stripped = MemoryText.normalize(content).toLowerCase().replace(/[\p{P}\p{S}\p{C}]/gu, '')
  let normalized = stripped
  for (const token of KEY_FILLER_TOKENS) {
    normalized = normalized.replaceAll(token, '')
  }
  return normalized.length === 0 ? stripped : normalized
}

export interface EvidenceAccumulatorEntry {
  candidateKey: string
  evidenceType: MemoryEvidenceType
  evidenceCount: number
  evidenceRefs: string[]
  firstSeenAt: number
  lastSeenAt: number
  scopeId: string
}

export interface EvidenceAccumulatorContribution {
  candidateKey: string
  evidenceType: MemoryEvidenceType
  evidenceRefs: readonly string[]
  scopeId: string
}

export type AddEvidenceResult =
  | { outcome: 'ACCEPTED'; expiredPrior: boolean; entry: EvidenceAccumulatorEntry }
  | { outcome: 'REJECTED'; reason: 'EVIDENCE_TYPE_NOT_ALLOWED' | 'EVIDENCE_REFS_INVALID' }

const EVIDENCE_REF_PATTERN = /^M[1-9][0-9]*$/u

export interface MemoryEvidenceAccumulatorOptions {
  now?: () => number
  ttlMs?: number
}

export class MemoryEvidenceAccumulator {
  private readonly entries = new Map<string, EvidenceAccumulatorEntry>()
  private readonly now: () => number
  private readonly ttlMs: number

  public constructor(options: MemoryEvidenceAccumulatorOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? REPEATED_EVIDENCE_TTL_MS
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Evidence accumulator TTL must be a positive number')
    }
  }

  public get size(): number {
    return this.entries.size
  }

  /**
   * Adds one batch's validated, distinct references to the pool and returns the
   * accumulated entry. The contribution refs must already have passed the
   * admission gate; the format/distinct re-check here is defense-in-depth, so
   * a contract failure is a REJECTED result — never a silently inflated count.
   */
  public addEvidence(contribution: EvidenceAccumulatorContribution): AddEvidenceResult {
    if (contribution.evidenceType !== 'REPEATED_BEHAVIOR') {
      return { outcome: 'REJECTED', reason: 'EVIDENCE_TYPE_NOT_ALLOWED' }
    }
    const refs = contribution.evidenceRefs
    if (!Array.isArray(refs) || refs.length === 0) {
      return { outcome: 'REJECTED', reason: 'EVIDENCE_REFS_INVALID' }
    }
    const distinct: string[] = []
    for (const ref of refs) {
      if (typeof ref !== 'string' || !EVIDENCE_REF_PATTERN.test(ref) || distinct.includes(ref)) {
        return { outcome: 'REJECTED', reason: 'EVIDENCE_REFS_INVALID' }
      }
      distinct.push(ref)
    }

    const now = this.now()
    const prior = this.entries.get(contribution.candidateKey)
    const expiredPrior = prior !== undefined && now - prior.lastSeenAt > this.ttlMs
    // Opportunistic sweep keeps the pool bounded. The current key's staleness
    // was decided above, so an expired prior still reports EXPIRED even though
    // this sweep removes it.
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenAt > this.ttlMs) {
        this.entries.delete(key)
      }
    }
    const previous = expiredPrior ? undefined : prior
    const entry: EvidenceAccumulatorEntry = previous
      ? {
        ...previous,
        evidenceCount: previous.evidenceCount + distinct.length,
        evidenceRefs: [...distinct],
        lastSeenAt: now,
      }
      : {
        candidateKey: contribution.candidateKey,
        evidenceType: 'REPEATED_BEHAVIOR',
        evidenceCount: distinct.length,
        evidenceRefs: [...distinct],
        firstSeenAt: now,
        lastSeenAt: now,
        scopeId: contribution.scopeId,
      }
    this.entries.set(contribution.candidateKey, entry)
    return { outcome: 'ACCEPTED', expiredPrior, entry }
  }

  /** Read-only view of one candidate's accumulated entry (undefined when absent). */
  public getAccumulatedEvidence(
    candidate: Pick<EvidenceAccumulatorContribution, 'candidateKey'>,
  ): EvidenceAccumulatorEntry | undefined {
    return this.entries.get(candidate.candidateKey)
  }

  /** Purges every entry idle beyond the TTL; returns the number purged. */
  public clearExpired(): number {
    const now = this.now()
    let purged = 0
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenAt > this.ttlMs) {
        this.entries.delete(key)
        purged += 1
      }
    }
    return purged
  }

  /** Drops the whole pool (in-memory only — there is nothing to persist). */
  public reset(): void {
    this.entries.clear()
  }
}
