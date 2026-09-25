export const OWNER_CHAT_REQUEST_KIND = 'OWNER_CHAT_REQUEST' as const
export const OWNER_CHAT_RESPONSE_KIND = 'OWNER_CHAT_RESPONSE' as const
export const OWNER_CHAT_CONVERSATION_ID = 'owner-chat:default-v1' as const
export const OWNER_CHAT_MAX_TEXT_CHARS = 12_000
export const OWNER_CHAT_MAX_CONTEXT_CHARS = 12_000
export const OWNER_CHAT_MAX_CONTEXT_MESSAGES = 40

export type OwnerChatErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_AUTHORITY'
  | 'ATTACHMENTS_UNSUPPORTED'
  | 'UNAVAILABLE'
  | 'PROVIDER_ERROR'

export interface OwnerChatRecentMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface OwnerChatAuthority {
  source: 'LOCAL_UI_OWNER_CONFIGURATION'
  requesterRole: 'OWNER'
  ownerConfigured: true
  scope: 'OWNER_CHAT'
  ownerDisplayName: string | null
  creatorDisplayName: string | null
}

export interface OwnerChatRequest {
  kind: typeof OWNER_CHAT_REQUEST_KIND
  requestId: string
  conversationId: typeof OWNER_CHAT_CONVERSATION_ID
  timestamp: number
  authority: OwnerChatAuthority
  text: string
  recentContext: OwnerChatRecentMessage[]
  attachments?: []
}

export interface OwnerChatResponse {
  kind: typeof OWNER_CHAT_RESPONSE_KIND
  requestId: string
  status: 'OK' | 'ERROR'
  text?: string
  errorCode?: OwnerChatErrorCode
}

export interface OwnerChatHandlerLike {
  handle(request: OwnerChatRequest): Promise<string>
}

export type ParsedOwnerChatEnvelope =
  | { kind: typeof OWNER_CHAT_REQUEST_KIND; requestId: string; request: OwnerChatRequest }
  | { kind: typeof OWNER_CHAT_REQUEST_KIND; requestId: string; errorCode: OwnerChatErrorCode }

const REQUEST_KEYS = new Set([
  'kind', 'requestId', 'conversationId', 'timestamp', 'authority', 'text', 'recentContext', 'attachments',
])
const AUTHORITY_KEYS = new Set([
  'source', 'requesterRole', 'ownerConfigured', 'scope', 'ownerDisplayName', 'creatorDisplayName',
])
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function parseOwnerChatEnvelope(value: Record<string, unknown>): ParsedOwnerChatEnvelope {
  const requestId = typeof value.requestId === 'string' && value.requestId.length <= 128
    ? value.requestId
    : ''
  const fail = (errorCode: OwnerChatErrorCode): ParsedOwnerChatEnvelope => ({
    kind: OWNER_CHAT_REQUEST_KIND,
    requestId,
    errorCode,
  })

  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments)) return fail('INVALID_REQUEST')
    if (value.attachments.length > 0) return fail('ATTACHMENTS_UNSUPPORTED')
  }
  if (Object.keys(value).some((key) => !REQUEST_KEYS.has(key))) return fail('INVALID_REQUEST')
  if (typeof value.requestId !== 'string' || !REQUEST_ID_PATTERN.test(value.requestId)) return fail('INVALID_REQUEST')
  if (value.conversationId !== OWNER_CHAT_CONVERSATION_ID ||
      typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp) ||
      typeof value.text !== 'string' || value.text.trim().length === 0 ||
      value.text.length > OWNER_CHAT_MAX_TEXT_CHARS ||
      !Array.isArray(value.recentContext) || value.recentContext.length > OWNER_CHAT_MAX_CONTEXT_MESSAGES) {
    return fail('INVALID_REQUEST')
  }

  if (!isRecord(value.authority) ||
      Object.keys(value.authority).some((key) => !AUTHORITY_KEYS.has(key)) ||
      value.authority.source !== 'LOCAL_UI_OWNER_CONFIGURATION' ||
      value.authority.requesterRole !== 'OWNER' ||
      value.authority.ownerConfigured !== true ||
      value.authority.scope !== 'OWNER_CHAT') {
    return fail('INVALID_AUTHORITY')
  }
  const ownerDisplayName = optionalDisplayName(value.authority.ownerDisplayName)
  const creatorDisplayName = optionalDisplayName(value.authority.creatorDisplayName)
  if (ownerDisplayName === undefined || creatorDisplayName === undefined) return fail('INVALID_AUTHORITY')

  let contextChars = 0
  const recentContext: OwnerChatRecentMessage[] = []
  for (const item of value.recentContext) {
    if (!isRecord(item) || Object.keys(item).some((key) => key !== 'role' && key !== 'text') ||
        (item.role !== 'user' && item.role !== 'assistant') ||
        typeof item.text !== 'string' || item.text.length > OWNER_CHAT_MAX_CONTEXT_CHARS) {
      return fail('INVALID_REQUEST')
    }
    contextChars += item.text.length
    if (contextChars > OWNER_CHAT_MAX_CONTEXT_CHARS) return fail('INVALID_REQUEST')
    recentContext.push({ role: item.role, text: item.text })
  }

  return {
    kind: OWNER_CHAT_REQUEST_KIND,
    requestId,
    request: {
      kind: OWNER_CHAT_REQUEST_KIND,
      requestId,
      conversationId: OWNER_CHAT_CONVERSATION_ID,
      timestamp: value.timestamp,
      authority: {
        source: 'LOCAL_UI_OWNER_CONFIGURATION',
        requesterRole: 'OWNER',
        ownerConfigured: true,
        scope: 'OWNER_CHAT',
        ownerDisplayName,
        creatorDisplayName,
      },
      text: value.text,
      recentContext,
      ...(Array.isArray(value.attachments) ? { attachments: [] } : {}),
    },
  }
}

function optionalDisplayName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  return typeof value === 'string' && value.length <= 128 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
