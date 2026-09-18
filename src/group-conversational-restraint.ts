/**
 * Deterministic GROUP conversational restraint classifier.
 *
 * Social Output Boundary decides how much a GROUP reply may weigh; this module
 * decides how much the current turn should try to carry at all. The judgement is
 * deliberately narrow: it reads only the current message plus already-authorized
 * context lines, never profiles, memory or history preferences, so a stored
 * "以后回答详细一点" can never turn a bare "哈哈" into a detailed task.
 * It is a prompt-side behaviour policy plus one conservative CTA backstop; it
 * never replaces the hard boundaries in chat-renderer.ts.
 */

export type GroupConversationalMode = 'SOCIAL_LIGHT' | 'TASK_NORMAL' | 'TASK_DETAILED'

export type GroupContinuationResolution = 'NONE' | 'UNIQUE' | 'AMBIGUOUS'

export interface GroupConversationalRestraint {
  mode: GroupConversationalMode
  continuation: GroupContinuationResolution
  /** The mode is derived from the current turn only; the field documents that. */
  currentIntentSource: 'CURRENT_TURN'
}

export interface GroupConversationalRestraintInput {
  questionText: string
  /** Already-authorized recent context lines (active turns, ambient, capsule). */
  recentContextTexts?: readonly (string | undefined | null)[]
}

/**
 * How many trailing context lines feed the continuation scan. The scan is a
 * bounded keyword observation, not a semantic model of the conversation.
 */
export const GROUP_CONVERSATIONAL_RESTRAINT_CONTEXT_LINE_LIMIT = 32

/**
 * Prompt-side behaviour policy. Static text on purpose: it belongs to the
 * stable prompt prefix shared by the final answer and every regeneration path.
 */
export const GROUP_CONVERSATIONAL_RESTRAINT_RULES = `[GROUP Conversational Restraint]
群聊里你是参与者，不是主持人、导演、裁判或任务分配中心；未经请求不要接管话题。
- 先回答当前 requester 本轮明确问的内容。轻互动（哈哈、表情、“摸摸你”“亲亲”“你可爱”“我呢”这类）保持 1～3 句的轻量回应；可以接梗、吐槽或简短角色扮演，但不要主动扩展成新章节、新世界观、新人物设定、新任务或多步骤计划。
- One Request → One Requested Unit：用户明确要多少，就做多少。“第二章”“再来一个”“再举个例子”“再写一段”“给我安排个角色”只完成当前这一个 unit；不要主动预告下一章、安排后续剧情、追加新角色，也不要问“要不要继续”。用户想要更多会自己再发起。
- 未经请求不要替其他成员分配角色、安排剧情或扩大到全群范围；当前 requester 问“我呢”就只答当前 requester；只有用户明确要求“给群里所有人安排角色”时才扩大范围。
- 未经请求不要主动 CTA：“要不要我继续？”“需要的话我还能……”“想看的话我再……”“要不要第三章？”不作为收尾；任务完成就收住，只有缺少必要信息、不澄清就无法完成当前请求时才问一句。
- 模糊的“继续/接着/下一步”只有在最近上下文有唯一明确主题时才继续一个 bounded unit；存在多个可能方向时，短问一句“继续哪一个？”再动手，不要自行选最戏剧化的方向。
- 不要因为历史偏好或 Member Interaction Profile 里出现过“喜欢详细”就把本轮轻互动升级成长篇；当前消息意图优先于历史偏好。
- 创作和角色扮演不是禁区：用户明确要求的章节、故事、角色设定、搞笑小剧场认真完成，只是范围以当前请求为准，做完即收。
- 这只约束行为范围，不约束正确性：技术任务、必要解释、必要代码和搜索照常完成；GROUP_BULK_OUTPUT_RULES 与 GROUP_SOCIAL_OUTPUT_RULES 仍是硬边界。`

/** Current-turn wording that explicitly asks for an expanded, detailed answer. */
const DETAIL_REQUEST_PATTERN =
  /详细(?:点|一点|解释|讲解|讲讲|说说|分析|介绍|展开|说明|聊聊|写|对比|讲|说)|展开(?:讲|说|写|分析|聊聊)|系统(?:分析|讲|梳理|介绍)|完整对比|全面对比|对比分析|逐步分析|一步步(?:分析|讲|解释)|深入(?:分析|讲|探讨|聊聊)|细细(?:讲|说)|越详细越好|讲(?:得|的)越(?:细|清楚)|解释清楚|讲清楚|多讲(?:一点|些)|仔细讲|完整(?:地)?(?:写|讲|说)出/u

/** Current-turn markers of an actual question, task or information request. */
const TASK_HINT_PATTERN =
  /什么|怎么|怎样|咋|为啥|为何|如何|多少|几个|几点|几条|帮我|帮忙|给我|写|编|画|翻译|解释|分析|总结|对比|查|搜|找|看看|实现|报错|错误|异常|崩溃|代码|函数|方法|接口|部署|服务器|数据库|编译|安装|配置|环境|教程|步骤|思路|方案|建议|推荐|比较|区别|优缺点|原因|原理|概念|定义|意思|列出|清单|检查|修复|调试|计算|算|价格|地址|时间|天气|新闻|哪|谁/u

/** Short interaction cues: reactions, banter, affection, light RolePlay beats. */
const SOCIAL_LIGHT_CUE_PATTERN =
  /哈哈|嘿嘿|嘻嘻|嘿哟|笑死|笑不活|乐死|笑喷|绝了|好家伙|服了|无语|牛哇|牛啊|牛逼|太牛|厉害|摸摸|摸头|拍拍|抱抱|举高高|亲亲|贴贴|蹭蹭|可爱|我呢|那我呢|还有我|同感|加一|\+1|收到|了解了|懂了|明白了|学到了|好耶|呜呜|nb|NB|666|六六六|233/u

const EXACT_SOCIAL_LIGHT_TEXTS: ReadonlySet<string> = new Set([
  '6', '66', '666', '6666', '233', '2333', '23333', '+1',
  '？', '？？', '？？？', '?', '??', '???', '！', '!!', '!!!', '。', '...', '。。。', '～', '~',
])

/** "第N章" style cues anchor the continuation to a story thread by themselves. */
const STORY_CONTINUATION_CUE_PATTERN =
  /第[一二三四五六七八九十百千两\d]+章|下一章|再来一章|下一话|下一节|下一回|番外|后续剧情/u

/**
 * Whole-message continuation cues. Only a message that is essentially just the
 * cue counts: "继续教育是什么" is a question, not a continuation request.
 */
const GENERIC_CONTINUATION_CUE_PATTERN =
  /^(?:继续|接着|然后呢|然后咋|后面呢|下一步|再来|再举|再写|再讲|再画|再来一个|再来一份|再举一个|再写一段|再讲一段|下一个|来|搞|整|走起|来来来)(?:一个|一份|点|次|段|篇|话)?(?:呀|啊|呗|吧|咯|哟|哦|噢|嗷)*$/u

const EXACT_CONTINUATION_TEXTS: ReadonlySet<string> = new Set(['来', '搞', '整', '走起', '来来来', '搞起', '整起'])

/** Evidence that the recent context carries a story/roleplay thread. */
const STORY_EVIDENCE_PATTERN =
  /第[一二三四五六七八九十百千两\d]+章|下一章|上一章|故事|剧情|小说|番外|小剧场|连载|章节|角色|人设|世界观|主角|配角|NPC|大纲|结局|开头|写书/u

/** Evidence that the recent context carries a technical thread. */
const TECH_EVIDENCE_PATTERN =
  /代码|报错|bug|异常|堆栈|stack trace|error|exception|函数|接口|api|部署|服务器|数据库|sql|编译|构建|依赖|npm|git|正则|算法|并发|线程|内存|框架|终端|命令行|脚本|配置|环境变量|docker|linux|python|java|typescript|javascript|node|前端|后端|程序|开发|调试|langgraph|checkpoint|训练|推理|模型/iu

/**
 * Trailing active-CTA sentences that a light reply must not carry. The backstop
 * strips at most the final plain sentence and only on an exact-ish phrase match.
 */
const GROUP_CTA_TAIL_PATTERNS: readonly RegExp[] = [
  /要不要我(?:继续|接着|再|展开|补充|更新|往下)/u,
  /要不要(?:第三章|第四章|下一章|续集|再来一段|再来一个|下一个)/u,
  /需要的话我/u,
  /想(?:看|听|聊|要)的话我?/u,
  /我可以继续给你/u,
  /我(?:还|再|能|可以)(?:继续|接着)?给你写/u,
  /还想(?:要|听|看)(?:更多|吗)/u,
  /想(?:听|看)后续/u,
]

const SOCIAL_LIGHT_MAX_CODE_POINTS = 16
const GROUP_CTA_TAIL_MAX_CHARS = 60
const CTA_SENTENCE_END_PATTERN = /[。！？!?；;…\n]/u

/**
 * Classify the current GROUP message. The decision is intentionally biased
 * against tightening: anything task-shaped stays TASK_NORMAL, and only the
 * current turn's own wording can produce SOCIAL_LIGHT or TASK_DETAILED.
 */
export function resolveGroupConversationalRestraint(
  input: GroupConversationalRestraintInput,
): GroupConversationalRestraint {
  const raw = input.questionText.trim()
  const compact = raw.replace(/\s+/gu, '')
  const cue = matchContinuationCue(compact)
  const continuation = resolveContinuation(cue, input.recentContextTexts)

  if (DETAIL_REQUEST_PATTERN.test(compact)) {
    return { mode: 'TASK_DETAILED', continuation, currentIntentSource: 'CURRENT_TURN' }
  }
  if (cue !== 'NONE') {
    // A continuation request is a task for exactly one bounded unit.
    return { mode: 'TASK_NORMAL', continuation, currentIntentSource: 'CURRENT_TURN' }
  }
  if (TASK_HINT_PATTERN.test(compact)) {
    return { mode: 'TASK_NORMAL', continuation, currentIntentSource: 'CURRENT_TURN' }
  }
  if (isSocialLight(compact)) {
    return { mode: 'SOCIAL_LIGHT', continuation, currentIntentSource: 'CURRENT_TURN' }
  }
  return { mode: 'TASK_NORMAL', continuation, currentIntentSource: 'CURRENT_TURN' }
}

/**
 * The single GROUP depth decision for the current turn. The historical member
 * profile deliberately does not participate: it may keep shaping the other
 * presentation hints, but current-turn intent alone converges the reply depth
 * (and with it the social budget tier) so a stored "喜欢详细" can never turn
 * "哈哈" into a DETAILED 900-char turn, and "详细解释" always reaches DETAILED
 * even for a historically SHORT member.
 */
export function resolveEffectiveGroupResponseDepth(
  mode: GroupConversationalMode,
): 'SHORT' | 'NORMAL' | 'DETAILED' {
  switch (mode) {
    case 'SOCIAL_LIGHT':
      return 'SHORT'
    case 'TASK_DETAILED':
      return 'DETAILED'
    default:
      return 'NORMAL'
  }
}

/**
 * Conservative trailing-CTA removal for SOCIAL_LIGHT finals. At most the last
 * plain sentence is dropped, never quoted or code-bearing content, never the
 * whole reply, and only on a fixed phrase match.
 */
export function stripTrailingGroupCta(text: string): string {
  const trimmedEnd = text.trimEnd()
  if (trimmedEnd.length === 0) {
    return text
  }
  // Never touch text that ends inside (or is) a fenced code block.
  if (((trimmedEnd.match(/```/gu) ?? []).length % 2) === 1) {
    return text
  }
  const start = findLastSentenceStart(trimmedEnd)
  if (start <= 0) {
    // A single-sentence reply is never rewritten, even when it looks like a CTA.
    return text
  }
  const tail = trimmedEnd.slice(start)
  if (tail.length > GROUP_CTA_TAIL_MAX_CHARS) {
    return text
  }
  if (/[`「」『』“”"'（）()]/u.test(tail) || /^[-*>]/u.test(tail)) {
    return text
  }
  if (!GROUP_CTA_TAIL_PATTERNS.some((pattern) => pattern.test(tail))) {
    return text
  }
  const remaining = trimmedEnd.slice(0, start).trimEnd()
  if (remaining.length === 0) {
    return text
  }
  return remaining
}

/** Provider-facing deterministic facts for the current turn. */
export function formatGroupConversationalRestraintSection(
  restraint: GroupConversationalRestraint,
  depths: {
    profileResponseDepth: 'SHORT' | 'NORMAL' | 'DETAILED' | undefined
    effectiveResponseDepth: 'SHORT' | 'NORMAL' | 'DETAILED'
  } | undefined,
): string {
  const continuationLine = restraint.continuation === 'AMBIGUOUS'
    ? '\n- continuation=AMBIGUOUS：最近上下文存在多个可能方向，先短问一句澄清再动手，不要自行选择。'
    : restraint.continuation === 'UNIQUE'
      ? '\n- continuation=UNIQUE：可以继续一个 bounded unit，完成后收住，不预告后续。'
      : ''
  const depthLines = depths === undefined
    ? ''
    : `\nprofileResponseDepth=${depths.profileResponseDepth ?? 'NONE'}` +
      `\neffectiveResponseDepth=${depths.effectiveResponseDepth}` +
      '\n- 当前群聊轮次的回复深度与 Social 边界档位以 effectiveResponseDepth 为准：profileResponseDepth 只是历史 presentation hint，不能把本轮升级为 DETAILED，也不能压过当前消息意图。'
  return '\n\n[Group Conversational Restraint: TRUSTED_RUNTIME_FACT]\n' +
    `mode=${restraint.mode}\n` +
    `continuation=${restraint.continuation}\n` +
    `currentIntentSource=${restraint.currentIntentSource}` +
    depthLines +
    '\n- mode 由当前消息确定性判定，历史偏好与 Member Interaction Profile 不参与：SOCIAL_LIGHT=轻互动，回应保持 1～3 句；TASK_NORMAL=按当前请求完成一个明确 unit；TASK_DETAILED=当前消息明确要求详细展开。' +
    continuationLine
}

type ContinuationCue = 'NONE' | 'UNIQUE_STORY' | 'GENERIC'

function matchContinuationCue(compact: string): ContinuationCue {
  const stripped = compact.replace(/[。.!！?？~～、,，]+$/u, '')
  if (STORY_CONTINUATION_CUE_PATTERN.test(stripped)) {
    return 'UNIQUE_STORY'
  }
  if (GENERIC_CONTINUATION_CUE_PATTERN.test(stripped) || EXACT_CONTINUATION_TEXTS.has(stripped)) {
    return 'GENERIC'
  }
  return 'NONE'
}

function resolveContinuation(
  cue: ContinuationCue,
  recentContextTexts: readonly (string | undefined | null)[] | undefined,
): GroupContinuationResolution {
  if (cue === 'NONE') {
    return 'NONE'
  }
  const contextTexts = (recentContextTexts ?? [])
    .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
    .slice(-GROUP_CONVERSATIONAL_RESTRAINT_CONTEXT_LINE_LIMIT)
  // Fail closed: with nothing to anchor to, a bare cue cannot be proven unique.
  if (contextTexts.length === 0) {
    return 'AMBIGUOUS'
  }
  const story = contextTexts.some((text) => STORY_EVIDENCE_PATTERN.test(text))
  const tech = contextTexts.some((text) => TECH_EVIDENCE_PATTERN.test(text))
  if (cue === 'UNIQUE_STORY') {
    return story ? 'UNIQUE' : 'AMBIGUOUS'
  }
  return story && tech ? 'AMBIGUOUS' : 'UNIQUE'
}

function isSocialLight(compact: string): boolean {
  if (compact.length === 0) {
    return false
  }
  if (EXACT_SOCIAL_LIGHT_TEXTS.has(compact)) {
    return true
  }
  if (codePointLength(compact) > SOCIAL_LIGHT_MAX_CODE_POINTS) {
    return false
  }
  return SOCIAL_LIGHT_CUE_PATTERN.test(compact) || isEmojiOrPunctuationOnly(compact)
}

function isEmojiOrPunctuationOnly(text: string): boolean {
  return /^[\p{Extended_Pictographic}\p{Emoji_Component}\p{P}\p{S}]+$/u.test(text)
}

function codePointLength(text: string): number {
  return Array.from(text).length
}

function findLastSentenceStart(text: string): number {
  for (let index = text.length - 2; index >= 0; index -= 1) {
    if (CTA_SENTENCE_END_PATTERN.test(text[index] ?? '')) {
      return index + 1
    }
  }
  return 0
}
