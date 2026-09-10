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
 *  - Origin: Automatic | ExplicitOwner.
 *  - WriteStatus: Written | Skipped | Failed | Disabled | Invalid.
 *  - MemoryRecord carries scope + scope id + content + visibility + origin +
 *    source conversation/sender + created/updated timestamps + soft delete.
 *  - MemoryText.Normalize collapses whitespace; Hash is SHA-256 hex over the
 *    normalized content; ForModel masks raw identity markers for the model.
 */
import { createHash } from 'node:crypto'
import type { ConversationType } from './message-contract.js'

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

export type MemoryOrigin = 'AUTOMATIC' | 'EXPLICIT_OWNER'

export type MemoryWriteStatus = 'WRITTEN' | 'SKIPPED' | 'FAILED' | 'DISABLED' | 'INVALID'

export interface MemoryRecord {
  memoryId: string
  scopeType: MemoryScopeType
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
  content: string
}

/** Rejected candidate reason, used for `[MEMORY_WRITE]` diagnostics. */
export type MemoryCandidateRejection =
  | 'EMPTY_FACT'
  | 'CONTENT_TOO_LONG'
  | 'RAW_IDENTITY_IN_CONTENT'
  | 'SCOPE_NOT_ALLOWED_FOR_ROLE'
  | 'SCOPE_IDENTITY_MISSING'

export const MEMORY_TEXT_MARKER = 'wxid_'
export const MEMORY_MAX_CONTENT_CHARS = 500
export const MEMORY_NORMALIZE_MAX_CHARS = 512

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

/** True when the text carries a raw identity marker that must not be persisted. */
export function containsRawIdentityMarker(content: string): boolean {
  return content.includes(MEMORY_TEXT_MARKER)
}
