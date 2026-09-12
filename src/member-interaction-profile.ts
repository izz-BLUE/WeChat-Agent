/**
 * Deterministic, transient presentation hints for the current requester.
 *
 * This is deliberately not a person profile. The input is the already-authorized
 * personal-memory view plus the already-split recent requester turns; the output
 * contains only bounded presentation enums and never retains their text.
 */
import type { ChatPromptMessage, MemoryPromptItem } from './chat.js'
import {
  observeGroupStyle,
  type GroupStyleMessageLength,
  type GroupStyleProfile,
} from './group-style.js'

export type MemberResponseDepth = 'SHORT' | 'NORMAL' | 'DETAILED'
export type MemberInteractionTone = 'CASUAL' | 'NEUTRAL' | 'TECHNICAL'
export type MemberEmojiTolerance = 'LOW' | 'NORMAL'
export type MemberAddressFrequency = 'LOW' | 'NORMAL'
export type MemberInteractionFamiliarity = 'NEW' | 'FAMILIAR'

export interface MemberInteractionProfile {
  responseDepth: MemberResponseDepth
  tone: MemberInteractionTone
  emojiTolerance: MemberEmojiTolerance
  addressFrequency: MemberAddressFrequency
  familiarity: MemberInteractionFamiliarity
}

export interface MemberInteractionProfileInput {
  /** Already-authorized PERSONAL items for the current requester only. */
  authorizedPersonalMemory?: readonly MemoryPromptItem[]
  /** Already split active turns authored by the current requester. */
  recentRequesterActiveContext: readonly Pick<ChatPromptMessage, 'text'>[]
  /** Group-wide style is only a fallback when requester evidence is absent. */
  groupStyle?: GroupStyleProfile
}

const DEFAULT_PROFILE: MemberInteractionProfile = Object.freeze({
  responseDepth: 'NORMAL',
  tone: 'NEUTRAL',
  emojiTolerance: 'LOW',
  addressFrequency: 'LOW',
  familiarity: 'NEW',
})

const SHORT_PREFERENCE = /(?:简短|简洁|精简|短一点|短些|别太长|不要太长|少一点|一句话)/u
const DETAILED_PREFERENCE = /(?:详细|展开|多讲|长一点|多一点|步骤|解释清楚)/u
const CASUAL_PREFERENCE = /(?:口语|随意|轻松|聊天一点|自然一点)/u
const TECHNICAL_PREFERENCE = /(?:技术|专业|术语|原理|代码细节)/u
const LOW_EMOJI_PREFERENCE = /(?:少用|不用|别用|不要|不使用).*?(?:emoji|表情|颜文字)/iu
const NORMAL_EMOJI_PREFERENCE = /(?:可以|适当|多用|带点|加点).*?(?:emoji|表情|颜文字)/iu

/**
 * Derive only presentation hints. Every field has an explicit precedence:
 * personal preference, current requester structure, group style, default.
 */
export function deriveMemberInteractionProfile(
  input: MemberInteractionProfileInput,
): MemberInteractionProfile {
  const personalPreference = readExplicitPreference(input.authorizedPersonalMemory ?? [])
  const requesterMessages = input.recentRequesterActiveContext.filter(
    (message) => typeof message.text === 'string' && message.text.trim().length > 0,
  )
  const requesterStyle = requesterMessages.length === 0
    ? undefined
    : observeGroupStyle({
        recentGroupContext: requesterMessages.map((message) => ({
          text: message.text,
          speakerType: 'MEMBER' as const,
        })),
        groupAmbientContext: [],
      })

  const profile: MemberInteractionProfile = {
    responseDepth: personalPreference.responseDepth ??
      responseDepthFromStyle(requesterStyle) ??
      responseDepthFromStyle(input.groupStyle) ??
      DEFAULT_PROFILE.responseDepth,
    tone: personalPreference.tone ??
      toneFromStyle(requesterStyle) ??
      toneFromStyle(input.groupStyle) ??
      DEFAULT_PROFILE.tone,
    emojiTolerance: personalPreference.emojiTolerance ??
      emojiToleranceFromStyle(requesterStyle) ??
      emojiToleranceFromStyle(input.groupStyle) ??
      DEFAULT_PROFILE.emojiTolerance,
    addressFrequency: personalPreference.addressFrequency ?? DEFAULT_PROFILE.addressFrequency,
    familiarity: requesterMessages.length >= 2 ? 'FAMILIAR' : 'NEW',
  }

  return Object.freeze(profile)
}

/** Only these enum values cross the provider boundary. */
export function formatMemberInteractionProfile(profile: MemberInteractionProfile): string {
  return [
    `RESPONSE_DEPTH=${profile.responseDepth}`,
    `TONE=${profile.tone}`,
    `EMOJI_TOLERANCE=${profile.emojiTolerance}`,
    `ADDRESS_FREQUENCY=${profile.addressFrequency}`,
    `FAMILIARITY=${profile.familiarity}`,
  ].join('\n')
}

interface ExplicitPreferenceHints {
  responseDepth?: MemberResponseDepth
  tone?: MemberInteractionTone
  emojiTolerance?: MemberEmojiTolerance
  addressFrequency?: MemberAddressFrequency
}

/**
 * Read only explicit, already-classified requester preferences. Group memory,
 * content preferences and relationship/identity kinds are intentionally ignored.
 * Ambiguous phrases leave the field unset and let the bounded observation win.
 */
function readExplicitPreference(items: readonly MemoryPromptItem[]): ExplicitPreferenceHints {
  const hints: ExplicitPreferenceHints = {}
  for (const item of items) {
    if (item.scope !== 'PERSONAL') continue
    if (item.kind === 'ADDRESS_PREFERENCE') {
      hints.addressFrequency ??= 'NORMAL'
      continue
    }
    if (item.kind !== 'SOFT_STYLE_PREFERENCE' || typeof item.content !== 'string') continue

    const content = item.content.trim()
    if (hints.responseDepth === undefined) {
      hints.responseDepth = exclusivePreference(content, SHORT_PREFERENCE, DETAILED_PREFERENCE, 'SHORT', 'DETAILED')
    }
    if (hints.tone === undefined) {
      hints.tone = exclusivePreference(content, CASUAL_PREFERENCE, TECHNICAL_PREFERENCE, 'CASUAL', 'TECHNICAL')
    }
    if (hints.emojiTolerance === undefined) {
      const low = LOW_EMOJI_PREFERENCE.test(content)
      const normal = NORMAL_EMOJI_PREFERENCE.test(content)
      if (low !== normal) {
        hints.emojiTolerance = low ? 'LOW' : 'NORMAL'
      }
    }
  }
  return hints
}

function exclusivePreference<T>(
  content: string,
  first: RegExp,
  second: RegExp,
  firstValue: T,
  secondValue: T,
): T | undefined {
  const firstMatch = first.test(content)
  const secondMatch = second.test(content)
  if (firstMatch === secondMatch) return undefined
  return firstMatch ? firstValue : secondValue
}

function responseDepthFromStyle(profile: GroupStyleProfile | undefined): MemberResponseDepth | undefined {
  if (profile === undefined || profile.sampleCount === 0) return undefined
  return mapLength(profile.messageLength)
}

function mapLength(length: GroupStyleMessageLength): MemberResponseDepth | undefined {
  if (length === 'VERY_SHORT' || length === 'SHORT') return 'SHORT'
  if (length === 'LONG') return 'DETAILED'
  return 'NORMAL'
}

function toneFromStyle(profile: GroupStyleProfile | undefined): MemberInteractionTone | undefined {
  if (profile === undefined || profile.sampleCount === 0) return undefined
  if (profile.emojiDensity === 'HIGH' || (profile.messageLength === 'VERY_SHORT' && profile.punctuationDensity === 'LOW')) {
    return 'CASUAL'
  }
  return 'NEUTRAL'
}

function emojiToleranceFromStyle(profile: GroupStyleProfile | undefined): MemberEmojiTolerance | undefined {
  if (profile === undefined || profile.sampleCount === 0) return undefined
  return profile.emojiDensity === 'NONE' ? 'LOW' : 'NORMAL'
}
