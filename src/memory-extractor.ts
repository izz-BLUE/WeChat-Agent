/**
 * Automatic memory candidate extractor.
 *
 * HISTORICAL_SEMANTIC (v02 `MemoryExtractor.cs`): one structured provider call
 * over the buffered messages, strict JSON array output of
 * `{"scope":"OWNER|MEMBER|GROUP","content":"..."}`, invalid entries dropped
 * silently, and a toleration for `{"candidates":[...]}`. Nothing is written
 * here: scope/identity validation happens at write time.
 *
 * CURRENT_MIGRATION_DECISION: the extractor input uses the runtime pseudonymous
 * speaker label instead of a member name, and the raw response passes through
 * `sanitizeFinalAnswer` first, so provider reasoning can never be persisted as
 * memory (the same FINAL_ANSWER boundary the reply path already enforces).
 */
import { sanitizeFinalAnswer } from './final-answer.js'
import { MemoryText, type MemoryCandidate, type MemoryInputMessage, type MemoryScopeType } from './memory-models.js'
import type { ConversationType } from './message-contract.js'
import type { RequestDeadline } from './request-deadline.js'

export type StructuredCompletion = (
  systemPrompt: string,
  userContent: string,
  deadline?: RequestDeadline,
  msgIdToken?: string,
) => Promise<string>

const EXTRACTOR_PROMPT = `你是微信群 AI 的长期记忆候选提取器。
只根据用户消息提取以后可能有用的稳定事实、偏好或约定。
只输出严格 JSON 数组，不要 Markdown，不要解释，不要输出思考过程。
每项格式为：
{"scope":"OWNER|MEMBER|GROUP","content":"记忆内容"}
scope 只能是 OWNER、MEMBER、GROUP。没有合适内容时输出 []。
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
      messages.map((message) => `[${message.speakerLabel} | ${message.role}]\n${MemoryText.forModel(message.content)}`).join('\n')

    const response = await this.complete(EXTRACTOR_PROMPT, input, deadline, msgIdToken)
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
      const candidate = entry as { scope?: unknown; content?: unknown }
      if (typeof candidate.scope !== 'string' || typeof candidate.content !== 'string') {
        continue
      }

      const scope = candidate.scope.toUpperCase() as MemoryScopeType
      const content = MemoryText.normalize(candidate.content)
      if (!SCOPES.includes(scope) || content.length === 0) {
        continue
      }

      candidates.push({ scopeType: scope, content })
    }

    return candidates
  }
}
