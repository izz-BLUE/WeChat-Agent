/**
 * Deterministic, presentation-only observation of recent group chatter.
 *
 * The samples are deliberately transient. The returned profile contains only
 * counts and coarse structural buckets; it never carries message text,
 * identities, labels or conversation metadata.
 */

export type GroupStyleMessageLength = 'VERY_SHORT' | 'SHORT' | 'MEDIUM' | 'LONG'
export type GroupStyleDensity = 'LOW' | 'MEDIUM' | 'HIGH'
export type GroupStyleEmojiDensity = 'NONE' | GroupStyleDensity

export interface GroupStyleProfile {
  sampleCount: number
  messageLength: GroupStyleMessageLength
  lineBreakDensity: GroupStyleDensity
  emojiDensity: GroupStyleEmojiDensity
  punctuationDensity: GroupStyleDensity
  latinMix: GroupStyleDensity
}

export type GroupStyleSpeakerType = 'MEMBER' | 'ASSISTANT'

/** Transient observation input. It is never returned as part of the profile. */
export interface GroupStyleMessage {
  text: string
  speakerType: GroupStyleSpeakerType
  /** Event identity is used only to avoid counting two views of one message. */
  eventId?: string
}

export interface GroupStyleObservationInput {
  recentGroupContext: readonly GroupStyleMessage[]
  groupAmbientContext: readonly GroupStyleMessage[]
}

/** All structural thresholds are explicit and covered by group-style.test.ts. */
export const GROUP_STYLE_THRESHOLDS = Object.freeze({
  messageLength: Object.freeze({ veryShortMax: 8, shortMax: 24, mediumMax: 80 }),
  lineBreakAverage: Object.freeze({ lowMax: 0.25, mediumMax: 1.25 }),
  emojiRatio: Object.freeze({ lowMax: 0.05, mediumMax: 0.15 }),
  punctuationRatio: Object.freeze({ lowMax: 0.08, mediumMax: 0.2 }),
  latinRatio: Object.freeze({ lowMax: 0.1, mediumMax: 0.4 }),
})

const NEUTRAL_PROFILE: GroupStyleProfile = Object.freeze({
  sampleCount: 0,
  messageLength: 'MEDIUM',
  lineBreakDensity: 'LOW',
  emojiDensity: 'NONE',
  punctuationDensity: 'LOW',
  latinMix: 'LOW',
})

const EMOJI_PATTERN = /\p{Extended_Pictographic}/gu
const PUNCTUATION_PATTERN = /\p{P}/gu
const LATIN_PATTERN = /[A-Za-z]/gu

export function neutralGroupStyleProfile(): GroupStyleProfile {
  return { ...NEUTRAL_PROFILE }
}

/**
 * Observe only MEMBER samples. ASSISTANT samples are explicitly discarded so
 * the bot cannot train its own style back into the profile.
 */
export function observeGroupStyle(input: GroupStyleObservationInput): GroupStyleProfile {
  const samples: GroupStyleMessage[] = []
  const seenEventIds = new Set<string>()

  for (const sample of [...input.recentGroupContext, ...input.groupAmbientContext]) {
    if (sample.speakerType !== 'MEMBER' || typeof sample.text !== 'string' || sample.text.trim().length === 0) {
      continue
    }

    const eventId = sample.eventId?.trim()
    if (eventId !== undefined && eventId.length > 0) {
      if (seenEventIds.has(eventId)) {
        continue
      }
      seenEventIds.add(eventId)
    }

    samples.push(sample)
  }

  if (samples.length === 0) {
    return neutralGroupStyleProfile()
  }

  const measurements = samples.map((sample) => measure(sample.text))
  const totalUnits = measurements.reduce((sum, item) => sum + item.units, 0)
  const totalEmoji = measurements.reduce((sum, item) => sum + item.emoji, 0)
  const totalPunctuation = measurements.reduce((sum, item) => sum + item.punctuation, 0)
  const totalLatin = measurements.reduce((sum, item) => sum + item.latin, 0)
  const averageLength = measurements.reduce((sum, item) => sum + item.units, 0) / samples.length
  const averageLineBreaks = measurements.reduce((sum, item) => sum + item.lineBreaks, 0) / samples.length

  return {
    sampleCount: samples.length,
    messageLength: classifyMessageLength(averageLength),
    lineBreakDensity: classifyBoundedDensity(
      averageLineBreaks,
      GROUP_STYLE_THRESHOLDS.lineBreakAverage.lowMax,
      GROUP_STYLE_THRESHOLDS.lineBreakAverage.mediumMax,
    ),
    emojiDensity: classifyEmojiDensity(
      totalEmoji / totalUnits,
      GROUP_STYLE_THRESHOLDS.emojiRatio.lowMax,
      GROUP_STYLE_THRESHOLDS.emojiRatio.mediumMax,
    ),
    punctuationDensity: classifyNonZeroRatioDensity(
      totalPunctuation / totalUnits,
      GROUP_STYLE_THRESHOLDS.punctuationRatio.lowMax,
      GROUP_STYLE_THRESHOLDS.punctuationRatio.mediumMax,
    ),
    latinMix: classifyNonZeroRatioDensity(
      totalLatin / totalUnits,
      GROUP_STYLE_THRESHOLDS.latinRatio.lowMax,
      GROUP_STYLE_THRESHOLDS.latinRatio.mediumMax,
    ),
  }
}

/** Only enum values and the count are rendered into the final prompt. */
export function formatGroupStyleProfile(profile: GroupStyleProfile): string {
  return [
    `SAMPLE_COUNT=${profile.sampleCount}`,
    `MESSAGE_LENGTH=${profile.messageLength}`,
    `LINE_BREAK_DENSITY=${profile.lineBreakDensity}`,
    `EMOJI_DENSITY=${profile.emojiDensity}`,
    `PUNCTUATION_DENSITY=${profile.punctuationDensity}`,
    `LATIN_MIX=${profile.latinMix}`,
  ].join('\n')
}

function measure(text: string): {
  units: number
  lineBreaks: number
  emoji: number
  punctuation: number
  latin: number
} {
  const normalized = text.trim()
  const units = Math.max(1, Array.from(normalized.replace(/\r\n/gu, '\n')).length)
  return {
    units,
    lineBreaks: (normalized.match(/\r\n|\r|\n/gu) ?? []).length,
    emoji: countMatches(normalized, EMOJI_PATTERN),
    punctuation: countMatches(normalized, PUNCTUATION_PATTERN),
    latin: countMatches(normalized, LATIN_PATTERN),
  }
}

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0
  return [...text.matchAll(pattern)].length
}

function classifyMessageLength(averageLength: number): GroupStyleMessageLength {
  if (averageLength <= GROUP_STYLE_THRESHOLDS.messageLength.veryShortMax) {
    return 'VERY_SHORT'
  }
  if (averageLength <= GROUP_STYLE_THRESHOLDS.messageLength.shortMax) {
    return 'SHORT'
  }
  if (averageLength <= GROUP_STYLE_THRESHOLDS.messageLength.mediumMax) {
    return 'MEDIUM'
  }
  return 'LONG'
}

function classifyBoundedDensity(value: number, lowMax: number, mediumMax: number): Exclude<GroupStyleDensity, 'NONE'> {
  if (value <= lowMax) {
    return 'LOW'
  }
  if (value <= mediumMax) {
    return 'MEDIUM'
  }
  return 'HIGH'
}

function classifyEmojiDensity(value: number, lowMax: number, mediumMax: number): GroupStyleEmojiDensity {
  if (value <= 0) {
    return 'NONE'
  }
  return classifyBoundedDensity(value, lowMax, mediumMax)
}

function classifyNonZeroRatioDensity(value: number, lowMax: number, mediumMax: number): GroupStyleDensity {
  return classifyBoundedDensity(value, lowMax, mediumMax)
}
