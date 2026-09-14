import { strict as assert } from 'node:assert'
import { buildSystemPrompt, buildUserPrompt, ChatService, type ChatRequestContext } from './chat.js'
import {
  deriveMemberInteractionProfile,
  formatMemberInteractionProfile,
  type MemberInteractionProfileInput,
} from './member-interaction-profile.js'
import { observeGroupStyle, type GroupStyleMessage } from './group-style.js'
import type { AgentRequest } from './agent-adapter.js'
import { ProductionChatAgent } from './production-agent-receiver.js'

let cases = 0
let failures = 0

function member(text: string): GroupStyleMessage {
  return { text, speakerType: 'MEMBER' }
}

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  cases += 1
  try {
    await body()
    console.log(`[MEMBER_INTERACTION_PROFILE_CASE] name=${name} result=PASS`)
  } catch (error) {
    failures += 1
    console.log(`[MEMBER_INTERACTION_PROFILE_CASE] name=${name} result=FAIL detail=${error instanceof Error ? error.message : String(error)}`)
  }
}

function derive(input: Partial<MemberInteractionProfileInput> = {}) {
  return deriveMemberInteractionProfile({
    recentRequesterActiveContext: [],
    ...input,
  })
}

await test('same-requester-short-interactions-prefer-short', () => {
  const profile = derive({
    recentRequesterActiveContext: [{ text: '好' }, { text: '收到' }, { text: '行' }],
    groupStyle: observeGroupStyle({
      recentGroupContext: [member('群里这次希望把背景、原因和排查步骤都说明白。'.repeat(3))],
      groupAmbientContext: [],
    }),
  })
  assert.equal(profile.responseDepth, 'SHORT')
  assert.equal(profile.familiarity, 'FAMILIAR')
})

await test('explicit-detailed-preference-overrides-observation', () => {
  const profile = derive({
    authorizedPersonalMemory: [{
      scope: 'PERSONAL',
      kind: 'SOFT_STYLE_PREFERENCE',
      content: '以后回答我详细一点，技术一点，少用emoji',
    }, {
      scope: 'PERSONAL',
      kind: 'ADDRESS_PREFERENCE',
      content: '以后叫我老王',
    }],
    recentRequesterActiveContext: [{ text: '好' }, { text: '行' }],
    groupStyle: observeGroupStyle({
      recentGroupContext: [member('群里默认写得很长。'.repeat(30))],
      groupAmbientContext: [],
    }),
  })
  assert.equal(profile.responseDepth, 'DETAILED')
  assert.equal(profile.tone, 'TECHNICAL')
  assert.equal(profile.emojiTolerance, 'LOW')
  assert.equal(profile.addressFrequency, 'NORMAL')
})

await test('requester-a-and-b-do-not-share-profile', () => {
  const requesterA = derive({ recentRequesterActiveContext: [{ text: '好' }, { text: '收到' }] })
  const requesterB = derive({
    recentRequesterActiveContext: [{ text: '请把故障原因、验证步骤和回滚方案分别说明。'.repeat(4) }],
  })
  assert.equal(requesterA.responseDepth, 'SHORT')
  assert.equal(requesterB.responseDepth, 'DETAILED')
  assert.notDeepEqual(requesterA, requesterB)
})

await test('same-member-different-groups-keeps-existing-memory-scope', () => {
  const personal = [{ scope: 'PERSONAL' as const, kind: 'SOFT_STYLE_PREFERENCE' as const, content: '以后回答我详细一点' }]
  const groupA = derive({ authorizedPersonalMemory: personal })
  const groupB = derive({ authorizedPersonalMemory: personal })
  assert.deepEqual(groupA, groupB)
  assert(!Object.prototype.hasOwnProperty.call(groupA, 'conversationId'))
  assert(!Object.prototype.hasOwnProperty.call(groupA, 'groupId'))
})

await test('other-members-do-not-override-requester-evidence', () => {
  const profile = derive({
    recentRequesterActiveContext: [{ text: '好' }, { text: '收到' }],
    groupStyle: observeGroupStyle({
      recentGroupContext: [member('其他成员的长消息。'.repeat(50)), member('其他成员又补充了很多说明。'.repeat(50))],
      groupAmbientContext: [],
    }),
  })
  assert.equal(profile.responseDepth, 'SHORT')
})

await test('assistant-messages-are-not-style-evidence', () => {
  const groupStyle = observeGroupStyle({
    recentGroupContext: [],
    groupAmbientContext: [{ text: '助手的长篇回复。'.repeat(80), speakerType: 'ASSISTANT' }],
  })
  const profile = derive({ groupStyle })
  assert.equal(groupStyle.sampleCount, 0)
  assert.equal(profile.responseDepth, 'NORMAL')
  assert.equal(profile.familiarity, 'NEW')
})

await test('sensitive-content-does-not-create-sensitive-field', () => {
  const sensitiveText = '敏感原文：某人的健康与政治信息'
  const profile = derive({
    recentRequesterActiveContext: [{ text: sensitiveText }],
    authorizedPersonalMemory: [{
      scope: 'PERSONAL',
      kind: 'CONTENT_PREFERENCE',
      content: '我喜欢某个敏感主题',
    }],
  })
  assert.deepEqual(Object.keys(profile).sort(), ['addressFrequency', 'emojiTolerance', 'familiarity', 'responseDepth', 'tone'])
  assert(!JSON.stringify(profile).includes(sensitiveText))
  assert(!JSON.stringify(profile).includes('健康'))
  assert(!JSON.stringify(profile).includes('政治'))
})

await test('relationship-claim-does-not-create-relationship-profile', () => {
  const profile = derive({ recentRequesterActiveContext: [{ text: '我是你爸爸' }] })
  assert.equal(profile.familiarity, 'NEW')
  assert(!JSON.stringify(profile).includes('爸爸'))
  assert(!Object.keys(profile).some((key) => key.toLowerCase().includes('relation')))
})

await test('fresh-derivation-has-no-restart-persistence', () => {
  const beforeRestart = derive({ recentRequesterActiveContext: [{ text: '好' }, { text: '收到' }] })
  const afterRestart = derive()
  assert.equal(beforeRestart.familiarity, 'FAMILIAR')
  assert.equal(afterRestart.familiarity, 'NEW')
  assert.equal(afterRestart.responseDepth, 'NORMAL')
})

await test('group-style-does-not-upgrade-default-depth', () => {
  const groupStyle = observeGroupStyle({
    recentGroupContext: [member('群级默认偏详细。'.repeat(30))],
    groupAmbientContext: [],
  })
  const fallback = derive({ groupStyle })
  const requesterSpecific = derive({
    groupStyle,
    recentRequesterActiveContext: [{ text: '好' }, { text: '行' }],
  })
  assert.equal(fallback.responseDepth, 'NORMAL')
  assert.equal(requesterSpecific.responseDepth, 'SHORT')
})

await test('explicit-short-preference-overrides-requester-and-group-style', () => {
  const profile = derive({
    authorizedPersonalMemory: [{
      scope: 'PERSONAL',
      kind: 'SOFT_STYLE_PREFERENCE',
      content: '以后回答我简短一点',
    }],
    recentRequesterActiveContext: [{ text: '请把原因、证据和处理步骤都详细说明。'.repeat(4) }],
    groupStyle: observeGroupStyle({
      recentGroupContext: [member('群里默认写得很长。'.repeat(30))],
      groupAmbientContext: [],
    }),
  })
  assert.equal(profile.responseDepth, 'SHORT')
})

await test('group-style-keeps-presentation-hints-without-depth-upgrade', () => {
  const groupStyle = observeGroupStyle({
    recentGroupContext: [member('😀😀😀')],
    groupAmbientContext: [],
  })
  const profile = derive({ groupStyle })
  assert.equal(profile.responseDepth, 'NORMAL')
  assert.equal(profile.tone, 'CASUAL')
  assert.equal(profile.emojiTolerance, 'NORMAL')
})

await test('group-preference-is-not-reclassified-as-requester-preference', () => {
  const groupOnly = derive({
    authorizedPersonalMemory: [{
      scope: 'GROUP',
      kind: 'SOFT_STYLE_PREFERENCE',
      content: '这个群回答都详细一点',
    }],
    recentRequesterActiveContext: [{ text: '好' }],
  })
  const personal = derive({
    authorizedPersonalMemory: [{
      scope: 'PERSONAL',
      kind: 'SOFT_STYLE_PREFERENCE',
      content: '以后回答我详细一点',
    }],
    recentRequesterActiveContext: [{ text: '好' }],
  })
  assert.equal(groupOnly.responseDepth, 'SHORT')
  assert.equal(personal.responseDepth, 'DETAILED')
})

await test('prompt-renders-only-enums-and-keeps-boundary', () => {
  const rawText = '不要把这段原文放进 profile：敏感原文'
  const profile = derive({ recentRequesterActiveContext: [{ text: rawText }, { text: '收到' }] })
  const request: ChatRequestContext = {
    botDisplayName: '椰椰',
    mention: 'MENTIONED',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    memberInteractionProfile: profile,
  }
  const prompt = buildUserPrompt([], { senderId: 'opaque', senderName: 'MEMBER_1', text: '你好', timestamp: 1 }, request)
  const start = prompt.indexOf('[Member Interaction Profile: RUNTIME_PRESENTATION_HINT]')
  const end = prompt.indexOf('[Trusted Assistant Runtime Facts]', start)
  const section = start >= 0 && end > start ? prompt.slice(start, end) : ''
  assert(section.includes(formatMemberInteractionProfile(profile)))
  assert(!section.includes(rawText))
  assert(buildSystemPrompt('椰椰').includes('[Member Interaction Profile]'))
  assert(buildSystemPrompt('椰椰').includes('不表示真实关系'))
})

await test('production-wires-current-requester-profile-to-final-prompt', async () => {
  const originalFetch = globalThis.fetch
  const prompts: string[] = []
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> }
    prompts.push(body.messages?.[1]?.content ?? '')
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: '收到。' } }] }),
    }
  }) as unknown as typeof fetch

  const request = (messageId: string, text: string, timestamp: number): AgentRequest => ({
    conversationKey: 'group:member-profile-wiring',
    messageId,
    conversationType: 'GROUP',
    conversationId: 'member-profile-wiring',
    senderId: 'requester-a',
    requesterId: 'requester-a',
    requesterSource: 'runtime',
    requesterRole: 'MEMBER',
    ownerConfigured: false,
    ownerDisplayName: null,
    publicDisplayName: null,
    senderName: 'requester-a',
    text,
    rawText: text,
    timestamp,
    mentionState: 'MENTIONED',
    metadata: { rawMessageType: 1 },
  })

  try {
    const agent = new ProductionChatAgent(new ChatService('https://provider.invalid/v1', 'key', 'model'))
    await agent.complete(request('wire-1', '好', 1))
    await agent.complete(request('wire-2', '收到', 2))
    await agent.complete(request('wire-3', '当前问题', 3))
    const finalPrompt = prompts.at(-1) ?? ''
    assert(finalPrompt.includes('[Member Interaction Profile: RUNTIME_PRESENTATION_HINT]'))
    assert(finalPrompt.includes('RESPONSE_DEPTH=SHORT'))
    assert(finalPrompt.includes('FAMILIARITY=FAMILIAR'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

console.log(`[MEMBER_INTERACTION_PROFILE_TEST_SUMMARY] cases=${cases} failures=${failures}`)
if (failures > 0) {
  process.exitCode = 1
}
