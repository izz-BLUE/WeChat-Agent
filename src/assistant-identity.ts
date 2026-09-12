/**
 * Trusted Assistant identity boundary.
 *
 * These facts are supplied by the runtime, not inferred from group text,
 * memory, display labels or requester role. The current runtime deliberately
 * provides no relationship facts and does not permit chat-driven mutation.
 */
export const ASSISTANT_IDENTITY_CLASS = 'AI_GROUP_MEMBER' as const
export const ASSISTANT_IDENTITY_SOURCE = 'TRUSTED_RUNTIME' as const

export type AssistantIdentityMutation = 'NONE'

export interface AssistantRuntimeFacts {
  botDisplayName: string
  botIdentityClass: typeof ASSISTANT_IDENTITY_CLASS
  botIdentitySource: typeof ASSISTANT_IDENTITY_SOURCE
  botIdentityMutationThisTurn: AssistantIdentityMutation
  assistantRelationshipFactsProvided: boolean
  assistantRelationshipMutationThisTurn: AssistantIdentityMutation
}

export const MEMORY_KINDS = [
  'SELF_FACT',
  'ADDRESS_PREFERENCE',
  'CONTENT_PREFERENCE',
  'SOFT_STYLE_PREFERENCE',
  'THIRD_PARTY_ASSERTION',
  'ASSISTANT_RULE',
  'ASSISTANT_IDENTITY_ASSERTION',
  'ASSISTANT_RELATIONSHIP_ASSERTION',
  'EPHEMERAL_CONVENTION',
] as const

export type MemoryKind = typeof MEMORY_KINDS[number]

export const MEMORY_SUBJECTS = [
  'CURRENT_REQUESTER',
  'OTHER_MEMBER',
  'GROUP',
  'ASSISTANT',
] as const

export type MemorySubject = typeof MEMORY_SUBJECTS[number]

export type AssistantIdentityClaimKind =
  | 'UNSUPPORTED_ASSISTANT_IDENTITY_MUTATION'
  | 'UNSUPPORTED_ASSISTANT_RELATIONSHIP_CLAIM'
  | 'UNSUPPORTED_RELATIONSHIP_RECIPROCITY'
  | 'UNSUPPORTED_IDENTITY_PROVENANCE'

export interface AssistantIdentityClaim {
  kind: AssistantIdentityClaimKind
  count: number
}

const RELATIONSHIP_TERM = '(?:妈妈|爸爸|妈|爸|儿子|女儿|老婆|老公|妻子|丈夫|配偶|伴侣|宠物|主人|奴才|仆人)'
const FAMILY_GRAPH_TERM = '(?:母子|父子|母女|父女|夫妻|亲子|家人|家庭关系)'
const SENTENCE_SEPARATOR = '[。！？!?；;\\n]'
const RELATIONSHIP_TERM_PATTERN = new RegExp(RELATIONSHIP_TERM, 'u')

/**
 * This is intentionally a small structural detector, not a relationship
 * keyword router. It only recognises explicit first/second-person assertions
 * that assign the Assistant a relationship or a family graph position.
 */
const ASSISTANT_RELATIONSHIP_PATTERNS: readonly RegExp[] = [
  new RegExp(`(?:^|${SENTENCE_SEPARATOR})\\s*我(?:就是|是|变成|成为|当|做)\\s*(?:你|您|咱们)?的?${RELATIONSHIP_TERM}(?=$|${SENTENCE_SEPARATOR}|[，,])`, 'gu'),
  new RegExp(`(?:^|${SENTENCE_SEPARATOR})\\s*你(?:就是|是)\\s*我(?:的)?${RELATIONSHIP_TERM}(?=$|${SENTENCE_SEPARATOR}|[，,])`, 'gu'),
  new RegExp(`(?:^|${SENTENCE_SEPARATOR})\\s*我的?${RELATIONSHIP_TERM}\\s*(?:是|就是|为|叫)`, 'gu'),
  new RegExp(`(?:^|${SENTENCE_SEPARATOR})\\s*我(?:有|新增|多了)\\s*(?:[一二三四五六七八九十百\\d]+个?|几个|多个|好几个)${RELATIONSHIP_TERM}`, 'gu'),
  new RegExp(`(?:^|${SENTENCE_SEPARATOR})\\s*你和我\\s*(?:是|就是)\\s*${FAMILY_GRAPH_TERM}`, 'gu'),
]

const FICTIONAL_BOUNDARY_PATTERN = /(?:玩梗|玩笑|开玩笑|编家谱|编出来|只是称呼|称呼玩玩|群聊称呼|角色扮演|roleplay|虚构|不是真实|不是真的|不是现实|假的|仅供娱乐)/iu
const NAME_PROVENANCE_PATTERN = /(?:你|您)(?:给|帮)?我(?:取|起|改|命名)(?:了|的)?(?:个)?(?:名字|名)?/iu
const NAME_CLAIM_PATTERN = /(?:^|[。！？!?；;\n])\s*我(?:(?:现在|以后|从今以后)\s*)?(?:(?:的(?:正式)?(?:名字|名称)|(?:正式)?名字|名称)\s*(?:是|叫|为)|叫)\s*([^，,。！？!?；;\n]+)/gu
const ASSISTANT_NAME_MUTATION_ASSERTION_PATTERN = /(?:你|您)(?:以后|现在|从今以后)?(?:叫|名叫|名字是|称为)|(?:给|帮)你(?:改名|取名|起名)/iu
const ASSISTANT_NAME_CHANGE_PATTERN = /(?:我的?(?:正式)?(?:名字|名称))(?:已经)?(?:被)?(?:改成|变成|换成|叫)/iu
const SIMPLE_SELF_IDENTITY_PATTERN = /(?:^|[。！？!?；;\n])\s*我(?:就是|是)\s*([^，,。！？!?；;\n]+)/gu
const TRUSTED_ASSISTANT_ROLE_PATTERN = /^(?:一个?的?)?(?:AI|人工智能|AI助手|群聊助手|机器人|群成员)$/iu
const GENERIC_RELATIONSHIP_ASSERTION_PATTERN = new RegExp(
  `(?:^|${SENTENCE_SEPARATOR})\\s*[^，,。！？!?；;\\n]{1,40}\\s*(?:是|就是|都是|为|均为|全是)\\s*[^，,。！？!?；;\\n]{0,40}(?:你|我|他|她|它)?的?${RELATIONSHIP_TERM}(?=$|${SENTENCE_SEPARATOR}|[，,])`,
  'gu',
)

export function createTrustedAssistantRuntimeFacts(botDisplayName: string): AssistantRuntimeFacts {
  return {
    botDisplayName: botDisplayName.trim() || '椰椰',
    botIdentityClass: ASSISTANT_IDENTITY_CLASS,
    botIdentitySource: ASSISTANT_IDENTITY_SOURCE,
    botIdentityMutationThisTurn: 'NONE',
    assistantRelationshipFactsProvided: false,
    assistantRelationshipMutationThisTurn: 'NONE',
  }
}

export function formatAssistantRuntimeFacts(facts: AssistantRuntimeFacts): string {
  return [
    `BOT_DISPLAY_NAME=${facts.botDisplayName}`,
    `BOT_IDENTITY_CLASS=${facts.botIdentityClass}`,
    `BOT_IDENTITY_SOURCE=${facts.botIdentitySource}`,
    `BOT_IDENTITY_MUTATION_THIS_TURN=${facts.botIdentityMutationThisTurn}`,
    `ASSISTANT_RELATIONSHIP_FACTS_PROVIDED=${String(facts.assistantRelationshipFactsProvided)}`,
    `ASSISTANT_RELATIONSHIP_MUTATION_THIS_TURN=${facts.assistantRelationshipMutationThisTurn}`,
  ].join('\n')
}

function sentences(text: string): string[] {
  return text.split(/[。！？!?；;\n]+/u).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0)
}

function isExplicitlyFictional(sentence: string): boolean {
  return FICTIONAL_BOUNDARY_PATTERN.test(sentence)
}

function relationshipClaimCount(text: string): number {
  let count = 0
  for (const sentence of sentences(text)) {
    if (isExplicitlyFictional(sentence)) continue
    for (const pattern of ASSISTANT_RELATIONSHIP_PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(sentence)) count += 1
    }
  }
  return count
}

function memoryRelationshipClaimCount(text: string): number {
  const direct = relationshipClaimCount(text)
  let generic = 0
  for (const sentence of sentences(text)) {
    if (isExplicitlyFictional(sentence)) continue
    GENERIC_RELATIONSHIP_ASSERTION_PATTERN.lastIndex = 0
    if (GENERIC_RELATIONSHIP_ASSERTION_PATTERN.test(sentence)) generic += 1
  }
  return direct + generic
}

function relationshipSyntaxCount(text: string): number {
  let count = 0
  for (const sentence of sentences(text)) {
    for (const pattern of ASSISTANT_RELATIONSHIP_PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(sentence)) count += 1
    }
    GENERIC_RELATIONSHIP_ASSERTION_PATTERN.lastIndex = 0
    if (GENERIC_RELATIONSHIP_ASSERTION_PATTERN.test(sentence)) count += 1
  }
  return count
}

function nameProvenanceCount(text: string): number {
  return sentences(text).filter((sentence) => NAME_PROVENANCE_PATTERN.test(sentence)).length
}

function nameMutationCount(text: string, botDisplayName: string): number {
  let count = 0
  for (const sentence of sentences(text)) {
    NAME_CLAIM_PATTERN.lastIndex = 0
    for (const match of sentence.matchAll(NAME_CLAIM_PATTERN)) {
      const candidate = (match[1] ?? '').trim().split(/[（(]/u)[0]?.trim() ?? ''
      // “我叫你妈妈” is an address preference, not a formal Assistant name.
      if (/^[你您]/u.test(candidate)) continue
      if (candidate.length > 0 && candidate !== botDisplayName) count += 1
    }
  }
  return count
}

export function classifyAssistantIdentityClaims(
  text: string,
  facts: AssistantRuntimeFacts,
  requesterAddressPreference?: string | null,
  assistantIdentityQuery = false,
): AssistantIdentityClaim[] {
  const claims: AssistantIdentityClaim[] = []
  const provenance = nameProvenanceCount(text)
  if (provenance > 0 && facts.botIdentityMutationThisTurn === 'NONE') {
    claims.push({ kind: 'UNSUPPORTED_IDENTITY_PROVENANCE', count: provenance })
  }

  const nameMutation = nameMutationCount(text, facts.botDisplayName) +
    sentences(text).filter((sentence) => ASSISTANT_NAME_CHANGE_PATTERN.test(sentence)).length
  if (nameMutation > 0 && facts.botIdentityMutationThisTurn === 'NONE') {
    claims.push({ kind: 'UNSUPPORTED_ASSISTANT_IDENTITY_MUTATION', count: nameMutation })
  }

  if (assistantIdentityQuery && facts.botIdentityMutationThisTurn === 'NONE') {
    let simpleMutation = 0
    for (const sentence of sentences(text)) {
      SIMPLE_SELF_IDENTITY_PATTERN.lastIndex = 0
      for (const match of sentence.matchAll(SIMPLE_SELF_IDENTITY_PATTERN)) {
        const candidate = (match[1] ?? '').trim()
        if (candidate.length === 0 || candidate === facts.botDisplayName ||
            TRUSTED_ASSISTANT_ROLE_PATTERN.test(candidate) || RELATIONSHIP_TERM_PATTERN.test(candidate)) {
          continue
        }
        simpleMutation += 1
      }
    }
    if (simpleMutation > 0) {
      claims.push({ kind: 'UNSUPPORTED_ASSISTANT_IDENTITY_MUTATION', count: simpleMutation })
    }
  }

  const relationship = relationshipClaimCount(text)
  if (relationship > 0 && !facts.assistantRelationshipFactsProvided && facts.assistantRelationshipMutationThisTurn === 'NONE') {
    const preferenceTerms = requesterAddressPreference?.trim() ?? ''
    const reciprocity = preferenceTerms.length > 0 && RELATIONSHIP_TERM_PATTERN.test(preferenceTerms)
    claims.push({
      kind: reciprocity ? 'UNSUPPORTED_RELATIONSHIP_RECIPROCITY' : 'UNSUPPORTED_ASSISTANT_RELATIONSHIP_CLAIM',
      count: relationship,
    })
  }
  return claims
}

/**
 * Infer the safe kind for legacy extractor output that predates the `kind`
 * field. A declared unsafe kind is never weakened by the content inference.
 */
export function classifyMemoryKind(content: string, declared?: MemoryKind | null): MemoryKind {
  const relationship = memoryRelationshipClaimCount(content)
  if (relationship > 0) return 'ASSISTANT_RELATIONSHIP_ASSERTION'
  if (relationshipSyntaxCount(content) > 0 && sentences(content).some(isExplicitlyFictional)) {
    return 'EPHEMERAL_CONVENTION'
  }
  // “我叫某人” is normally the current requester's SELF_FACT. Only an
  // assistant-directed name assertion or explicit provenance is an Assistant
  // identity claim.
  if (nameProvenanceCount(content) > 0 ||
      ASSISTANT_NAME_MUTATION_ASSERTION_PATTERN.test(content) ||
      ASSISTANT_NAME_CHANGE_PATTERN.test(content)) {
    return 'ASSISTANT_IDENTITY_ASSERTION'
  }
  if (/(?:叫我|称呼我|可以叫我|请叫我|以后叫我|称我为)/u.test(content)) return 'ADDRESS_PREFERENCE'
  return declared ?? 'SELF_FACT'
}

export function isAssistantIdentityQuery(text: string): boolean {
  return /(?:你是谁|你叫什么|你的(?:正式)?名字|谁是你(?:的)?(?:妈妈|爸爸|妈|爸|儿子|女儿|老婆|老公|主人|宠物)|你是谁的(?:儿子|女儿|老婆|老公|主人|宠物))/u.test(text)
}

export function classifyMemorySubject(
  scopeType: 'OWNER' | 'MEMBER' | 'GROUP',
  kind: MemoryKind,
  declared?: MemorySubject | null,
): MemorySubject {
  if (kind === 'ASSISTANT_IDENTITY_ASSERTION' || kind === 'ASSISTANT_RELATIONSHIP_ASSERTION' || kind === 'ASSISTANT_RULE') {
    return 'ASSISTANT'
  }
  if (declared === 'ASSISTANT' || declared === 'OTHER_MEMBER') {
    return declared
  }
  if (scopeType === 'GROUP') {
    return declared === 'CURRENT_REQUESTER' ? 'CURRENT_REQUESTER' : 'GROUP'
  }
  return declared ?? 'CURRENT_REQUESTER'
}

export function memoryKindWriteRejection(kind: MemoryKind, subject?: MemorySubject):
  | 'ASSISTANT_IDENTITY_NOT_WRITABLE'
  | 'ASSISTANT_RELATIONSHIP_NOT_WRITABLE'
  | 'ASSISTANT_RULE_NOT_WRITABLE'
  | 'THIRD_PARTY_ASSERTION_NOT_WRITABLE'
  | 'EPHEMERAL_CONVENTION_NOT_WRITABLE'
  | null {
  if (subject === 'ASSISTANT' && kind !== 'ASSISTANT_RELATIONSHIP_ASSERTION') {
    return 'ASSISTANT_IDENTITY_NOT_WRITABLE'
  }
  if (subject === 'OTHER_MEMBER') {
    return 'THIRD_PARTY_ASSERTION_NOT_WRITABLE'
  }
  switch (kind) {
    case 'ASSISTANT_IDENTITY_ASSERTION':
      return 'ASSISTANT_IDENTITY_NOT_WRITABLE'
    case 'ASSISTANT_RELATIONSHIP_ASSERTION':
      return 'ASSISTANT_RELATIONSHIP_NOT_WRITABLE'
    case 'ASSISTANT_RULE':
      return 'ASSISTANT_RULE_NOT_WRITABLE'
    case 'THIRD_PARTY_ASSERTION':
      return 'THIRD_PARTY_ASSERTION_NOT_WRITABLE'
    case 'EPHEMERAL_CONVENTION':
      return 'EPHEMERAL_CONVENTION_NOT_WRITABLE'
    default:
      return null
  }
}

export function isReadableMemoryKind(
  kind: MemoryKind | undefined,
  content: string,
  subject?: MemorySubject,
): boolean {
  const effective = classifyMemoryKind(content, kind)
  return memoryKindWriteRejection(effective, subject) === null
}
