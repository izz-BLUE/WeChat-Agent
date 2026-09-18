/**
 * Persistent memory store.
 *
 * HISTORICAL_SEMANTIC (v02 `MemoryStore.cs`): one table `memories` keyed by
 * `(scope_type, scope_id, content_hash)` with a partial unique index over
 * non-deleted rows, soft delete, `ORDER BY updated_at DESC`, a single write
 * gate, and an explicit init failure mode (`IsEnabled=false`) so a broken store
 * degrades instead of breaking chat.
 *
 * CURRENT_MIGRATION_DECISION: the storage medium is a single JSON document with
 * atomic temp-file + rename replacement instead of SQLite. Rationale:
 *  - no new dependency and no native module, so the Agent candidate stays pure
 *    JS (the historical C# used Microsoft.Data.Sqlite; the TS runtime has none),
 *  - Node's builtin `node:sqlite` is still an experimental API surface,
 *  - every historical semantic above (unique key, soft delete, updated_at
 *    ordering, write gate, explicit failure) is preserved one-to-one, so a later
 *    swap to SQLite is a storage change behind this same interface.
 *
 * The store never treats corruption as "normal": an unreadable or malformed file
 * disables the store, is reported as `result=FAIL`, and is left untouched on
 * disk so the data can be inspected instead of silently overwritten.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  emitDiagnostic,
  type DiagnosticFields,
  type PersistentRuntimeLogSink,
} from './persistent-runtime-log.js'
import {
  MEMORY_KINDS,
  MEMORY_SUBJECTS,
  type MemoryKind,
  type MemorySubject,
} from './assistant-identity.js'
import {
  MemoryText,
  type MemoryAccessRule,
  type MemoryRecord,
  type MemoryScopeType,
  type MemoryVisibility,
  type MemoryWriteStatus,
} from './memory-models.js'
import { isMemoryEvidenceType, type MemoryEvidenceMetadata } from './memory-evidence.js'

export const MEMORY_STORE_SCHEMA_VERSION = 1

interface MemoryStoreDocument {
  version: number
  records: MemoryRecord[]
}

export interface MemoryStoreOptions {
  /** Explicit runtime data file. Release artifact roots are rejected. */
  filePath: string
  log?: (message: string) => void
  /**
   * Durable sink for the same `MEMORY_STORE` diagnostics. When present every
   * line is also written to the persistent runtime log, so a store decision
   * survives the process; when absent the store stays stdout-only.
   */
  sink?: PersistentRuntimeLogSink
  /** Diagnostics only: where the path came from. */
  pathSource?: string
}

const RESERVED_SEGMENTS = ['artifacts', 'freeze', 'manifest', 'candidate']

/** Runtime memory data must never live inside a candidate / freeze artifact. */
export function isReleaseArtifactPath(filePath: string): boolean {
  const segments = filePath.split(/[\\/]+/u).filter((segment) => segment.length > 0)
  return segments.some((segment) => {
    const lower = segment.toLowerCase()
    return lower.startsWith('p0-') || RESERVED_SEGMENTS.some((reserved) => lower.includes(reserved))
  })
}

export class MemoryStore {
  public readonly filePath: string
  private readonly log: (message: string) => void
  private readonly sink: PersistentRuntimeLogSink | undefined
  private records: MemoryRecord[] = []
  private enabled = false
  private reason = 'NOT_INITIALIZED'

  public constructor(options: MemoryStoreOptions) {
    this.filePath = options.filePath
    this.log = options.log ?? ((message: string) => console.log(message))
    this.sink = options.sink
    this.initialize(options.pathSource ?? 'EXPLICIT')
  }

  /**
   * One store diagnostic: the stdout line the operator already knows plus the
   * same fields as a durable `MEMORY_STORE` event. Fields are enums, counts and
   * result/reason codes only — never a raw path, scope id or memory content.
   */
  private emit(fields: DiagnosticFields): void {
    emitDiagnostic(this.log, this.sink, 'MEMORY_STORE', fields)
  }

  public get isEnabled(): boolean {
    return this.enabled
  }

  public get disabledReason(): string {
    return this.reason
  }

  public get recordCount(): number {
    return this.records.length
  }

  /** Live (non-deleted) record count, for diagnostics only. */
  public get liveRecordCount(): number {
    return this.records.filter((record) => !record.isDeleted).length
  }

  public add(record: MemoryRecord): MemoryWriteStatus {
    if (!this.enabled) {
      return 'DISABLED'
    }

    const content = MemoryText.normalize(record.content)
    if (content.length === 0) {
      return 'INVALID'
    }

    const hash = MemoryText.hash(content)
    const duplicate = this.records.some(
      (existing) =>
        !existing.isDeleted &&
        existing.scopeType === record.scopeType &&
        existing.scopeId === record.scopeId &&
        existing.contentHash === hash,
    )
    if (duplicate) {
      return 'SKIPPED'
    }

    const stored: MemoryRecord = { ...record, content, contentHash: hash }
    this.records.push(stored)
    if (!this.save()) {
      this.records.pop()
      return 'FAILED'
    }
    return 'WRITTEN'
  }

  /**
   * Keep one live CURRENT_REQUESTER ADDRESS_PREFERENCE per personal scope.
   * The service is responsible for authorizing the scope; the store only
   * performs the atomic single-value replacement.
   */
  public upsertAddressPreference(record: MemoryRecord): MemoryWriteStatus {
    if (!this.enabled) {
      return 'DISABLED'
    }
    if ((record.scopeType !== 'OWNER' && record.scopeType !== 'MEMBER') ||
        record.scopeId.trim().length === 0 ||
        record.visibility !== 'SHARED' ||
        record.kind !== 'ADDRESS_PREFERENCE' || record.subject !== 'CURRENT_REQUESTER') {
      return 'INVALID'
    }

    const content = MemoryText.normalize(record.content)
    if (content.length === 0) {
      return 'INVALID'
    }
    const hash = MemoryText.hash(content)
    const matches = this.records
      .map((existing, index) => ({ existing, index }))
      .filter(({ existing }) =>
        !existing.isDeleted &&
        existing.scopeType === record.scopeType &&
        existing.scopeId === record.scopeId &&
        existing.kind === 'ADDRESS_PREFERENCE' &&
        existing.subject === 'CURRENT_REQUESTER',
      )
      .sort((left, right) =>
        right.existing.updatedAt - left.existing.updatedAt ||
        (left.existing.memoryId < right.existing.memoryId ? -1 : left.existing.memoryId > right.existing.memoryId ? 1 : 0),
      )

    if (matches.length === 1 && matches[0]?.existing.contentHash === hash) {
      return 'SKIPPED'
    }

    const previous = this.records
    if (matches.length === 0) {
      this.records = [...this.records, { ...record, content, contentHash: hash }]
    } else {
      const primaryIndex = matches[0]!.index
      const matchingIndexes = new Set(matches.map(({ index }) => index))
      this.records = this.records.map((existing, index) => {
        if (index === primaryIndex) {
          return {
            ...existing,
            content,
            contentHash: hash,
            updatedAt: record.updatedAt,
            origin: record.origin,
            kind: 'ADDRESS_PREFERENCE',
            subject: 'CURRENT_REQUESTER',
            // The service builds authoritative explicit evidence for the
            // replacement; legacy records without evidence keep their absence.
            ...(record.evidenceType === undefined ? {} : {
              evidenceType: record.evidenceType,
              confidence: record.confidence,
              evidenceCount: record.evidenceCount,
              firstEvidenceAt: record.firstEvidenceAt,
              lastEvidenceAt: record.lastEvidenceAt,
            }),
          }
        }
        return matchingIndexes.has(index)
          ? { ...existing, isDeleted: true, updatedAt: record.updatedAt }
          : existing
      })
    }

    if (!this.save()) {
      this.records = previous
      return 'FAILED'
    }
    return 'WRITTEN'
  }

  public update(
    memoryId: string,
    content: string,
    updatedAt: number,
    kind?: MemoryKind,
    subject?: MemorySubject,
    evidence?: MemoryEvidenceMetadata,
  ): boolean {
    if (!this.enabled) {
      return false
    }

    const normalized = MemoryText.normalize(content)
    if (normalized.length === 0) {
      return false
    }

    const index = this.records.findIndex((record) => record.memoryId === memoryId && !record.isDeleted)
    if (index < 0) {
      return false
    }

    const previous = this.records[index] as MemoryRecord
    this.records[index] = {
      ...previous,
      content: normalized,
      contentHash: MemoryText.hash(normalized),
      updatedAt,
      ...(kind === undefined ? {} : { kind }),
      ...(subject === undefined ? {} : { subject }),
      ...(evidence === undefined ? {} : {
        evidenceType: evidence.evidenceType,
        confidence: evidence.confidence,
        evidenceCount: evidence.evidenceCount,
        firstEvidenceAt: evidence.firstEvidenceAt,
        lastEvidenceAt: evidence.lastEvidenceAt,
      }),
    }
    if (!this.save()) {
      this.records[index] = previous
      return false
    }
    return true
  }

  public delete(memoryId: string, updatedAt: number): boolean {
    if (!this.enabled) {
      return false
    }

    const index = this.records.findIndex((record) => record.memoryId === memoryId && !record.isDeleted)
    if (index < 0) {
      return false
    }

    const previous = this.records[index] as MemoryRecord
    this.records[index] = { ...previous, isDeleted: true, updatedAt }
    if (!this.save()) {
      this.records[index] = previous
      return false
    }
    return true
  }

  /** Historical `RetrieveAsync`: rule match, newest first, bounded count. */
  public retrieve(rules: readonly MemoryAccessRule[], maxCount: number): MemoryRecord[] {
    if (!this.enabled || maxCount <= 0 || rules.length === 0) {
      return []
    }

    const distinct = rules.filter(
      (rule, index) =>
        rules.findIndex(
          (candidate) =>
            candidate.scopeType === rule.scopeType &&
            candidate.scopeId === rule.scopeId &&
            candidate.visibility === rule.visibility,
        ) === index,
    )

    return this.records
      .filter((record) => !record.isDeleted)
      .filter((record) =>
        distinct.some(
          (rule) =>
            rule.scopeType === record.scopeType &&
            rule.scopeId === record.scopeId &&
            rule.visibility === record.visibility,
        ),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt || (left.memoryId < right.memoryId ? -1 : left.memoryId > right.memoryId ? 1 : 0))
      .slice(0, maxCount)
  }

  private initialize(pathSource: string): void {
    if (isReleaseArtifactPath(this.filePath)) {
      this.reason = 'RESERVED_RELEASE_PATH'
      this.emit({ operation: 'INIT', result: 'FAIL', reason: 'RESERVED_RELEASE_PATH', source: pathSource, enabled: false })
      return
    }

    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
    } catch {
      this.reason = 'DATA_DIRECTORY_UNAVAILABLE'
      this.emit({ operation: 'INIT', result: 'FAIL', reason: 'DATA_DIRECTORY_UNAVAILABLE', source: pathSource, enabled: false })
      return
    }

    const loaded = this.load()
    if (!loaded) {
      // The failure is already reported by `load`; this makes the resulting
      // DISABLED decision explicit on both channels instead of being inferable
      // only from the absence of an INIT pass.
      this.emit({ operation: 'INIT', result: 'FAIL', reason: this.reason, source: pathSource, enabled: false })
      return
    }

    this.enabled = true
    this.emit({ operation: 'INIT', result: 'PASS', source: pathSource, recordCount: this.liveRecordCount, enabled: true })
  }

  private load(): boolean {
    if (!existsSync(this.filePath)) {
      this.records = []
      this.emit({ operation: 'LOAD', result: 'PASS', reason: 'CREATED', recordCount: 0 })
      return true
    }

    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      this.reason = 'UNREADABLE'
      this.emit({ operation: 'LOAD', result: 'FAIL', reason: 'UNREADABLE', recordCount: 0 })
      return false
    }

    let document: unknown
    try {
      document = JSON.parse(raw) as unknown
    } catch {
      this.reason = 'CORRUPT'
      this.emit({ operation: 'LOAD', result: 'FAIL', reason: 'CORRUPT', recordCount: 0 })
      return false
    }

    const parsed = parseDocument(document)
    if (parsed === null) {
      this.reason = 'CORRUPT'
      this.emit({ operation: 'LOAD', result: 'FAIL', reason: 'CORRUPT', recordCount: 0 })
      return false
    }

    this.records = parsed
    this.emit({ operation: 'LOAD', result: 'PASS', recordCount: this.liveRecordCount })
    return true
  }

  /** Atomic replacement: write a sibling temp file, fsync, then rename over. */
  private save(): boolean {
    const document: MemoryStoreDocument = { version: MEMORY_STORE_SCHEMA_VERSION, records: this.records }
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`
    try {
      const payload = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8')
      const handle = openSync(temporaryPath, 'w')
      try {
        writeSync(handle, payload, 0, payload.length, 0)
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      renameSync(temporaryPath, this.filePath)
    } catch (error) {
      try {
        rmSync(temporaryPath, { force: true })
      } catch {
        // A leftover temp file is harmless; the real failure is reported below.
      }
      this.emit({
        operation: 'SAVE',
        result: 'FAIL',
        reason: error instanceof Error ? error.name : 'UNKNOWN',
        recordCount: this.liveRecordCount,
      })
      return false
    }

    this.emit({ operation: 'SAVE', result: 'PASS', recordCount: this.liveRecordCount })
    return true
  }
}

function parseDocument(value: unknown): MemoryRecord[] | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const document = value as Partial<MemoryStoreDocument>
  if (document.version !== MEMORY_STORE_SCHEMA_VERSION || !Array.isArray(document.records)) {
    return null
  }

  const records: MemoryRecord[] = []
  for (const entry of document.records) {
    const record = parseRecord(entry)
    if (record === null) {
      return null
    }
    records.push(record)
  }
  return records
}

const SCOPE_TYPES: readonly MemoryScopeType[] = ['OWNER', 'MEMBER', 'GROUP']
const VISIBILITIES: readonly MemoryVisibility[] = ['PRIVATE', 'SHARED']

const EVIDENCE_FIELD_KEYS = [
  'evidenceType',
  'confidence',
  'evidenceCount',
  'firstEvidenceAt',
  'lastEvidenceAt',
] as const

/**
 * Backward-compatible evidence extension (file schema stays version 1).
 * A record without any evidence field is a legacy record and is accepted as
 * always. A record with evidence fields must carry the complete, valid set —
 * the writer always stores all five together, so a partial or out-of-range set
 * is corruption, same as any other invalid field.
 */
function parseEvidenceFields(record: Record<string, unknown>): MemoryEvidenceMetadata | undefined | null {
  const present = EVIDENCE_FIELD_KEYS.filter((key) => record[key] !== undefined)
  if (present.length === 0) {
    return undefined
  }
  if (present.length !== EVIDENCE_FIELD_KEYS.length) {
    return null
  }
  if (!isMemoryEvidenceType(record.evidenceType)) {
    return null
  }
  const confidence = record.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null
  }
  const evidenceCount = record.evidenceCount
  if (typeof evidenceCount !== 'number' || !Number.isSafeInteger(evidenceCount) || evidenceCount < 1) {
    return null
  }
  const firstEvidenceAt = record.firstEvidenceAt
  const lastEvidenceAt = record.lastEvidenceAt
  if (!Number.isFinite(firstEvidenceAt) || !Number.isFinite(lastEvidenceAt)) {
    return null
  }
  if ((firstEvidenceAt as number) > (lastEvidenceAt as number)) {
    return null
  }
  return {
    evidenceType: record.evidenceType,
    confidence,
    evidenceCount,
    firstEvidenceAt: firstEvidenceAt as number,
    lastEvidenceAt: lastEvidenceAt as number,
  }
}

function parseRecord(value: unknown): MemoryRecord | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const scopeType = record.scopeType
  const visibility = record.visibility

  if (typeof record.memoryId !== 'string' || record.memoryId.length === 0) return null
  if (typeof scopeType !== 'string' || !SCOPE_TYPES.includes(scopeType as MemoryScopeType)) return null
  if (typeof record.scopeId !== 'string' || record.scopeId.length === 0) return null
  if (typeof record.content !== 'string' || record.content.length === 0) return null
  if (typeof record.contentHash !== 'string' || record.contentHash.length === 0) return null
  if (typeof visibility !== 'string' || !VISIBILITIES.includes(visibility as MemoryVisibility)) return null
  if (record.origin !== 'AUTOMATIC' && record.origin !== 'EXPLICIT_OWNER' && record.origin !== 'EXPLICIT_SELF_ADDRESS') return null
  if (record.kind !== undefined &&
      (typeof record.kind !== 'string' || !MEMORY_KINDS.includes(record.kind as MemoryKind))) return null
  if (record.subject !== undefined &&
      (typeof record.subject !== 'string' || !MEMORY_SUBJECTS.includes(record.subject as MemorySubject))) return null
  if (record.sourceConversationType !== null && record.sourceConversationType !== 'GROUP' && record.sourceConversationType !== 'DIRECT') return null
  if (record.sourceConversationId !== null && typeof record.sourceConversationId !== 'string') return null
  if (record.sourceSenderId !== null && typeof record.sourceSenderId !== 'string') return null
  if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) return null
  if (typeof record.isDeleted !== 'boolean') return null

  const evidence = parseEvidenceFields(record)
  if (evidence === null) {
    return null
  }

  return {
    memoryId: record.memoryId,
    scopeType: scopeType as MemoryScopeType,
    kind: record.kind as MemoryKind | undefined,
    subject: record.subject as MemorySubject | undefined,
    scopeId: record.scopeId,
    content: record.content,
    contentHash: record.contentHash,
    visibility: visibility as MemoryVisibility,
    origin: record.origin,
    sourceConversationType: record.sourceConversationType as MemoryRecord['sourceConversationType'],
    sourceConversationId: record.sourceConversationId,
    sourceSenderId: record.sourceSenderId,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
    isDeleted: record.isDeleted,
    ...(evidence === undefined ? {} : evidence),
  }
}

/** Default runtime data file: `<dir>/memory.json`. */
export function memoryFileIn(directory: string): string {
  return join(directory, 'memory.json')
}
