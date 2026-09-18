/**
 * Memory domain model.
 *
 * Migrated from the historical v02 implementation
 * (`WeixinHookCs-v02/WeixinHookCs/src/WeixinHook.UI/MemoryModels.cs`), which is
 * the only accepted semantic source for this round. The shapes below keep the
 * historical fields; the identity fields are re-typed to the current trusted
 * contract (`requesterId` / `conversationId`), never to wxid or a re-derived
 * signature.
 *
 * HISTORICAL_SEMANTIC (v02):
 *  - ScopeType: Owner | Member | Group.
 *  - Visibility: Private | Shared.
 *  - Origin: Automatic | ExplicitOwner | ExplicitSelfAddress.
 *  - WriteStatus: Written | Skipped | Failed | Disabled | Invalid.
 *  - MemoryRecord carries scope + scope id + content + visibility + origin +
 *    source conversation/sender + created/updated timestamps + soft delete.
 *  - MemoryText.Normalize collapses whitespace; Hash is SHA-256 hex over the
 *    normalized content; ForModel masks raw identity markers for the model.
 */
import { createHash } from 'node:crypto'
import type { ConversationType } from './message-contract.js'
import type { MemoryKind, MemorySubject } from './assistant-identity.js'
import type { MemoryEvidenceType } from './memory-evidence.js'

/** Personal scope of the owner requester. */
export const MEMORY_SCOPE_OWNER = 'OWNER'
/** Personal scope of a non-owner requester. */
export const MEMORY_SCOPE_MEMBER = 'MEMBER'
/** Shared scope of one conversation. */
export const MEMORY_SCOPE_GROUP = 'GROUP'

export type MemoryScopeType =
  | typeof MEMORY_SCOPE_OWNER
  | typeof MEMORY_SCOPE_MEMBER
  | typeof MEMORY_SCOPE_GROUP

export type MemoryVisibility = 'PRIVATE' | 'SHARED'

export type MemoryOrigin = 'AUTOMATIC' | 'EXPLICIT_OWNER' | 'EXPLICIT_SELF_ADDRESS'

export type MemoryWriteStatus = 'WRITTEN' | 'SKIPPED' | 'FAILED' | 'DISABLED' | 'INVALID'

export interface MemoryRecord {
  memoryId: string
  scopeType: MemoryScopeType
  /** Semantic subject/kind for the memory policy; absent only on legacy records. */
  kind?: MemoryKind
  /** Semantic subject for the memory policy; absent only on legacy records. */
  subject?: MemorySubject
  /** OWNER/MEMBER: canonical requester id. GROUP: conversation id. */
  scopeId: string
  content: string
  contentHash: string
  visibility: MemoryVisibility
  origin: MemoryOrigin
  sourceConversationType: ConversationType | null
  sourceConversationId: string | null
  /** Local storage index only. Never logged and never sent to a provider. */
  sourceSenderId: string | null
  createdAt: number
  updatedAt: number
  isDeleted: boolean
  /**
   * EVIDENCE / CONFIDENCE FOUNDATION (optional backward-compatible extension,
   * file schema stays version 1). Absent on legacy records, which read as
   * LEGACY_UNKNOWN; the fields are audit/write metadata only and never affect
   * retrieval semantics. `confidence` is always runtime-derived (see
   * `memory-evidence.ts`), never provider-supplied.
   */
  evidenceType?: MemoryEvidenceType
  confidence?: number
  evidenceCount?: number
  firstEvidenceAt?: number
  lastEvidenceAt?: number
}

export interface MemoryAccessRule {
  scopeType: MemoryScopeType
  scopeId: string
  visibility: MemoryVisibility
}

/**
 * Provider-safe memory item. The historical model carried a display name and a
 * role; both are dropped here because the provider may only receive the content
 * and a safe scope class (see §8 of the migration contract).
 */
export interface MemoryContextItem {
  scope: 'PERSONAL' | 'GROUP'
  content: string
  kind?: MemoryKind
}

/** One buffered message feeding the automatic extractor. */
export interface MemoryInputMessage {
  /** Privacy-safe pseudonymous speaker label, never a raw identity. */
  speakerLabel: string
  role: 'OWNER' | 'MEMBER'
  content: string
}

/** Extractor output candidate, before scope/identity validation. */
export interface MemoryCandidate {
  scopeType: MemoryScopeType
  subject: MemorySubject
  kind: MemoryKind
  content: string
  /**
   * The extractor's declared evidence class (automatic subset only). The
   * runtime validates it against the closed set — a provider declaring a
   * runtime-owned class is rejected, never trusted.
   */
  evidenceType?: MemoryEvidenceType
  /**
   * The extractor's declared batch references, exactly as parsed (raw values).
   * Batch-local transport only: never persisted, never rendered — the runtime
   * converts them to an evidence count or rejects the candidate.
   */
  evidenceRefs?: readonly unknown[]
}

/** Rejected candidate reason, used for `[MEMORY_WRITE]` diagnostics. */
export type MemoryCandidateRejection =
  | 'EMPTY_FACT'
  | 'CONTENT_TOO_LONG'
  | 'RAW_IDENTITY_IN_CONTENT'
  | 'SCOPE_NOT_ALLOWED_FOR_ROLE'
  | 'SCOPE_IDENTITY_MISSING'
  | 'AUTOMATIC_GROUP_SCOPE_NOT_WRITABLE'
  | 'ASSISTANT_IDENTITY_NOT_WRITABLE'
  | 'ASSISTANT_RELATIONSHIP_NOT_WRITABLE'
  | 'ASSISTANT_RULE_NOT_WRITABLE'
  | 'THIRD_PARTY_ASSERTION_NOT_WRITABLE'
  | 'EPHEMERAL_CONVENTION_NOT_WRITABLE'
  | 'EVIDENCE_TYPE_NOT_ALLOWED'
  | 'EVIDENCE_MISSING'
  | 'EVIDENCE_INVALID'
  | 'INSUFFICIENT_EVIDENCE'
  | 'INFERRED_PATTERN_NOT_DURABLE'

export const MEMORY_TEXT_MARKER = 'wxid_'
export const MEMORY_MAX_CONTENT_CHARS = 500
export const MEMORY_NORMALIZE_MAX_CHARS = 512
const RAW_IDENTITY_MARKERS = [
  MEMORY_TEXT_MARKER,
  'wxid=',
  'Wxid=',
  'Signature=',
  'signature=',
  'senderId=',
  'SenderId=',
  'sourceSenderId=',
  'requesterId=',
  'RequesterId=',
  'conversationId=',
  'ConversationId=',
] as const

export const MemoryText = {
  /** Historical `MemoryText.Normalize`: trim + collapse whitespace. */
  normalize(content: string): string {
    return content.split(/\s+/u).filter((part) => part.length > 0).join(' ')
  },

  /** Historical content hash: SHA-256 hex of the normalized content. */
  hash(normalizedContent: string): string {
    return createHash('sha256').update(normalizedContent, 'utf8').digest('hex').toUpperCase()
  },

  /**
   * Historical `MemoryText.ForModel`: strips identity markers that must never
   * be shown to a provider. Kept as the single renderer for memory content.
   */
  forModel(content: string): string {
    let text = content
      .replaceAll('@chatroom', '群聊')
      .replaceAll('Signature=', '')
      .replaceAll('senderId=', '')

    let result = ''
    let start = 0
    for (;;) {
      const index = text.indexOf(MEMORY_TEXT_MARKER, start)
      if (index < 0) {
        result += text.slice(start)
        break
      }

      result += text.slice(start, index)
      let end = index + MEMORY_TEXT_MARKER.length
      while (end < text.length && /[A-Za-z0-9_-]/u.test(text[end] as string)) {
        end += 1
      }
      result += '群成员'
      start = end
    }

    return result
  },
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^\${}()|[\]\\]/gu, '\\$&')
}

/**
 * Converts only a current requester's exact identity-led self fact into a
 * provider/storage-safe first-person form. Other text is returned unchanged so
 * the write guard can reject it instead of guessing what it means.
 */
export function normalizeCurrentRequesterSelfReference(content: string, requesterId: string): string {
  const normalized = MemoryText.normalize(content)
  const identity = requesterId.trim()
  if (normalized.length === 0 || identity.length === 0) {
    return normalized
  }

  const identityPrefix = '(?:(?:wxid|Signature|senderId|requesterId|conversationId|ConversationId)=)?'
  const pattern = new RegExp(
    '^' + identityPrefix + escapeRegExp(identity) +
      '(?:\\s*的)?(?:代号|名字|姓名|昵称|称呼)?\\s*(?:是|叫|为)\\s*(.+)$',
    'u',
  )
  const match = pattern.exec(normalized)
  if (!match) {
    return normalized
  }

  const fact = MemoryText.normalize(match[1] ?? '')
  return fact.length > 0 ? '我叫' + fact : normalized
}

/** True when the text carries a raw identity marker that must not be persisted. */
export function containsRawIdentityMarker(content: string): boolean {
  return RAW_IDENTITY_MARKERS.some((marker) => content.includes(marker))
}
