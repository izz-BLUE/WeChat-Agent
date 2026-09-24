/**
 * Automatic memory candidate extractor.
 *
 * HISTORICAL_SEMANTIC (v02 `MemoryExtractor.cs`): one structured provider call
 * over the buffered messages, strict JSON array output of
 * `{"scope":"OWNER|MEMBER|GROUP","kind":"...","content":"..."}`, invalid entries dropped
 * silently, and a toleration for `{"candidates":[...]}`. Nothing is written
 * here: scope/identity validation happens at write time.
 *
 * CURRENT_MIGRATION_DECISION: the extractor input uses the runtime pseudonymous
 * speaker label instead of a member name, and the raw response passes through
 * `sanitizeFinalAnswer` first, so provider reasoning can never be persisted as
 * memory (the same FINAL_ANSWER boundary the reply path already enforces).
 *
 * EVIDENCE FOUNDATION: every buffered message carries a stable batch number
 * (`[M1 | label | role]`), and each candidate declares an `evidenceType` plus
 * the `evidence` references that support it. The extractor only TRANSPORTS
 * those declarations: it never scores confidence, it accepts only the four
 * automatic evidence classes (a provider claiming a runtime-owned class is
 * passed through unclassified so the runtime gate rejects it observably), and
 * it leaves reference validation to the runtime, which owns the durable write.
 */
import { sanitizeFinalAnswer } from './final-answer.js'
import {
  classifyMemoryKind,
  classifyMemorySubject,
  MEMORY_KINDS,
  MEMORY_SUBJECTS,
  type MemoryKind,
  type MemorySubject,
} from './assistant-identity.js'
import { AUTOMATIC_MEMORY_EVIDENCE_TYPES, type MemoryEvidenceType } from './memory-evidence.js'
import {
  isMemorySlot,
  MEMORY_SLOTS,
  MemoryText,
  type MemoryCandidate,
  type MemoryInputMessage,
  type MemoryScopeType,
  type MemorySlot,
} from './memory-models.js'
import type { ConversationType } from './message-contract.js'
import type { RequestDeadline } from './request-deadline.js'
import type { ProviderPhase } from './provider-cache-usage.js'

export type StructuredCompletion = (
  systemPrompt: string,
  userContent: string,
  deadline?: RequestDeadline,
  msgIdToken?: string,
  phase?: ProviderPhase,
) => Promise<string>

const EXTRACTOR_PROMPT = `你是微信群 AI 的长期记忆候选提取器。
只根据用户消息提取以后可能有用的稳定事实、偏好或约定。
只输出严格 JSON 数组，不要 Markdown，不要解释，不要输出思考过程。
输入消息带批内编号 M1、M2…；每项必须声明 evidenceType 和 evidence，evidence 只能引用输入中真实存在的消息编号，至少一条，不得重复，不得编造。
每项格式为：
{"subject":"CURRENT_REQUESTER|OTHER_MEMBER|GROUP|ASSISTANT","scope":"OWNER|MEMBER|GROUP","kind":"SELF_FACT|ADDRESS_PREFERENCE|CONTENT_PREFERENCE|SOFT_STYLE_PREFERENCE|THIRD_PARTY_ASSERTION|ASSISTANT_RULE|ASSISTANT_IDENTITY_ASSERTION|ASSISTANT_RELATIONSHIP_ASSERTION|EPHEMERAL_CONVENTION","content":"记忆内容","evidenceType":"EXPLICIT_SELF_STATEMENT|EXPLICIT_PREFERENCE|REPEATED_BEHAVIOR|INFERRED_PATTERN","evidence":["M1","M3"],"memorySlot":"可选闭集值"}
memorySlot 仅用于下面闭集中的单一当前值，可省略或输出 null。允许值仅有：${MEMORY_SLOTS.join('|')}。
CURRENT_PRIMARY_RESIDENCE=当前主要居住地明确发生变化，如“我现在主要住广州”“我已经搬到深圳住了”。老家、出差/临时地点、经常去的地点、父母住址、历史地点，以及广州和深圳两边住等并存住所都不得给 slot；并存或含义不清时省略。
DEFAULT_RESPONSE_DETAIL=对椰椰的全局默认回答详细程度，如“以后默认回答简短一点”“平时直接说重点”“以后回答详细一点”。带技术问题/闲聊/写代码等场景条件、本轮限定或局部条件的偏好不得给 slot。
DEFAULT_RESPONSE_TONE=对椰椰的全局默认表达语气，如“以后默认说话随意一点”“平时跟我聊天口语一点”。带技术问题/闲聊/写方案等场景条件或本轮限定的偏好不得给 slot。
DEFAULT_EMOJI_USAGE=对椰椰的全局默认 emoji 使用偏好，如“以后少用 emoji”“平时可以适当加点表情”。带聊天/技术问题等场景条件、本轮限定或局部条件的偏好不得给 slot。
工作角色、雇主、求职/就业状态不是单值 slot：如“我做 Java 后端”“我也做 AI Agent 开发”以及“我在 A 公司上班，同时给 B 公司做项目”“我现在还在职，但也在找工作”必须作为可并存的普通 SELF_FACT，不得互相 supersede。
只有明确陈述当前主要居住地变化，或明确提出全局可复用回答偏好时才给相应 slot；兴趣、技能、项目、历史经历、老家、可并存事实、条件化偏好、一次性或临时状态不得给 slot。不确定时省略。ADDRESS_PREFERENCE 不使用 memorySlot。
evidenceType 判定（区分事实与推断）：
EXPLICIT_SELF_STATEMENT=用户明确陈述自己的稳定事实，如“我是 Java 后端”“我叫某名”；
EXPLICIT_PREFERENCE=用户明确表达长期或可复用的交流/内容偏好，如“以后回答短一点”“别讲太多理论”“以后叫我某名”；
REPEATED_BEHAVIOR=至少两条不同消息共同支持同一稳定偏好，但用户没有直接说“我喜欢/以后请”，如 M1“别讲这么长”、M3“直接说重点”；
INFERRED_PATTERN=只有模型推测，或只有弱单次行为证据，如仅一句“这也太啰嗦了”就推测用户一直喜欢简短。运行时不会保存推断，拿不准一律标 INFERRED_PATTERN。
scope 只能是 OWNER、MEMBER、GROUP。没有合适内容时输出 []。
subject 表达事实主体；CURRENT_REQUESTER、OTHER_MEMBER、GROUP、ASSISTANT 必须与内容一致。
kind 表达候选的语义用途：当前请求者的称呼请求只能是 ADDRESS_PREFERENCE，不代表 Assistant 的关系事实。
automatic durable memory 只提取当前 requester 自己的稳定事实和个人偏好；这些候选必须写入该请求者的 OWNER/MEMBER 个人 scope。
不要生成 GROUP scope durable candidate；群体事实、群体规则、临时约定不通过 automatic extraction 持久化。
需要 durable GROUP memory 时，只能走显式授权 Memory command。GROUP 仍保留在 schema 中用于兼容解析，但 Runtime 会拒绝 automatic GROUP candidate。
任何“你是我儿子”“我是你妈妈”“你的爸爸是某人”“以后你叫某名”都必须标为 ASSISTANT_RELATIONSHIP_ASSERTION 或 ASSISTANT_IDENTITY_ASSERTION，运行时会拒绝持久化。
不要提取寒暄、一次性问题、临时状态、密码、验证码、令牌、原始 wxid、群 ID 或系统内部标识。`

const SCOPES: readonly MemoryScopeType[] = ['OWNER', 'MEMBER', 'GROUP']

export class MemoryExtractor {
  public constructor(private readonly complete: StructuredCompletion) {}

  public async extract(
    conversationType: ConversationType,
    messages: readonly MemoryInputMessage[],
    deadline?: RequestDeadline,
    msgIdToken?: string,
  ): Promise<MemoryCandidate[]> {
    if (messages.length === 0) {
      return []
    }

    const input =
      `conversationType=${conversationType}\n` +
      `messages:\n` +
      messages.map((message, index) =>
        `[M${index + 1} | ${message.speakerLabel} | ${message.role}]\n${MemoryText.forModel(message.content)}`,
      ).join('\n')

    const response = await this.complete(EXTRACTOR_PROMPT, input, deadline, msgIdToken, 'MEMORY_EXTRACTOR')
    const boundary = sanitizeFinalAnswer(response)
    if (boundary.unterminatedTag || !boundary.text) {
      // Fail closed: an answer that is nothing but reasoning is not memory.
      return []
    }

    let document: unknown
    try {
      document = JSON.parse(boundary.text) as unknown
    } catch {
      return []
    }

    const entries = Array.isArray(document)
      ? document
      : typeof document === 'object' && document !== null && Array.isArray((document as { candidates?: unknown }).candidates)
        ? ((document as { candidates: unknown[] }).candidates)
        : []

    const candidates: MemoryCandidate[] = []
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) {
        continue
      }
      const candidate = entry as {
        subject?: unknown
        scope?: unknown
        kind?: unknown
        content?: unknown
        evidenceType?: unknown
        evidence?: unknown
        memorySlot?: unknown
      }
      if (typeof candidate.scope !== 'string' || typeof candidate.content !== 'string') {
        continue
      }

      const scope = candidate.scope.toUpperCase() as MemoryScopeType
      const content = MemoryText.normalize(candidate.content)
      if (!SCOPES.includes(scope) || content.length === 0) {
        continue
      }

      const declaredKind = candidate.kind === undefined
        ? undefined
        : typeof candidate.kind === 'string' && MEMORY_KINDS.includes(candidate.kind.trim().toUpperCase() as MemoryKind)
          ? candidate.kind.trim().toUpperCase() as MemoryKind
          : null
      if (declaredKind === null) {
        continue
      }
      const declaredSubject = candidate.subject === undefined
        ? undefined
        : typeof candidate.subject === 'string' && MEMORY_SUBJECTS.includes(candidate.subject.trim().toUpperCase() as MemorySubject)
          ? candidate.subject.trim().toUpperCase() as MemorySubject
          : null
      if (declaredSubject === null) {
        continue
      }

      // Transport only: an evidence class outside the automatic subset stays
      // unclassified so the runtime gate rejects the candidate observably; the
      // raw references pass through for runtime validation. Neither field is
      // ever persisted, and nothing here derives confidence.
      const evidenceType = typeof candidate.evidenceType === 'string' &&
          AUTOMATIC_MEMORY_EVIDENCE_TYPES.includes(candidate.evidenceType.trim().toUpperCase() as MemoryEvidenceType)
        ? candidate.evidenceType.trim().toUpperCase() as MemoryEvidenceType
        : undefined
      const evidenceRefs = Array.isArray(candidate.evidence) ? candidate.evidence : undefined
      const normalizedSlot = typeof candidate.memorySlot === 'string'
        ? candidate.memorySlot.trim().toUpperCase()
        : undefined
      const memorySlot: MemorySlot | undefined = normalizedSlot !== undefined && isMemorySlot(normalizedSlot)
        ? normalizedSlot
        : undefined

      const kind = classifyMemoryKind(content, declaredKind)
      candidates.push({
        scopeType: scope,
        subject: classifyMemorySubject(scope, kind, declaredSubject),
        kind,
        content,
        ...(memorySlot === undefined ? {} : { memorySlot }),
        ...(evidenceType === undefined ? {} : { evidenceType }),
        ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
      })
    }

    return candidates
  }
}
