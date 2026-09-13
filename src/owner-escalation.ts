import { sanitizePublicDisplayName } from './public-display-name.js'

/** Reasons that may or may not justify directing a user to the trusted Owner. */
export type OwnerEscalationReason =
  | 'CAPABILITY_UNAVAILABLE'
  | 'PROGRAM_BOUNDARY'
  | 'OWNER_ONLY_ACTION'
  | 'AUTHORIZATION_REQUIRED'
  | 'SAFETY_REFUSAL'
  | 'CONTENT_POLICY_REFUSAL'
  | 'DANGEROUS_REQUEST'
  | 'IDENTITY_INTEGRITY'
  | 'ASSISTANT_IDENTITY_MUTATION'
  | 'OTHER_MEMBER_MEMORY_MUTATION'
  | 'REQUESTER_ISOLATION_BOUNDARY'
  | 'SECURITY_BOUNDARY'

/** Only capability and authorization failures may mention the trusted Owner. */
export function shouldSuggestOwnerEscalation(reason: OwnerEscalationReason): boolean {
  return reason === 'CAPABILITY_UNAVAILABLE' ||
    reason === 'PROGRAM_BOUNDARY' ||
    reason === 'OWNER_ONLY_ACTION' ||
    reason === 'AUTHORIZATION_REQUIRED'
}

export interface TrustedOwnerEscalationFacts {
  ownerConfigured: boolean
  ownerDisplayName: string | null
}

/** Render a deterministic capability hint without adding the P2.1 signature. */
export function renderOwnerEscalationHint(
  reason: OwnerEscalationReason,
  facts: TrustedOwnerEscalationFacts,
): string {
  if (!shouldSuggestOwnerEscalation(reason)) {
    return ''
  }

  const ownerName = facts.ownerConfigured
    ? sanitizePublicDisplayName(facts.ownerDisplayName)
    : null
  switch (reason) {
    case 'CAPABILITY_UNAVAILABLE':
      return ownerName === null ? '这个我现在做不了。' : `这个我现在做不了，得问问${ownerName}。`
    case 'PROGRAM_BOUNDARY':
      return ownerName === null ? '这个我现在处理不了。' : `这个超出我现在能处理的范围，得问问${ownerName}。`
    case 'OWNER_ONLY_ACTION':
      return ownerName === null ? '这个我现在处理不了。' : `这个需要${ownerName}来处理。`
    case 'AUTHORIZATION_REQUIRED':
      return ownerName === null ? '这个权限我没有。' : `这个权限我没有，得问问${ownerName}。`
    default:
      return ''
  }
}
