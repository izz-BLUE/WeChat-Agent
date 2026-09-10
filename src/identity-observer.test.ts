import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as observer from './identity-observer.js'
import {
  IDENTITY_OBSERVE_ENV,
  NONE_TOKEN,
  formatIdentityObservation,
  formatRequesterIdentity,
  identityToken,
  isIdentityObserveEnabled,
  observeIdentity,
  observeRawInbound,
  observeRequesterIdentity,
} from './identity-observer.js'
import {
  applyMentionPolicy,
  runRawAgentPipeline,
  toAgentRequest,
  type AgentExecutor,
  type AgentRequest,
} from './agent-adapter.js'
import { normalizeRawHookMessage, type RawHookMessage } from './message-contract.js'

const DIST_DIR = dirname(fileURLToPath(import.meta.url))

const SENTINEL_FROM = 'sentinel_room_9f31@chatroom'
const SENTINEL_WXID = 'wxid_sentinel_alpha_9f31'
const SENTINEL_SIGNATURE = 'signature_sentinel_beta_9f31'
const SENTINEL_CONTENT = 'CONTENT_SENTINEL_SHOULD_NEVER_BE_LOGGED'

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function raw(overrides: Partial<RawHookMessage> = {}): RawHookMessage {
  const from = overrides.from ?? SENTINEL_FROM
  const senderId = overrides.senderId ?? overrides.signature ?? SENTINEL_SIGNATURE
  return {
    msgId: 'observe-1',
    type: 1,
    timestamp: 1_757_000_000_000,
    from,
    wxid: SENTINEL_WXID,
    content: SENTINEL_CONTENT,
    signature: SENTINEL_SIGNATURE,
    senderName: 'Sender',
    isMentioned: true,
    ...overrides,
    conversationType: overrides.conversationType ?? 'GROUP',
    conversationId: overrides.conversationId ?? from,
    senderId,
    requesterId: overrides.requesterId ?? senderId,
    requesterSource: overrides.requesterSource ?? 'Signature',
    requesterRole: overrides.requesterRole ?? 'MEMBER',
    ownerConfigured: overrides.ownerConfigured ?? false,
  }
}

function validMessage(input: RawHookMessage) {
  const result = normalizeRawHookMessage(input)
  if (result.status !== 'VALID') {
    throw new Error(`expected a valid message, got ${result.status}`)
  }
  return result.message
}

class CapturingSink {
  public readonly lines: string[] = []

  public readonly sink = (line: string): void => {
    this.lines.push(line)
  }
}

class FakeAgent implements AgentExecutor {
  public readonly requests: AgentRequest[] = []

  public async complete(request: AgentRequest): Promise<string> {
    this.requests.push(request)
    return 'observed answer'
  }
}

async function withEnv<T>(value: string | undefined, body: () => T | Promise<T>): Promise<T> {
  const previous = process.env[IDENTITY_OBSERVE_ENV]
  if (value === undefined) {
    delete process.env[IDENTITY_OBSERVE_ENV]
  } else {
    process.env[IDENTITY_OBSERVE_ENV] = value
  }

  try {
    return await body()
  } finally {
    if (previous === undefined) {
      delete process.env[IDENTITY_OBSERVE_ENV]
    } else {
      process.env[IDENTITY_OBSERVE_ENV] = previous
    }
  }
}

async function sameInputSameToken(): Promise<void> {
  const token = identityToken(SENTINEL_WXID)
  assert(token === identityToken(SENTINEL_WXID), 'the same raw value produced a different token')
  assert(token === identityToken(`  ${SENTINEL_WXID}  `), 'a trimmed raw value produced a different token')
  assert(token !== NONE_TOKEN, 'a non-empty raw value produced the NONE token')
}

async function differentInputDifferentToken(): Promise<void> {
  const values = [SENTINEL_WXID, SENTINEL_SIGNATURE, SENTINEL_FROM, 'wxid_sentinel_gamma_9f31']
  const tokens = new Set(values.map((value) => identityToken(value)))
  assert(tokens.size === values.length, 'two distinct raw values collided on one token')
  assert(!tokens.has(NONE_TOKEN), 'a real raw value mapped to the NONE token')
}

async function noneAndEmptyAreExplicit(): Promise<void> {
  assert(identityToken('') === NONE_TOKEN, 'empty string did not map to NONE')
  assert(identityToken('   ') === NONE_TOKEN, 'blank string did not map to NONE')
  assert(identityToken(null) === NONE_TOKEN, 'null did not map to NONE')
  assert(identityToken(undefined) === NONE_TOKEN, 'undefined did not map to NONE')

  const empty = observeIdentity({ from: SENTINEL_FROM, wxid: '', signature: '' })
  assert(empty.wxidPresent === false && empty.signaturePresent === false, 'empty fields reported as present')
  assert(empty.wxidToken === NONE_TOKEN && empty.signatureToken === NONE_TOKEN, 'empty fields produced a real token')
  assert(empty.wxidEqualsSignature === false, 'two empty fields were reported as equal identities')

  const filled = observeIdentity({ from: SENTINEL_FROM, wxid: SENTINEL_WXID, signature: SENTINEL_WXID })
  assert(filled.wxidPresent === true && filled.signaturePresent === true, 'present fields reported as empty')
  assert(filled.wxidEqualsSignature === true, 'identical raw values were not reported as equal')
}

async function rawIdentityNeverLogged(): Promise<void> {
  const line = formatIdentityObservation(
    observeIdentity({ from: SENTINEL_FROM, wxid: SENTINEL_WXID, signature: SENTINEL_SIGNATURE }),
  )
  for (const sentinel of [SENTINEL_FROM, SENTINEL_WXID, SENTINEL_SIGNATURE]) {
    assert(!line.includes(sentinel), `raw identity value leaked into the observation line: ${sentinel}`)
  }
  assert(!/wxid_sentinel|signature_sentinel|sentinel_room/.test(line), 'raw identity shape leaked into the line')
  assert(line.includes(identityToken(SENTINEL_WXID)), 'the wxid token is missing from the observation line')
  assert(line.includes(identityToken(SENTINEL_SIGNATURE)), 'the signature token is missing from the line')
  assert(line.includes(identityToken(SENTINEL_FROM)), 'the from token is missing from the line')
}

async function contentNeverEntersObservation(): Promise<void> {
  const observation = observeIdentity({ from: SENTINEL_FROM, wxid: SENTINEL_WXID, signature: SENTINEL_SIGNATURE })
  const line = formatIdentityObservation(observation)
  assert(!line.includes(SENTINEL_CONTENT), 'message content leaked into the observation line')
  assert(!Object.keys(observation).some((key) => /content|text|message/i.test(key)), 'observation exposes a content field')
  const expectedFields = [
    'conversationType',
    'fromToken',
    'signatureLooksLikeWxid',
    'signaturePresent',
    'signatureToken',
    'wxidEqualsSignature',
    'wxidLooksLikeWxid',
    'wxidPresent',
    'wxidToken',
  ]
  assert(
    Object.keys(observation).sort().join(',') === expectedFields.join(','),
    `unexpected observation fields: ${Object.keys(observation).join(',')}`,
  )
  assert(line.split(' ').length === 10, `unexpected observation field count: ${line.split(' ').length}`)
  assert(line.startsWith('[IDENTITY_OBSERVE] '), 'unexpected observation log prefix')
}

async function normalizeResultUnchanged(): Promise<void> {
  const before = JSON.stringify(normalizeRawHookMessage(raw()))
  await withEnv('1', () => {
    const sink = new CapturingSink()
    const observation = observeRawInbound(raw(), sink.sink)
    assert(observation !== null, 'enabled observer returned no observation')
    assert(sink.lines.length === 1, `observer emitted ${sink.lines.length} lines`)
  })
  const after = JSON.stringify(normalizeRawHookMessage(raw()))
  assert(before === after, 'observation changed the normalization result')
}

async function mentionGateUnchanged(): Promise<void> {
  const mentioned = validMessage(raw({ isMentioned: true }))
  const notMentioned = validMessage(raw({ isMentioned: false }))
  const beforeMentioned = JSON.stringify(applyMentionPolicy(mentioned))
  const beforeNotMentioned = JSON.stringify(applyMentionPolicy(notMentioned))
  assert(JSON.parse(beforeMentioned).status === 'PROCESS', 'the mention sample is not admitted')
  assert(JSON.parse(beforeNotMentioned).status === 'IGNORED', 'the no-mention sample is not dropped')

  await withEnv('1', () => {
    observeRawInbound(raw({ isMentioned: true }), new CapturingSink().sink)
    observeRawInbound(raw({ isMentioned: false }), new CapturingSink().sink)
  })

  assert(
    beforeMentioned === JSON.stringify(applyMentionPolicy(mentioned)),
    'observation changed the mentioned admission decision',
  )
  assert(
    beforeNotMentioned === JSON.stringify(applyMentionPolicy(notMentioned)),
    'observation changed the no-mention drop decision',
  )
}

async function pipelineAndOutboundUnchanged(): Promise<void> {
  const baseline = await withEnv(undefined, () => runRawAgentPipeline(raw(), new FakeAgent()))
  const observed = await withEnv('1', () => runRawAgentPipeline(raw(), new FakeAgent()))
  assert(JSON.stringify(baseline) === JSON.stringify(observed), 'observation changed the pipeline result')
  if (baseline.status !== 'AGENT_RESULT') {
    throw new Error(`pipeline did not reach an agent result: ${baseline.status}`)
  }
  assert(baseline.agentResult.kind === 'SUCCESS_TEXT', 'agent result is not text')
  assert(baseline.outboundCommand?.conversationId === SENTINEL_FROM, 'the outbound conversation changed')
  assert(baseline.outboundCommand?.text === 'observed answer', 'the outbound text changed')
  assert(baseline.request.conversationId === SENTINEL_FROM, 'the request conversation changed')
  assert(baseline.request.senderId !== baseline.request.conversationId, 'sender and conversation collapsed')
  assert(baseline.request.requesterId === SENTINEL_SIGNATURE, 'the canonical requester identity changed')
  assert(baseline.request.requesterSource === 'Signature', 'the canonical requester source changed')
}

async function observerAddsNoIdentitySemantics(): Promise<void> {
  const surface = Object.keys(observer)
  assert(
    !surface.some((name) => /owner|memory|scope|permission/i.test(name)),
    `the observer surface gained owner/memory semantics: ${surface.join(',')}`,
  )

  // The formal requester log reports the wire decision and must never expose or
  // return a raw identity that the pipeline could consume as an identity.
  const requesterObservation = observeRequesterIdentity({
    conversationType: 'GROUP',
    source: 'Signature',
    senderId: SENTINEL_SIGNATURE,
    requesterId: SENTINEL_SIGNATURE,
    conversationId: SENTINEL_FROM,
  })
  assert(
    !Object.keys(requesterObservation).some((key) => /^(senderId|requesterId|conversationId|ownerId)$/.test(key)),
    `the requester observation exposes raw identity fields: ${Object.keys(requesterObservation).join(',')}`,
  )
  const requesterLine = formatRequesterIdentity(requesterObservation)
  for (const sentinel of [SENTINEL_FROM, SENTINEL_WXID, SENTINEL_SIGNATURE]) {
    assert(!requesterLine.includes(sentinel), `raw identity leaked into the requester log: ${sentinel}`)
  }

  const request = toAgentRequest(validMessage(raw()))
  assert(
    !Object.keys(request).some((key) => /memory|scope|permission/i.test(key)),
    `AgentRequest gained a memory/scope/permission field: ${Object.keys(request).join(',')}`,
  )
  // The owner decision is a trusted runtime fact, so only the role and the
  // configured flag may travel: never an owner identity value.
  assert(!Object.hasOwn(request, 'ownerId'), 'AgentRequest gained a raw owner identity field')
  assert(request.requesterRole === 'MEMBER', 'the trusted requester role is not carried')
  assert(request.ownerConfigured === false, 'the owner-configured fact is not carried')
  assert(request.requesterId === SENTINEL_SIGNATURE, 'the canonical requester identity is not carried')

  const adapterSource = readFileSync(join(DIST_DIR, 'agent-adapter.js'), 'utf8')
  const contractSource = readFileSync(join(DIST_DIR, 'message-contract.js'), 'utf8')
  assert(!adapterSource.includes('identity-observer'), 'agent-adapter imports the observer')
  assert(!contractSource.includes('identity-observer'), 'message-contract imports the observer')

  const transportSource = readFileSync(join(DIST_DIR, 'production-agent-transport.js'), 'utf8')
  const observeAt = transportSource.indexOf('observeRawInbound(')
  const pipelineAt = transportSource.indexOf('runRawAgentPipeline(')
  const requesterLogAt = transportSource.indexOf('logRequesterIdentity(')
  assert(observeAt >= 0, 'the transport does not call the observer')
  assert(requesterLogAt >= 0, 'the transport does not emit the requester identity log')
  assert(pipelineAt >= 0, 'the transport does not run the agent pipeline')
  assert(observeAt < pipelineAt, 'the observer does not run before normalization')
  assert(!transportSource.includes('= logRequesterIdentity('), 'the transport consumes the requester log result')
}

async function enabledDisabledIsExplicit(): Promise<void> {
  await withEnv(undefined, () => {
    assert(isIdentityObserveEnabled() === false, 'the observer is enabled by default')
    const sink = new CapturingSink()
    assert(observeRawInbound(raw(), sink.sink) === null, 'the disabled observer returned an observation')
    assert(sink.lines.length === 0, 'the disabled observer still logged')
  })

  await withEnv('1', () => {
    assert(isIdentityObserveEnabled() === true, 'WECHAT_IDENTITY_OBSERVE=1 did not enable the observer')
    const sink = new CapturingSink()
    const observation = observeRawInbound(raw(), sink.sink)
    assert(observation !== null, 'the enabled observer returned no observation')
    assert(sink.lines.length === 1, `the enabled observer logged ${sink.lines.length} lines`)
    assert(sink.lines[0].startsWith('[IDENTITY_OBSERVE] '), 'unexpected observation log prefix')
  })

  for (const value of ['0', 'true', 'yes', '']) {
    await withEnv(value, () => {
      assert(isIdentityObserveEnabled() === false, `WECHAT_IDENTITY_OBSERVE=${value} enabled the observer`)
    })
  }
}

const cases: Array<[string, () => Promise<void>]> = [
  ['same-input-same-token', sameInputSameToken],
  ['different-input-different-token', differentInputDifferentToken],
  ['none-and-empty-are-explicit', noneAndEmptyAreExplicit],
  ['raw-identity-never-logged', rawIdentityNeverLogged],
  ['content-never-enters-observation', contentNeverEntersObservation],
  ['normalize-result-unchanged', normalizeResultUnchanged],
  ['mention-gate-unchanged', mentionGateUnchanged],
  ['pipeline-and-outbound-unchanged', pipelineAndOutboundUnchanged],
  ['observer-adds-no-identity-semantics', observerAddsNoIdentitySemantics],
  ['enabled-disabled-is-explicit', enabledDisabledIsExplicit],
]

let failures = 0
for (const [name, testCase] of cases) {
  try {
    await testCase()
    console.log(`[IDENTITY_OBSERVER_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.error(
      `[IDENTITY_OBSERVER_CASE] name=${name} result=FAIL message=${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

console.log(`[IDENTITY_OBSERVER_TEST_SUMMARY] cases=${cases.length} failures=${failures}`)
if (failures > 0) {
  process.exitCode = 1
}