import {
  detectProviderControlMarkup,
  ProviderControlMarkupError,
  sanitizeFinalAnswer,
} from './final-answer.js'

export type OwnerPrivateDispatchAction = 'NOOP' | 'DISPATCH'

export interface OwnerPrivateDispatchDecision {
  action: OwnerPrivateDispatchAction
  message: string | null
}

export type OwnerPrivateDispatchPlannerFailure =
  | 'INVALID_PROTOCOL'
  | 'IDENTITY_GUARD'
  | 'MESSAGE_UNSAFE'
  | 'MESSAGE_TOO_LONG'
  | 'COMPLETION_ERROR'
  | 'PROVIDER_CONTROL_MARKUP'

export interface OwnerPrivateDispatchPlannerResult {
  result: 'PASS' | 'FAIL'
  decision: OwnerPrivateDispatchDecision
  failureReason?: OwnerPrivateDispatchPlannerFailure
  attempts?: number
}

export interface OwnerPrivateDispatchPlannerLike {
  plan(question: string, forbiddenValues?: readonly string[]): Promise<OwnerPrivateDispatchPlannerResult>
}

export interface StructuredOwnerPrivateDispatchCompletion {
  (systemPrompt: string, userContent: string): Promise<string>
}

const PLANNER_SYSTEM_PROMPT = `你是 Owner Private Dispatch Planner，只负责判断已验证 OWNER 的 DIRECT 私聊请求是否应向已经绑定的 GROUP 另行发送一条消息。
你不拥有发送权限，运行时已经决定 OWNER 身份和 GROUP 目标；你只能输出下面固定的两行文本协议，绝对不要输出 JSON、Markdown 解释、最终答案或工具协议：
ACTION=NOOP 或 ACTION=DISPATCH
MESSAGE=<消息，可为空>

NOOP 必须输出 ACTION=NOOP 和空 MESSAGE。
DISPATCH 只能表示 OWNER 明确要求你代表他、替他或帮他向已经绑定的群另行公开说、转达、通知或询问一件事，MESSAGE 必须非空且最多 500 个字符。
普通私聊、问答、解释、分析、搜索、记忆、写内容但没有要求发送、定时或其它超出 V1 的行为都必须输出 NOOP。
“帮我”本身绝不等于委托发送；如果无法确定是在和椰椰聊天，还是在委托椰椰向群另行发言，必须选择 NOOP。允许 false negative，不允许把普通聊天主动发送到群里。
只依据当前私聊请求的语义，不要选择、解析或输出任何群、会话、账号、requesterId、senderId、conversationId、OwnerId、Wxid 或其它内部标识。
允许轻微自然化 OWNER 的原始表达，但不能增加 OWNER 没有说过的新事实、原因、地点、时间、身份或平台。
不得输出 <tool_call>、<invoke>、<|minimax|>、function_call、tool_calls、thinking markup 或其它 provider control markup。

严格只输出两行：
ACTION=...
MESSAGE=...`

const PLANNER_REPAIR_SYSTEM_PROMPT = `${PLANNER_SYSTEM_PROMPT}

上一轮输出格式错误。不要回答问题，不要调用工具，不要解释原因。严格只输出两行 ACTION=... 和 MESSAGE=...。`

function noopDecision(): OwnerPrivateDispatchDecision {
  return { action: 'NOOP', message: null }
}

function invalid(failureReason: OwnerPrivateDispatchPlannerFailure): {
  valid: false
  decision: OwnerPrivateDispatchDecision
  failureReason: OwnerPrivateDispatchPlannerFailure
} {
  return { valid: false, decision: noopDecision(), failureReason }
}

function containsInternalIdentity(value: string): boolean {
  return /(?:^|[^A-Z0-9_])(?:MEMBER|SPEAKER|AMBIENT_SPEAKER)_\d+(?:$|[^A-Z0-9_])|CURRENT_REQUESTER|ASSISTANT|CurrentSpeakerLabel|RequesterId|SenderId|ConversationId|OwnerId|Wxid/iu.test(value)
}

function unwrapProtocolFence(raw: string): string {
  const trimmed = raw.trim()
  const match = /^```(?:text)?\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed)
  return match?.[1] ?? trimmed
}

function unsafeMessage(message: string): boolean {
  const sanitized = sanitizeFinalAnswer(message)
  return sanitized.providerControlMarkup ||
    sanitized.removedBlocks > 0 ||
    sanitized.unterminatedTag ||
    sanitized.text !== message
}

export function parseOwnerPrivateDispatchProtocol(
  raw: string,
  forbiddenValues: readonly string[] = [],
): { valid: true; decision: OwnerPrivateDispatchDecision } | {
  valid: false
  decision: OwnerPrivateDispatchDecision
  failureReason: OwnerPrivateDispatchPlannerFailure
} {
  if (detectProviderControlMarkup(raw).providerControlMarkup) {
    return invalid('PROVIDER_CONTROL_MARKUP')
  }

  const lines = unwrapProtocolFence(raw).split(/\r\n|\n|\r/u)
  if (lines.length !== 2 ||
      (lines[0] !== 'ACTION=NOOP' && lines[0] !== 'ACTION=DISPATCH') ||
      !lines[1].startsWith('MESSAGE=')) {
    return invalid('INVALID_PROTOCOL')
  }

  const message = lines[1].slice('MESSAGE='.length).trim()
  if (lines[0] === 'ACTION=NOOP') {
    return message.length === 0
      ? { valid: true, decision: noopDecision() }
      : invalid('INVALID_PROTOCOL')
  }

  if (message.length === 0) return invalid('INVALID_PROTOCOL')
  if (message.length > 500) return invalid('MESSAGE_TOO_LONG')
  if (containsInternalIdentity(message) || forbiddenValues.some((value) => value.length > 0 && message.includes(value))) {
    return invalid('IDENTITY_GUARD')
  }
  if (unsafeMessage(message)) return invalid('MESSAGE_UNSAFE')
  return { valid: true, decision: { action: 'DISPATCH', message } }
}

export function formatOwnerPrivateDispatchProtocol(decision: OwnerPrivateDispatchDecision): string {
  return `ACTION=${decision.action}\nMESSAGE=${decision.message ?? ''}`
}

export function buildOwnerPrivateDispatchPlannerUserPrompt(question: string): string {
  return `[Canonical Private Owner Request]\n${question}`
}

export class OwnerPrivateDispatchPlanner implements OwnerPrivateDispatchPlannerLike {
  public constructor(private readonly completeStructured: StructuredOwnerPrivateDispatchCompletion) {}

  public async plan(
    question: string,
    forbiddenValues: readonly string[] = [],
  ): Promise<OwnerPrivateDispatchPlannerResult> {
    const userPrompt = buildOwnerPrivateDispatchPlannerUserPrompt(question)
    let failureReason: OwnerPrivateDispatchPlannerFailure = 'COMPLETION_ERROR'
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let raw: string
      try {
        raw = await this.completeStructured(
          attempt === 1 ? PLANNER_SYSTEM_PROMPT : PLANNER_REPAIR_SYSTEM_PROMPT,
          userPrompt,
        )
      } catch (error) {
        failureReason = error instanceof ProviderControlMarkupError
          ? 'PROVIDER_CONTROL_MARKUP'
          : 'COMPLETION_ERROR'
        if (attempt === 1) continue
        return { result: 'FAIL', decision: noopDecision(), failureReason, attempts: attempt }
      }

      const parsed = parseOwnerPrivateDispatchProtocol(raw, forbiddenValues)
      if (parsed.valid) {
        return { result: 'PASS', decision: parsed.decision, attempts: attempt }
      }
      failureReason = parsed.failureReason
      if (attempt === 2) {
        return { result: 'FAIL', decision: parsed.decision, failureReason, attempts: attempt }
      }
    }
    return { result: 'FAIL', decision: noopDecision(), failureReason, attempts: 2 }
  }
}
