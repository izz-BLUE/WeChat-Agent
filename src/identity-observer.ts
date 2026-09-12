import { createHmac, randomBytes } from 'node:crypto'
import { DIRECT_OWNER_FIELD_VERIFIED } from './message-contract.js'

/**
 * Observation-only identity probe.
 *
 * The real-world semantics of the raw `wxid` and `signature` wire fields are
 * still unverified: two generations of this project read the same Weixin
 * message offsets with opposite conclusions, so the canonical requester
 * identity cannot be chosen from code alone. This module therefore observes the
 * raw inbound fields without interpreting them and emits only irreversible
 * tokens plus boolean shape facts, so one field experiment can compare
 * A/A/B/cross-group without ever exposing an identity value.
 *
 * It never normalizes, never derives a requester identity, never persists
 * state, and never affects the pipeline result.
 */

export const IDENTITY_OBSERVE_ENV = 'WECHAT_IDENTITY_OBSERVE'

/** Token emitted when the raw value is empty, so "no identity" is explicit. */
export const NONE_TOKEN = 'NONE'

const TOKEN_PREFIX_LENGTH = 12
const WXID_SHAPE = /^wxid_[0-9A-Za-z_-]+$/

/**
 * Process-lifetime salt: the same raw value maps to the same token inside one
 * Agent process, different values stay distinguishable, and the mapping cannot
 * be reversed or carried into another run. The salt is never logged.
 *
 * The salt is configurable through `WECHAT_LOG_TOKEN_SALT` so the Agent and the
 * C# UI can produce byte-identical tokens for the same raw identity. That is
 * the only supported way to correlate a token across the two logs; without the
 * env var each process keeps its own random salt and the tokens are strictly
 * process-local.
 */
export const TOKEN_SALT_ENV = 'WECHAT_LOG_TOKEN_SALT'

/** Minimum payload length accepted from the env var; shorter values are ignored. */
export const SHARED_SALT_MIN_BYTES = 16

const FALLBACK_SALT = randomBytes(32)

let saltOverride: Buffer | null = null

function configuredSalt(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const configured = env[TOKEN_SALT_ENV]
  if (typeof configured === 'string' && configured.length > 0 &&
      Buffer.byteLength(configured, 'utf8') >= SHARED_SALT_MIN_BYTES) {
    return Buffer.from(configured, 'utf8')
  }
  return null
}

/**
 * The salt every token in this process is derived from, in resolution order:
 * an explicit test/hot-path override, then `WECHAT_LOG_TOKEN_SALT`, then the
 * process-lifetime random salt.
 */
function processSalt(): Buffer {
  return saltOverride ?? configuredSalt() ?? FALLBACK_SALT
}

/**
 * Pin the process salt explicitly (tests, or a caller that already resolved
 * the value). Pass `null` to fall back to the env var / random salt. The value
 * must never be logged.
 */
export function setProcessSaltOverride(salt: string | null): void {
  saltOverride = typeof salt === 'string' && salt.length > 0
    ? Buffer.from(salt, 'utf8')
    : null
}

/**
 * Cross-process token correlation mode. `SHARED` means both processes loaded
 * the same `WECHAT_LOG_TOKEN_SALT` and a token matches across the two logs;
 * `PROCESS_LOCAL` means each side generated its own random salt, so a token
 * MUST NOT be read as cross-process correlated (the privacy contract still
 * holds either way).
 */
export type TokenCorrelationMode = 'SHARED' | 'PROCESS_LOCAL'

export function tokenCorrelationMode(env: NodeJS.ProcessEnv = process.env): TokenCorrelationMode {
  return configuredSalt(env) !== null ? 'SHARED' : 'PROCESS_LOCAL'
}

/** Salt length in bytes. Reported at boot; the salt itself is never logged. */
export function tokenSaltByteLength(env: NodeJS.ProcessEnv = process.env): number {
  return (configuredSalt(env) ?? FALLBACK_SALT).length
}

export type IdentityObserveSink = (line: string) => void

export interface RawIdentityFields {
  from: string
  wxid: string
  signature: string
}

export interface IdentityObservation {
  conversationType: 'GROUP' | 'DIRECT'
  fromToken: string
  wxidToken: string
  signatureToken: string
  wxidPresent: boolean
  signaturePresent: boolean
  wxidLooksLikeWxid: boolean
  signatureLooksLikeWxid: boolean
  wxidEqualsSignature: boolean
}

export function isIdentityObserveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[IDENTITY_OBSERVE_ENV] === '1'
}

function rawValue(input: string | null | undefined): string {
  return typeof input === 'string' ? input.trim() : ''
}

/**
 * Irreversible token for one raw identity value. Never the value itself.
 *
 * HMAC-SHA256 over the process salt, first 12 hex chars, upper case. This is
 * the single tokenization rule in the system: the C# UI's
 * `IdentityTokens.Token` implements exactly the same contract, so with a
 * shared `WECHAT_LOG_TOKEN_SALT` a token matches across the two logs.
 */
export function identityToken(input: string | null | undefined): string {
  const raw = rawValue(input)
  if (!raw) {
    return NONE_TOKEN
  }

  return createHmac('sha256', processSalt())
    .update(raw, 'utf8')
    .digest('hex')
    .slice(0, TOKEN_PREFIX_LENGTH)
    .toUpperCase()
}

export function looksLikeWxid(input: string | null | undefined): boolean {
  return WXID_SHAPE.test(rawValue(input))
}

export function observeIdentity(raw: RawIdentityFields): IdentityObservation {
  const wxid = rawValue(raw.wxid)
  const signature = rawValue(raw.signature)

  return {
    conversationType: rawValue(raw.from).endsWith('@chatroom') ? 'GROUP' : 'DIRECT',
    fromToken: identityToken(raw.from),
    wxidToken: identityToken(wxid),
    signatureToken: identityToken(signature),
    wxidPresent: wxid.length > 0,
    signaturePresent: signature.length > 0,
    wxidLooksLikeWxid: looksLikeWxid(wxid),
    signatureLooksLikeWxid: looksLikeWxid(signature),
    wxidEqualsSignature: wxid.length > 0 && wxid === signature,
  }
}

export function formatIdentityObservation(observation: IdentityObservation): string {
  return (
    '[IDENTITY_OBSERVE]' +
    ` conversationType=${observation.conversationType}` +
    ` fromToken=${observation.fromToken}` +
    ` wxidToken=${observation.wxidToken}` +
    ` signatureToken=${observation.signatureToken}` +
    ` wxidPresent=${observation.wxidPresent}` +
    ` signaturePresent=${observation.signaturePresent}` +
    ` wxidLooksLikeWxid=${observation.wxidLooksLikeWxid}` +
    ` signatureLooksLikeWxid=${observation.signatureLooksLikeWxid}` +
    ` wxidEqualsSignature=${observation.wxidEqualsSignature}`
  )
}

/**
 * Observe one raw inbound envelope. Returns null and emits nothing unless
 * `WECHAT_IDENTITY_OBSERVE=1`. The observation is derived from the raw wire
 * fields only; the pipeline continues with the untouched envelope.
 */
export function observeRawInbound(
  raw: RawIdentityFields,
  sink: IdentityObserveSink = console.log,
): IdentityObservation | null {
  if (!isIdentityObserveEnabled()) {
    return null
  }

  const observation = observeIdentity(raw)
  sink(formatIdentityObservation(observation))
  return observation
}

/**
 * Canonical requester identity as decided by the runtime and carried on the wire.
 * These values are only ever tokenized; the raw identity never reaches a log.
 */
export interface RequesterIdentityFields {
  conversationType: string
  source: string
  senderId: string
  requesterId: string
  conversationId: string
}

export interface RequesterIdentityObservation {
  conversationType: string
  source: string
  senderToken: string
  requesterToken: string
  conversationToken: string
  senderRequesterMatch: boolean
  conversationRequesterSeparated: boolean
  result: 'PASS' | 'FAIL' | 'UNVERIFIED'
}

/**
 * Formal requester identity diagnostic. It reports whether the wire identity is
 * internally consistent; it never decides identity and never logs a raw value.
 * Ordinary DIRECT stays explicitly UNVERIFIED; the additive verified owner source
 * is the only DIRECT shape that can report PASS.
 */
export function observeRequesterIdentity(fields: RequesterIdentityFields): RequesterIdentityObservation {
  const source = rawValue(fields.source) || 'UNKNOWN'
  const senderId = rawValue(fields.senderId)
  const requesterId = rawValue(fields.requesterId)
  const conversationId = rawValue(fields.conversationId)
  const conversationType = rawValue(fields.conversationType) || 'UNKNOWN'

  const senderRequesterMatch = senderId.length > 0 && senderId === requesterId
  const conversationRequesterSeparated = conversationId.length > 0 && conversationId !== requesterId

  let result: RequesterIdentityObservation['result']
  if (conversationType === 'GROUP') {
    result = senderRequesterMatch && conversationRequesterSeparated ? 'PASS' : 'FAIL'
  } else if (conversationType === 'DIRECT' &&
             source === DIRECT_OWNER_FIELD_VERIFIED &&
             senderRequesterMatch && conversationRequesterSeparated) {
    result = 'PASS'
  } else {
    result = 'UNVERIFIED'
  }

  return {
    conversationType,
    source,
    senderToken: identityToken(senderId),
    requesterToken: identityToken(requesterId),
    conversationToken: identityToken(conversationId),
    senderRequesterMatch,
    conversationRequesterSeparated,
    result,
  }
}

export function formatRequesterIdentity(observation: RequesterIdentityObservation): string {
  return (
    '[REQUESTER_IDENTITY]' +
    ` conversationType=${observation.conversationType}` +
    ` source=${observation.source}` +
    ` senderToken=${observation.senderToken}` +
    ` requesterToken=${observation.requesterToken}` +
    ` conversationToken=${observation.conversationToken}` +
    ` senderRequesterMatch=${observation.senderRequesterMatch}` +
    ` conversationRequesterSeparated=${observation.conversationRequesterSeparated}` +
    ` result=${observation.result}`
  )
}

/** Always-on formal requester diagnostic; contains tokens and booleans only. */
export function logRequesterIdentity(
  fields: RequesterIdentityFields,
  sink: IdentityObserveSink = console.log,
): RequesterIdentityObservation {
  const observation = observeRequesterIdentity(fields)
  sink(formatRequesterIdentity(observation))
  return observation
}
