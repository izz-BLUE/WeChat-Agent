/**
 * MEMORY EVIDENCE / CONFIDENCE FOUNDATION — phase 1.
 *
 * Before this module an automatic candidate that passed the kind/scope/content
 * policy went straight to `MemoryStore.add`, so one line of chat ("别整这么多
 * 理论") could become a durable SOFT_STYLE_PREFERENCE with no trace of whether
 * the user said it, how often, or why it was worth keeping.
 *
 * The model never scores confidence. It only declares WHICH class of evidence
 * supports a candidate (`MemoryEvidenceType`) and WHICH buffered messages back
 * it (`M<number>` refs). Everything durable is decided here, deterministically:
 *
 *  - `deriveMemoryEvidenceConfidence` — the closed confidence table;
 *  - `admitAutomaticEvidence` — the phase-1 automatic durable write gate:
 *    strict `M<number>` reference validation against the current batch, then
 *    one admission rule per evidence class;
 *  - `upgradedExplicitEvidence` — the authoritative metadata for the explicit
 *    owner command and the self-address fast path;
 *  - `memoryConfidenceBand` — the only confidence form allowed in diagnostics.
 *
 * Cross-batch accumulation of REPEATED_BEHAVIOR evidence lives in
 * `memory-evidence-accumulator.ts` (P1): this gate still counts one batch, and
 * the service routes a REPEATED_BEHAVIOR candidate through the in-memory pool
 * whose runtime-maintained count — never a provider claim — decides admission.
 *
 * Deliberately NOT here (later phases): memory merge, conflict resolution,
 * TTL/decay of durable records, confidence-based retrieval ranking. Retrieval
 * and the member interaction profile keep reading memory by kind and content
 * only; evidence metadata is write/audit metadata.
 */

/** Closed evidence classes. The first two are Runtime-assigned only. */
export type MemoryEvidenceType =
  | 'EXPLICIT_OWNER_COMMAND'
  | 'EXPLICIT_SELF_ADDRESS'
  | 'EXPLICIT_SELF_STATEMENT'
  | 'EXPLICIT_PREFERENCE'
  | 'REPEATED_BEHAVIOR'
  | 'INFERRED_PATTERN'
  | 'LEGACY_UNKNOWN'

export const MEMORY_EVIDENCE_TYPES: readonly MemoryEvidenceType[] = [
  'EXPLICIT_OWNER_COMMAND',
  'EXPLICIT_SELF_ADDRESS',
  'EXPLICIT_SELF_STATEMENT',
  'EXPLICIT_PREFERENCE',
  'REPEATED_BEHAVIOR',
  'INFERRED_PATTERN',
  'LEGACY_UNKNOWN',
]

/**
 * The only evidence classes an automatic extractor may declare. Owner commands
 * and self-address preferences come from runtime paths, and LEGACY_UNKNOWN is
 * the runtime view of a pre-evidence record — a provider claiming any of the
 * three is rejected, never trusted.
 */
export const AUTOMATIC_MEMORY_EVIDENCE_TYPES: readonly MemoryEvidenceType[] = [
  'EXPLICIT_SELF_STATEMENT',
  'EXPLICIT_PREFERENCE',
  'REPEATED_BEHAVIOR',
  'INFERRED_PATTERN',
]

/** Evidence metadata carried by a durable record after this phase. */
export interface MemoryEvidenceMetadata {
  evidenceType: MemoryEvidenceType
  /** 0 <= confidence <= 1. Always derived here, never from a provider. */
  confidence: number
  /** Distinct evidence items behind the record; positive integer. */
  evidenceCount: number
  /** Finite epoch milliseconds, firstEvidenceAt <= lastEvidenceAt. */
  firstEvidenceAt: number
  lastEvidenceAt: number
}

/** Structural view of a previous record's evidence used for upgrades. */
export interface PriorEvidenceView {
  evidenceCount?: number
  firstEvidenceAt?: number
}

/**
 * The confidence table. Explicit user statements rank clearly above inferred
 * patterns; LEGACY_UNKNOWN forces no value — a legacy record keeps no
 * confidence on disk and reads as the LEGACY band.
 */
export function deriveMemoryEvidenceConfidence(evidenceType: MemoryEvidenceType): number | null {
  switch (evidenceType) {
    case 'EXPLICIT_OWNER_COMMAND':
      return 1
    case 'EXPLICIT_SELF_ADDRESS':
      return 1
    case 'EXPLICIT_SELF_STATEMENT':
      return 0.95
    case 'EXPLICIT_PREFERENCE':
      return 0.95
    case 'REPEATED_BEHAVIOR':
      return 0.75
    case 'INFERRED_PATTERN':
      return 0.4
    case 'LEGACY_UNKNOWN':
      return null
  }
}

export type MemoryConfidenceBand = 'HIGH' | 'MEDIUM' | 'LOW' | 'LEGACY'

/**
 * The band form of a confidence value — the only form diagnostics may print.
 * HIGH >= 0.9, MEDIUM >= 0.6, LOW < 0.6, and any record without a derived
 * confidence (legacy or skipped) reads as LEGACY.
 */
export function memoryConfidenceBand(confidence: number | undefined | null): MemoryConfidenceBand {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
    return 'LEGACY'
  }
  if (confidence >= 0.9) {
    return 'HIGH'
  }
  if (confidence >= 0.6) {
    return 'MEDIUM'
  }
  return 'LOW'
}

export function isMemoryEvidenceType(value: unknown): value is MemoryEvidenceType {
  return typeof value === 'string' && MEMORY_EVIDENCE_TYPES.includes(value as MemoryEvidenceType)
}

/** Runtime view of a record's evidence class: absent metadata is legacy. */
export function evidenceTypeOf(record: { evidenceType?: MemoryEvidenceType }): MemoryEvidenceType {
  return record.evidenceType ?? 'LEGACY_UNKNOWN'
}

/** Strict batch reference shape: M1, M2, … — no M0, no leading zeros, no gaps in trust. */
const EVIDENCE_REF_PATTERN = /^M[1-9][0-9]*$/u

/**
 * Distinct accumulated REPEATED_BEHAVIOR evidence items required for a durable
 * write. The per-batch gate and the cross-batch accumulator
 * (`memory-evidence-accumulator.ts`) share this one threshold.
 */
export const REPEATED_EVIDENCE_ADMISSION_THRESHOLD = 2

export type AutomaticEvidenceRejection =
  | 'EVIDENCE_TYPE_NOT_ALLOWED'
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_INVALID'
  | 'INSUFFICIENT_EVIDENCE'
  | 'INFERRED_PATTERN_NOT_DURABLE'

export type AutomaticEvidenceGateResult =
  | { outcome: 'ADMIT'; metadata: MemoryEvidenceMetadata; validRefs: readonly string[] }
  | {
    outcome: 'SKIP'
    reason: AutomaticEvidenceRejection
    /** Deterministic diagnostic facts about what was declared and what counted. */
    declaredEvidenceType?: MemoryEvidenceType
    validReferenceCount: number
    validRefs: readonly string[]
  }

export interface AutomaticEvidenceGateInput {
  /** The extractor's declared evidence class, exactly as parsed. */
  declaredEvidenceType: unknown
  /** The extractor's declared `evidence` array, exactly as parsed. */
  declaredEvidenceRefs: unknown
  /** Number of messages in the current batch; refs must fall inside 1..batchSize. */
  batchSize: number
  now: number
}

/**
 * The phase-1 automatic durable write gate. Validation order is fixed:
 * evidence class, then evidence presence, then reference shape, then the
 * per-class admission rule. A candidate that fails never reaches
 * `MemoryStore.add`, and nothing the provider supplied beyond the class and
 * the references survives into the metadata.
 */
export function admitAutomaticEvidence(input: AutomaticEvidenceGateInput): AutomaticEvidenceGateResult {
  const declaredType = input.declaredEvidenceType
  const declaredEvidenceType = isMemoryEvidenceType(declaredType) ? declaredType : undefined
  if (declaredEvidenceType === undefined || !AUTOMATIC_MEMORY_EVIDENCE_TYPES.includes(declaredEvidenceType)) {
    return {
      outcome: 'SKIP',
      reason: 'EVIDENCE_TYPE_NOT_ALLOWED',
      declaredEvidenceType,
      validReferenceCount: 0,
      validRefs: [],
    }
  }

  if (!Array.isArray(input.declaredEvidenceRefs) || input.declaredEvidenceRefs.length === 0) {
    return {
      outcome: 'SKIP',
      reason: 'EVIDENCE_MISSING',
      declaredEvidenceType,
      validReferenceCount: 0,
      validRefs: [],
    }
  }

  const skipWith = (reason: AutomaticEvidenceRejection, validRefs: readonly string[]): AutomaticEvidenceGateResult => ({
    outcome: 'SKIP',
    reason,
    declaredEvidenceType,
    validReferenceCount: validRefs.length,
    validRefs,
  })

  // Every reference must be well-formed, inside the current batch, and distinct.
  // Malformed shapes, out-of-range numbers (M999, M0) and duplicates are all
  // rejected outright: the distinct-count semantics required by
  // REPEATED_BEHAVIOR must never be produced by deduping whatever a provider
  // happened to list.
  const validRefs: string[] = []
  for (const ref of input.declaredEvidenceRefs) {
    if (typeof ref !== 'string' || !EVIDENCE_REF_PATTERN.test(ref)) {
      return skipWith('EVIDENCE_INVALID', validRefs)
    }
    const index = Number.parseInt(ref.slice(1), 10)
    if (!Number.isInteger(index) || index < 1 || index > input.batchSize) {
      return skipWith('EVIDENCE_INVALID', validRefs)
    }
    if (validRefs.includes(ref)) {
      return skipWith('EVIDENCE_INVALID', validRefs)
    }
    validRefs.push(ref)
  }

  const skip = (reason: AutomaticEvidenceRejection): AutomaticEvidenceGateResult => skipWith(reason, validRefs)

  if (declaredEvidenceType === 'INFERRED_PATTERN') {
    // Phase 1: an inferred pattern is never durable on its own. A later
    // evidence accumulator will decide when inference earns a write.
    return skip('INFERRED_PATTERN_NOT_DURABLE')
  }
  if (declaredEvidenceType === 'REPEATED_BEHAVIOR' && validRefs.length < REPEATED_EVIDENCE_ADMISSION_THRESHOLD) {
    return skip('INSUFFICIENT_EVIDENCE')
  }

  const confidence = deriveMemoryEvidenceConfidence(declaredEvidenceType)
  if (confidence === null || validRefs.length < 1) {
    return skip('EVIDENCE_MISSING')
  }
  return {
    outcome: 'ADMIT',
    metadata: {
      evidenceType: declaredEvidenceType,
      confidence,
      evidenceCount: validRefs.length,
      firstEvidenceAt: input.now,
      lastEvidenceAt: input.now,
    },
    validRefs,
  }
}

/**
 * Authoritative evidence for the two runtime-owned explicit paths (owner
 * command add/update, self-address upsert). The owner's word is confidence 1;
 * an upgrade keeps the original first-evidence time and counts the new
 * statement as one more piece of evidence.
 */
export function upgradedExplicitEvidence(
  previous: PriorEvidenceView | undefined,
  evidenceType: 'EXPLICIT_OWNER_COMMAND' | 'EXPLICIT_SELF_ADDRESS',
  now: number,
): MemoryEvidenceMetadata {
  return {
    evidenceType,
    confidence: 1,
    evidenceCount: (previous?.evidenceCount ?? 0) + 1,
    firstEvidenceAt: typeof previous?.firstEvidenceAt === 'number' &&
        Number.isFinite(previous.firstEvidenceAt)
      ? previous.firstEvidenceAt
      : now,
    lastEvidenceAt: now,
  }
}

/**
 * Metadata for a REPEATED_BEHAVIOR record admitted on the accumulator's
 * runtime-maintained count. The confidence stays the fixed table value (never
 * provider-derived); firstEvidenceAt carries the pool's first-seen time, so
 * provenance can predate the record's own creation.
 */
export function accumulatedRepeatedEvidenceMetadata(input: {
  evidenceCount: number
  firstSeenAt: number
  now: number
}): MemoryEvidenceMetadata {
  const confidence = deriveMemoryEvidenceConfidence('REPEATED_BEHAVIOR')
  return {
    evidenceType: 'REPEATED_BEHAVIOR',
    confidence: confidence ?? 0,
    evidenceCount: input.evidenceCount,
    // The pool clock and the service clock are the same function in
    // production, so firstSeenAt <= now always holds; the clamp keeps the
    // first <= last invariant intact even if a caller injects skewed clocks.
    firstEvidenceAt: Math.min(input.firstSeenAt, input.now),
    lastEvidenceAt: Math.max(input.firstSeenAt, input.now),
  }
}
