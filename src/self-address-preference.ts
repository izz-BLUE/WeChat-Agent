/**
 * Deterministic fast path for a requester choosing how the Agent addresses them.
 *
 * This module deliberately recognises only a small set of sentence-open forms.
 * It is not a general Chinese intent classifier and it never decides scope or
 * authorization; those remain runtime facts owned by MemoryService.
 */

export const SELF_ADDRESS_PREFERENCE_REJECT_REPLY = '这个称呼不支持保存，换一个吧。'

export type SelfAddressPreferenceParseResult =
  | { outcome: 'MISS' }
  | { outcome: 'MATCH'; nickname: string }
  | { outcome: 'REJECT'; reason: 'INVALID_NICKNAME' | 'EXPLICIT_SEXUAL_CONTENT' }

export type AddressPreferenceSafetyResult =
  | { safe: true }
  | { safe: false; reason: 'EXPLICIT_SEXUAL_CONTENT' }

/** Narrow policy boundary used only for ADDRESS_PREFERENCE values. */
export class AddressPreferenceSafetyPolicy {
  public static evaluate(nickname: string): AddressPreferenceSafetyResult {
    return HIGH_PRECISION_EXPLICIT_PATTERNS.some((pattern) => pattern.test(nickname))
      ? { safe: false, reason: 'EXPLICIT_SEXUAL_CONTENT' }
      : { safe: true }
  }
}

const ADDRESS_COMMAND_PATTERNS: readonly RegExp[] = [
  /^以后(?:叫|喊|称呼)我(?<nickname>[\s\S]*)$/u,
  /^你可以叫我(?<nickname>[\s\S]*)$/u,
  /^你叫我(?<nickname>[\s\S]*)$/u,
  /^叫我(?<nickname>[\s\S]*)$/u,
]

/** High-confidence explicit content only; ordinary intimate terms are absent. */
const HIGH_PRECISION_EXPLICIT_PATTERNS: readonly RegExp[] = [
  /(?:性交|做爱|口交|肛交|射精|约炮|援交|卖淫|嫖娼|色情服务|色情网站|成人视频|黄片|淫荡|骚货|操你|干你|肏|鸡巴|阴茎|龟头|阴道|阴蒂|阴囊)/iu,
  /(?:porn|blowjob|handjob|cumshot|prostitute|escort|fuck(?:me|you)?|dick|pussy)/iu,
]

const SENTENCE_PUNCTUATION = /[，,。！？!?；;：:]/u
const CONTROL_OR_FORMAT_CHARACTER = /[\p{Cc}\p{Cf}]/u
const URL_PATTERN = /(?:https?:\/\/|ftp:\/\/|www\.)/iu
const BARE_DOMAIN_PATTERN = /^(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:[/?#:].*)?$/u
const NICKNAME_CHARACTER = /[\p{L}\p{N}\p{M}]/u

/** Parse one of the supported address-preference forms without LLM/NLU. */
export function parseSelfAddressPreference(text: string): SelfAddressPreferenceParseResult {
  const canonical = text.normalize('NFC').trim()
  const match = ADDRESS_COMMAND_PATTERNS
    .map((pattern) => pattern.exec(canonical))
    .find((candidate) => candidate !== null)
  if (match === undefined) {
    return { outcome: 'MISS' }
  }

  let nickname = (match.groups?.nickname ?? '').normalize('NFC').trim()
  nickname = nickname.replace(/[。！？!?]+$/u, '').trim()
  if (nickname.endsWith('就行')) {
    nickname = nickname.slice(0, -2).trim()
  }

  const structuralReason = validateNicknameStructure(nickname)
  if (structuralReason !== null) {
    return { outcome: 'REJECT', reason: structuralReason }
  }

  const safety = AddressPreferenceSafetyPolicy.evaluate(nickname)
  if (!safety.safe) {
    return { outcome: 'REJECT', reason: safety.reason }
  }
  return { outcome: 'MATCH', nickname }
}

function validateNicknameStructure(nickname: string): 'INVALID_NICKNAME' | null {
  const codePointCount = Array.from(nickname).length
  if (codePointCount < 1 || codePointCount > 16) {
    return 'INVALID_NICKNAME'
  }
  if (CONTROL_OR_FORMAT_CHARACTER.test(nickname) || /\s/u.test(nickname)) {
    return 'INVALID_NICKNAME'
  }
  if (nickname.includes('@') || URL_PATTERN.test(nickname) || BARE_DOMAIN_PATTERN.test(nickname)) {
    return 'INVALID_NICKNAME'
  }
  if (SENTENCE_PUNCTUATION.test(nickname) || !NICKNAME_CHARACTER.test(nickname)) {
    return 'INVALID_NICKNAME'
  }
  return null
}
