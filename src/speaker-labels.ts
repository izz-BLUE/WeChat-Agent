/**
 * Privacy-safe speaker labels for the provider prompt.
 *
 * The GROUP requester identity is an opaque runtime token, so it must never be
 * rendered. A single conversation can still contain several MEMBERs, and the
 * reply model has to tell "the current requester said this" from "another member
 * said this" — otherwise another member's sentence can be attributed to the
 * current requester, which is exactly the A/B personal-memory hazard.
 *
 * CURRENT_MIGRATION_DECISION: GROUP members get a conversation-stable
 * pseudonymous label (`MEMBER_1`, `MEMBER_2`, ...) instead of a bare `MEMBER`.
 * The label is:
 *  - derived from the trusted runtime requester id used only as a local index,
 *  - never a raw identity and never logged as one,
 *  - never an authorization input (the role fact decides permissions),
 *  - never a memory storage key (memory keys are the trusted ids),
 *  - never rendered to a WeChat user (see `answer-guard.ts` for that boundary).
 */
import type { ConversationType, RequesterRole } from './message-contract.js'

/** Everything needed to render a stateless label. No raw identity is rendered. */
export interface SpeakerDisplayFacts {
  conversationType: ConversationType
  requesterRole: RequesterRole
  ownerDisplayName: string | null
  senderName: string | null
  senderId: string
}

/** Stateless label facts plus the conversation/requester keys of a registry. */
export interface SpeakerFacts extends SpeakerDisplayFacts {
  conversationId: string
  requesterId: string
}

export const MEMBER_LABEL_PREFIX = 'MEMBER_'

/** The role label used where no pseudonymous registry exists. */
export const MEMBER_LABEL = 'MEMBER'

/**
 * Stateless rendering, used where no conversation registry exists (DIRECT
 * legacy display, tests, single-turn prompts).
 */
export function statelessSpeakerLabel(facts: SpeakerDisplayFacts): string {
  if (facts.conversationType === 'DIRECT') {
    // Legacy direct display. Its identity semantics are still unverified, which
    // is exactly why it cannot produce an OWNER label.
    return facts.senderName ?? facts.senderId
  }

  if (facts.requesterRole === 'OWNER') {
    return facts.ownerDisplayName ?? 'OWNER'
  }

  return MEMBER_LABEL
}

/**
 * Conversation-scoped label registry. Member pseudonyms are stable for the
 * lifetime of the registry (one Agent process), so the transcript stays readable
 * without ever exposing a requester id.
 */
export class SpeakerLabelRegistry {
  private readonly byConversation = new Map<string, Map<string, string>>()

  public labelFor(facts: SpeakerFacts): string {
    if (facts.conversationType === 'DIRECT' || facts.requesterRole === 'OWNER') {
      return statelessSpeakerLabel(facts)
    }

    let labels = this.byConversation.get(facts.conversationId)
    if (!labels) {
      labels = new Map<string, string>()
      this.byConversation.set(facts.conversationId, labels)
    }

    const existing = labels.get(facts.requesterId)
    if (existing !== undefined) {
      return existing
    }

    const label = `${MEMBER_LABEL_PREFIX}${labels.size + 1}`
    labels.set(facts.requesterId, label)
    return label
  }
}

/** True when a label is a pseudonymous member label. */
export function isPseudonymousMemberLabel(label: string): boolean {
  return new RegExp(`^${MEMBER_LABEL_PREFIX}\\d+$`, 'u').test(label)
}

/**
 * True when a label is runtime-only speaker bookkeeping. Such a label may be used
 * to tell speakers apart, but it must never reach a WeChat user: the owner's own
 * display name (or the `OWNER` role word) is public metadata, while a member
 * pseudonym is not.
 */
export function isInternalSpeakerLabel(label: string): boolean {
  return label === MEMBER_LABEL || isPseudonymousMemberLabel(label)
}
