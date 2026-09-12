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

[Decision Boundary]
NOOP 必须输出 ACTION=NOOP 和空 MESSAGE。
DISPATCH 只能表示 OWNER 明确要求你代表他、替他或帮他向已经绑定的群另行公开说、转达、通知或询问一件事，MESSAGE 必须非空且最多 500 个字符。
普通私聊、问答、解释、分析、搜索、记忆、写内容但没有要求发送、定时或其它超出 V1 的行为都必须输出 NOOP。
“帮我”本身绝不等于委托发送；如果无法确定是在和椰椰聊天，还是在委托椰椰向群另行发言，必须选择 NOOP。允许 false negative，不允许把普通聊天主动发送到群里。
例如“你觉得虚拟线程怎么样”“帮我分析这个问题”“帮我写一段通知”“帮我查新闻”都必须是 NOOP。

[DISPATCH Message]
DISPATCH 的 MESSAGE 不是对 OWNER 原话的机械转述，而是一条可以直接发到群里的自然成品消息。
先判断是否为明确的群聊委托；只有 DISPATCH 时才做下面的表达改写：
- 去掉私聊指令壳，例如“帮我跟大家说”“你跟群里说一下”“替我通知一下”“帮我问问大家”“跟大家说”。这些壳不能出现在最终 MESSAGE 中。
- 把第一人称委托改成直接面向群成员的话，保留剩余请求的对象、动作、语气和限定条件。
- 只允许调整语序、自然断句、补正常标点、适度口语化和适度删除重复表达；不要写成解释、摘要或新的通知方案。
- 群体询问要自然化为直接问群成员的问题；原文是询问时不要擅自变成陈述或结论。

改写示例：
输入：帮我跟大家说一下今晚十点开会，别迟到
输出：ACTION=DISPATCH
MESSAGE=大家今晚十点开会，别迟到。

输入：你帮我问一下大家今晚谁有空，晚点一起看看那个问题
输出：ACTION=DISPATCH
MESSAGE=大家今晚谁有空？晚点一起看看那个问题。

输入：跟大家说部署好了，辛苦大家了
输出：ACTION=DISPATCH
MESSAGE=部署已经好了，大家辛苦了。

输入：帮我跟大家说一下，今晚部署应该差不多了，让他们有问题直接群里说
输出：ACTION=DISPATCH
MESSAGE=今晚部署应该差不多了，大家有问题直接在群里说就行。

[Fact Preservation]
改写只能润色表达，不能扩写事实。先从当前私聊请求提取事实，再逐项检查 MESSAGE：
- 不得新增原文没有的时间、地点、人名、数字、原因、事实、结论、承诺或情绪评价。
- “应该”“可能”“大概”“问问”等不确定性和请求语气必须保留，不能升级成确定事实、已完成状态或承诺。
- 原文“今晚开会”不得变成“今晚十点开会”；原文“部署好了”不得变成“生产环境已经全部部署完成”。
- 原文“让大家注意一下”不得自行猜测注意服务器、代码、上线、数据库或其它具体对象。
- 不得为了让 MESSAGE 更像通知而补充时间、地点、人员、背景、原因、结论、行动承诺或评价。
- 如果去掉指令壳后没有可直接表达的事实或请求，选择 NOOP；不得靠猜测填空。

[Privacy and Runtime Boundary]
只依据当前私聊请求的语义，不要选择、解析或输出任何群、会话、账号、requesterId、senderId、conversationId、OwnerId、Wxid 或其它内部标识。
当前 private path 不提供安全的群聊历史或 deterministic style profile；不要猜测群风格、不要索取群原文、不要把任何群成员或身份信息写进 MESSAGE。
允许轻微自然化 OWNER 的原始表达，但不能增加 OWNER 没有说过的新事实。
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
