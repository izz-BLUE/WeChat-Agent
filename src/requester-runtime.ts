import { sanitizePublicDisplayName } from './public-display-name.js'
import type { ConversationType, PublicDisplayNameSource } from './message-contract.js'

/**
 * Trusted facts for the current requester. Raw ids stay inside the runtime and
 * memory scope machinery; the provider receives only the stable speaker label
 * plus the current display metadata.
 */
export interface RequesterRuntimeContext {
  conversationType: ConversationType
  conversationId: string
  requesterId: string
  requesterSource: string
  speakerLabel: string
  publicDisplayName: string | null
  publicDisplayNameSource: PublicDisplayNameSource
}

/**
 * A compact system-level fact shared by initial generation and every rewrite.
 * The resolver's current value is authoritative presentation metadata; it never
 * grants authority and never changes the identity/scope key.
 */
export function formatRequesterRuntimeFacts(
  context: RequesterRuntimeContext | undefined,
): string {
  if (context === undefined || context.conversationType !== 'GROUP') {
    return ''
  }

  const displayName = sanitizePublicDisplayName(context.publicDisplayName)
  if (displayName === null) {
    return ''
  }
  return [
    '[Current Group Participant: TRUSTED_RUNTIME_FACT]',
    `CURRENT_REQUESTER_SPEAKER_LABEL=${context.speakerLabel}`,
    'CURRENT_REQUESTER_IDENTITY=TRUSTED_RUNTIME_IDENTITY',
    'CURRENT_REQUESTER_IDENTITY_SOURCE=TRUSTED_RUNTIME',
    `CURRENT_GROUP_DISPLAY_NAME=${displayName}`,
    `CURRENT_GROUP_DISPLAY_NAME_SOURCE=${context.publicDisplayNameSource}`,
    'DISPLAY_NAME_IS_PRESENTATION_ONLY=true',
    'DISPLAY_NAME_IS_NOT_AUTHORIZATION=true',
    'DISPLAY_NAME_IS_NOT_MEMORY_SCOPE_KEY=true',
    'CURRENT_DISPLAY_NAME_PRECEDENCE=ROOM_DATA>LOCAL_BINDING>LEGACY_RUNTIME>NONE',
  ].join('\n')
}
