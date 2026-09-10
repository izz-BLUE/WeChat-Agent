// Unit tests for the Agent-side persistent log + cross-process token correlation.
//
// Goal (P1 PRODUCTION_OBSERVABILITY_PERSISTENT_LOGGING +
//       P1 PERSISTENT_LOGGING_SOURCE_AND_CORRELATION_CONVERGENCE):
//
//   1. Same salt + same raw identity      → same token.
//   2. Same salt + different raw identity → different tokens.
//   3. Different salt + same raw identity → different tokens.
//   4. Missing salt                        → mode=PROCESS_LOCAL.
//   5. Shared salt                         → mode=SHARED.
//   6. Salt value never appears in any log.
//   7. Raw requesterId never appears in any structured field.
//   8. Raw conversationId never appears in any structured field.
//   9. Raw message content never appears in any structured field.
//  10. The token algorithm matches the C# UI contract byte for byte.

import { readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  PersistentRuntimeLog,
  PersistentRuntimeLogSink,
  resolveTokenCorrelationState,
} from './persistent-runtime-log.js'
import {
  identityToken,
  setProcessSaltOverride,
  tokenCorrelationMode,
  TOKEN_SALT_ENV,
} from './identity-observer.js'

let pass = 0
let fail = 0
const failures: string[] = []

function assert(name: string, ok: boolean, detail: string = ''): void {
  if (ok) {
    pass++
  } else {
    fail++
    failures.push(`${name}${detail.length > 0 ? ` (${detail})` : ''}`)
  }
}

function newTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  rmSync(dir, { recursive: true, force: true })
  return dir
}

function readdirSyncLike(directory: string, baseName: string): string[] {
  if (!existsSync(directory)) {
    return []
  }
  return readdirSync(directory)
    .filter((name) => name.startsWith(`${baseName}-`) && name.endsWith('.log'))
    .map((name) => join(directory, name))
    .sort()
}

function readLines(directory: string, baseName: string): string[] {
  return readdirSyncLike(directory, baseName)
    .flatMap((path) => readFileSync(path, 'utf8').split('\n'))
    .filter((line) => line.length > 0)
}

const SHARED_SALT = 'a'.repeat(32)
const OTHER_SALT = 'b'.repeat(32)

// Snapshot and restore every env var this suite touches, so the harness stays
// hermetic no matter which other tests ran first.
const ENV_KEYS = [TOKEN_SALT_ENV, 'WECHAT_LOG_PATH'] as const
const savedEnv = new Map<string, string | undefined>()
for (const key of ENV_KEYS) {
  savedEnv.set(key, process.env[key])
}
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

try {
  // Case 4 + 5: the mode is the gating decision for the whole feature.
  setProcessSaltOverride(null)
  setEnv(TOKEN_SALT_ENV, undefined)
  const stateMissing = resolveTokenCorrelationState(process.env)
  assert(
    'missing salt → mode=PROCESS_LOCAL',
    stateMissing.mode === 'PROCESS_LOCAL' && stateMissing.sharedSalt === false,
    `mode=${stateMissing.mode}`,
  )

  setEnv(TOKEN_SALT_ENV, SHARED_SALT)
  const stateShared = resolveTokenCorrelationState(process.env)
  assert(
    'shared salt → mode=SHARED',
    stateShared.mode === 'SHARED' && stateShared.sharedSalt === true,
    `mode=${stateShared.mode}`,
  )

  // Case 1: same salt + same raw identity → same token, across two logger
  // instances (this is the cross-process property: the salt is the only shared
  // input, so two processes with the same salt agree).
  setEnv(TOKEN_SALT_ENV, SHARED_SALT)
  const log1 = new PersistentRuntimeLog({ fileBaseName: 'agent-c1', directory: newTempDir('agent-c1') })
  const log2 = new PersistentRuntimeLog({ fileBaseName: 'agent-c2', directory: newTempDir('agent-c2') })
  const tokenA1 = log1.tokenFor('requester-id-A')
  const tokenA2 = log2.tokenFor('requester-id-A')
  assert('same salt + same requester → identical token', tokenA1 === tokenA2, `${tokenA1} != ${tokenA2}`)

  // Case 2: same salt + different raw identity → different tokens.
  const tokenB1 = log1.tokenFor('requester-id-B')
  assert('same salt + different requester → different tokens', tokenA1 !== tokenB1, `${tokenA1} == ${tokenB1}`)

  // Case 3: a different salt must produce a different token for the same raw
  // identity. Without this, a process-local run could be mistaken for a
  // correlated run.
  setEnv(TOKEN_SALT_ENV, OTHER_SALT)
  const otherLog = new PersistentRuntimeLog({ fileBaseName: 'agent-c3', directory: newTempDir('agent-c3') })
  const tokenOther = otherLog.tokenFor('requester-id-A')
  assert(
    'different salt + same requester → different tokens',
    tokenOther !== tokenA1,
    `${tokenOther} == ${tokenA1}`,
  )

  // Case 10: cross-language contract. The C# UI's `IdentityTokens.Token`
  // implements exactly this HMAC-SHA256/12-upper-hex contract; the frozen
  // values below are asserted from the C# side too
  // (PersistentRuntimeLogTests.TryCrossLanguageTokenContractMatchesNode), so a
  // divergence on either side fails a gate instead of silently breaking
  // correlation in the field.
  setProcessSaltOverride(SHARED_SALT)
  assert(
    'cross-language: requester token matches the C# contract',
    identityToken('cross-process-requester-1') === '3D72EE0387FA',
    `got ${identityToken('cross-process-requester-1')}`,
  )
  assert(
    'cross-language: conversation token matches the C# contract',
    identityToken('cross-process-conversation-1') === 'E845779B40C4',
    `got ${identityToken('cross-process-conversation-1')}`,
  )
  assert(
    'cross-language: message id token matches the C# contract',
    identityToken('1234567890') === 'B63A86C93AB6',
    `got ${identityToken('1234567890')}`,
  )
  assert(
    'short id is a prefix of the same token, not a second hash',
    log1.shortIdFor('1234567890', 6) === identityToken('1234567890').slice(0, 6) &&
      log1.shortIdFor('1234567890', 6) === 'B63A86',
    `got ${log1.shortIdFor('1234567890', 6)}`,
  )
  assert('mode reports SHARED while the override is pinned', tokenCorrelationMode(process.env) === 'SHARED')
  setProcessSaltOverride(null)

  // Case 6: salt content never appears in any log line.
  setEnv(TOKEN_SALT_ENV, SHARED_SALT)
  const saltDir = newTempDir('agent-c6')
  const saltLog = new PersistentRuntimeLog({ fileBaseName: 'agent-c6', directory: saltDir })
  const saltSink = new PersistentRuntimeLogSink(saltLog, 'agent-transport')
  saltSink.writeStructured(
    'RECEIVER_LIFECYCLE',
    { result: 'STARTED', phase: 'boot', pid: process.pid },
    'pipeName=WeChat-Agent-Production mode=real',
  )
  saltLog.write('agent-receiver', 'TOKEN_CORRELATION', {
    mode: saltLog.correlationState.mode,
    saltBytes: saltLog.correlationState.saltBytes,
  })
  saltLog.flush()
  const saltText = readLines(saltDir, 'agent-c6').join('\n')
  assert('salt content never appears in any log line', !saltText.includes(SHARED_SALT))
  assert(
    'TOKEN_CORRELATION records mode and length only',
    /TOKEN_CORRELATION/.test(saltText) &&
      saltText.includes('mode=SHARED') &&
      saltText.includes(`saltBytes=${Buffer.byteLength(SHARED_SALT, 'utf8')}`) &&
      !saltText.includes(SHARED_SALT),
  )

  // Case 7 + 8 + 9: raw requesterId / conversationId / message content never
  // appear in a structured field. The opaque tail is caller-controlled, so the
  // assertion is scoped to everything before the tail marker.
  const privDir = newTempDir('agent-c789')
  const privLog = new PersistentRuntimeLog({ fileBaseName: 'agent-c789', directory: privDir })
  const privSink = new PersistentRuntimeLogSink(privLog, 'agent-transport')
  const rawRequesterId = 'raw-requester-DO-NOT-LOG-C789'
  const rawConversationId = 'raw-conversation-DO-NOT-LOG-C789'
  const rawMessageBody = 'raw-message-body-DO-NOT-LOG-C789-secret'
  privSink.writeStructured(
    'INBOUND_DISPATCHED',
    {
      requesterToken: privLog.tokenFor(rawRequesterId),
      conversationToken: privLog.tokenFor(rawConversationId),
      msgIdToken: privLog.shortIdFor('msgid-raw-c789'),
      result: 'OUTBOUND_COMMAND',
      phase: 'pipeline',
    },
    'status=AGENT_RESULT',
  )
  privLog.flush()
  const structuredLine = readLines(privDir, 'agent-c789').find((line) => line.includes('INBOUND_DISPATCHED')) ?? ''
  const beforeTail = structuredLine.includes('|detail=')
    ? structuredLine.slice(0, structuredLine.indexOf('|detail='))
    : structuredLine
  assert(
    'raw requester id never appears in a structured field',
    beforeTail.length > 0 && !beforeTail.includes(rawRequesterId),
    `line=${structuredLine}`,
  )
  assert(
    'raw conversation id never appears in a structured field',
    beforeTail.length > 0 && !beforeTail.includes(rawConversationId),
  )
  assert(
    'raw message body never appears in a structured field',
    beforeTail.length > 0 && !beforeTail.includes(rawMessageBody),
  )
  assert(
    'structured line carries the correlated tokens',
    beforeTail.includes(`requesterToken=${privLog.tokenFor(rawRequesterId)}`) &&
      beforeTail.includes(`conversationToken=${privLog.tokenFor(rawConversationId)}`),
    `line=${structuredLine}`,
  )

  // Rotation / retention are exercised by the C# suite; here we only prove the
  // Agent side still writes a durable line after the rebuild.
  const cleanDir = newTempDir('agent-c10')
  const cleanLog = new PersistentRuntimeLog({ fileBaseName: 'agent-clean', directory: cleanDir })
  cleanLog.write('agent-receiver', 'PROCESS_LIFECYCLE', { result: 'STARTED', phase: 'boot' })
  cleanLog.flush()
  cleanLog.dispose()
  const cleanText = readLines(cleanDir, 'agent-clean').join('\n')
  assert(
    'clean rebuild: log line lands on disk',
    cleanText.includes('PROCESS_LIFECYCLE') && cleanText.includes('phase=boot'),
  )
} finally {
  for (const [key, value] of savedEnv) {
    setEnv(key, value)
  }
  setProcessSaltOverride(null)
}

if (fail > 0) {
  for (const name of failures) {
    console.error(`[CASE] ${name}: FAIL`)
  }
  console.error(`[SUITE] name=PersistentRuntimeLog cases=${pass + fail} failed=${fail} result=FAIL`)
  process.exit(1)
}
console.log(`[SUITE] name=PersistentRuntimeLog cases=${pass + fail} failed=0 result=PASS`)
