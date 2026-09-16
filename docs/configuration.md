# Configuration

程序通过仓库根目录的 `.env` 读取环境变量。`.env.example` 只放示例值；真实 key、token、salt、日志和 Memory 路径不得提交。没有 `.env` 也可以运行构建和测试。

表格中的“必填”表示：`否`=使用默认值即可，`条件`=只有启用对应入口/能力时需要，“是”=启动该模式前必须提供。敏感性是对配置值的判断，不是变量名本身的授权。

## LLM 与运行模式

| 变量 | 必填 | 默认值 | 作用 | 敏感性 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `BOT_MODE` | 否 | `smoke` | 选择 `smoke` 或 `chat` | 普通 | 其他值会拒绝启动 |
| `WECHATY_PUPPET` | 否 | `xp` | legacy Wechaty 入口的 Puppet | 普通 | 当前 legacy 路径使用 Puppet XP |
| `BOT_DISPLAY_NAME` | 否 | `椰椰` | 助手展示名 | 普通 | 不是权限来源 |
| `OPENAI_API_BASE` | 条件 | 空 | OpenAI-compatible endpoint | 地址 | `chat`/production `real` 需要 |
| `OPENAI_API_KEY` | 条件 | 空 | provider credential | Secret | 只从本地环境变量提供 |
| `OPENAI_MODEL` | 条件 | 空 | provider model 名称 | 普通 | `chat`/production `real` 需要 |
| `AGENT_REQUEST_DEADLINE_MS` | 否 | `50000` | 单次主动请求期限 | 运行参数 | 必须为正整数 |
| `AGENT_TIME_ZONE` | 否 | 空 | runtime time grounding 时区 | 环境信息 | 空值使用宿主机时区 |

`BOT_MODE=chat` 的 legacy 入口需要三个 `OPENAI_*` 值。production receiver 的 `real` 模式同样需要它们；`fake` 模式和 smoke/test 不需要真实 provider 凭据。

## Context

这些变量控制进程内上下文，不会把聊天记录变成 Persistent Memory。

| 变量 | 必填 | 默认值 | 作用 | 敏感性 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `CONTEXT_MESSAGE_LIMIT` | 否 | `50` | legacy recent context 条数 | 普通 | 正整数；非法值回退 |
| `MAX_CONTEXT_MESSAGES` | 否 | `100` | 通用 context window 条数 | 普通 | 正整数；非法值回退 |
| `MAX_CONTEXT_CHARS` | 否 | `12000` | 通用 context window 字符上限 | 普通 | 正整数；非法值回退 |
| `GROUP_AMBIENT_MAX_ENTRIES` | 否 | `30` | GROUP 公共 ambient 条数 | 普通 | process-local |
| `GROUP_AMBIENT_TTL_MINUTES` | 否 | `30` | ambient TTL | 普通 | 分钟 |
| `GROUP_AMBIENT_MAX_CHARS` | 否 | `4000` | ambient 字符上限 | 普通 | process-local |
| `GROUP_REQUESTER_LOCAL_MAX_ENTRIES` | 否 | `50` | requester-local 条数 | 普通 | 按 group/requester 隔离 |
| `GROUP_REQUESTER_LOCAL_TTL_MINUTES` | 否 | `30` | requester-local TTL | 普通 | 分钟 |
| `GROUP_REQUESTER_LOCAL_MAX_CHARS` | 否 | `8000` | requester-local 字符上限 | 普通 | 按 group/requester 隔离 |

## Topic Capsule

Topic capsule 是进程内、低优先级的 GROUP ambient 压缩结果，不是持久 Memory，也不能证明个人归属。它只在真实 GROUP `SENT` ACK 后异步触发。

| 变量 | 必填 | 默认值 | 作用 | 敏感性 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `GROUP_TOPIC_CAPSULE_ENABLED` | 否 | `1` | 启用 topic capsule | 普通 | `0` 关闭 |
| `GROUP_TOPIC_CAPSULE_TRIGGER_EVENT_COUNT` | 否 | `8` | 事件量触发阈值 | 普通 | 正整数 |
| `GROUP_TOPIC_CAPSULE_TRIGGER_CHAR_COUNT` | 否 | `1200` | 字符量触发阈值 | 普通 | 正整数 |
| `GROUP_TOPIC_CAPSULE_MAX_PER_GROUP` | 否 | `8` | 每群 capsule 数量上限 | 普通 | process-local |
| `GROUP_TOPIC_CAPSULE_TTL_HOURS` | 否 | `24` | capsule TTL | 普通 | 小时 |
| `GROUP_TOPIC_CAPSULE_MAX_SELECTED` | 否 | `3` | 单次选取数量上限 | 普通 | 正整数 |
| `GROUP_TOPIC_CAPSULE_SUMMARY_MAX_CHARS` | 否 | `800` | 单条摘要字数上限 | 普通 | 正整数 |
| `GROUP_TOPIC_CAPSULE_MAX_CHARS` | 否 | `2400` | capsule 总字符上限 | 普通 | 正整数 |
| `GROUP_TOPIC_CAPSULE_RECENT_RAW_ENTRIES` | 否 | `8` | 压缩时保留的近期原始条数 | 普通 | 正整数 |
| `GROUP_TOPIC_CAPSULE_RECENT_RAW_CHARS` | 否 | `2000` | 压缩时保留的近期原始字符数 | 普通 | 正整数 |
| `GROUP_TOPIC_CAPSULE_COMPACTION_TIMEOUT_MS` | 否 | `3000` | 压缩调用期限 | 运行参数 | 毫秒 |

## Memory

| 变量 | 必填 | 默认值 | 作用 | 敏感性 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `WECHAT_MEMORY_ENABLED` | 否 | `1` | 启用 Persistent Memory | 普通 | `0` 关闭 |
| `WECHAT_MEMORY_PATH` | 否 | `%LOCALAPPDATA%\WeChatAgent\memory\memory.json` | 指定 Memory JSON 文件或目录 | 本地路径 | 相对路径按当前工作目录解析 |
| `MEMORY_BACKGROUND_TIMEOUT_MS` | 否 | `8000` | 后台自动抽取期限 | 运行参数 | 毫秒 |

Memory 文件是单个 JSON 文档，代码使用原子临时文件写入与 rename；损坏文件会停用并原样保留。active GROUP 请求才会按 scope/visibility/授权处理普通 Memory；passive path 不读写、不抽取。

## Web Search

| 变量 | 必填 | 默认值 | 作用 | 敏感性 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `WEB_SEARCH_ENABLED` | 否 | `0` | Search 总开关 | 普通 | 默认关闭 |
| `WEB_SEARCH_PROVIDER` | 否 | `tavily` | provider 配置名 | 普通 | 当前校验只接受 `tavily` |
| `TAVILY_API_BASE` | 条件 | 空 | Tavily API 地址 | 地址 | 启用 Search 且无可用 SearXNG 时需要 |
| `TAVILY_API_KEY` | 条件 | 空 | Tavily credential | Secret | 只从环境变量提供 |
| `SEARXNG_ENABLED` | 条件 | `0` | 启用 SearXNG 路线 | 普通 | 需要配合地址 |
| `SEARXNG_API_BASE` | 条件 | `http://127.0.0.1:8088` | SearXNG 地址 | 地址 | 示例地址；仓库不会启动服务 |
| `SEARXNG_ENGINES` | 否 | `360search,sogou` | SearXNG engines | 普通 | 逗号分隔 |
| `WEB_SEARCH_MAX_RESULTS` | 否 | `5` | provider 结果上限 | 普通 | 正整数 |
| `WEB_SEARCH_TIMEOUT_MS` | 否 | `8000` | Search 超时 | 运行参数 | 毫秒 |
| `WEB_SEARCH_MAX_CONTEXT_CHARS` | 否 | `6000` | Search 上下文预算 | 普通 | 字符 |
| `WEB_PAGE_FETCH_ENABLED` | 否 | `1` | 启用网页证据抓取 | 普通 | 仍受 URL 安全检查 |
| `WEB_PAGE_FETCH_MAX_RESULTS` | 否 | `2` | 最多抓取结果数 | 普通 | 代码还会限制在 3 以内 |
| `WEB_PAGE_FETCH_TIMEOUT_MS` | 否 | `4000` | 单页抓取超时 | 运行参数 | 毫秒 |
| `WEB_PAGE_FETCH_MAX_CHARS_PER_PAGE` | 否 | `4000` | 单页文本预算 | 普通 | 字符 |
| `WEB_PAGE_FETCH_MAX_TOTAL_CHARS` | 否 | `6000` | 全部网页证据预算 | 普通 | 字符 |

启用 Search 时必须提供可用的 Tavily 配置，或同时启用并配置 SearXNG。搜索结果属于不可信外部内容，不能改变身份、owner、Memory 可见性或发送授权。详见 [docs/web-search.md](web-search.md)。

## Logging

| 变量 | 必填 | 默认值 | 作用 | 敏感性 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `WECHAT_LOG_PATH` | 否 | `%LOCALAPPDATA%\WeChatAgent\logs` | 指定持久日志目录 | 本地路径 | 日志只承载诊断元数据 |
| `WECHAT_LOG_TOKEN_SALT` | 否 | 空 | 跨进程 token 关联 salt | Secret-like | 共享时必须在受控环境配置；不会写入日志 |

日志默认按天/大小轮转。日志失败不会中断对话，但日志文件仍可能包含 token、计数、枚举和错误码等操作元数据，应按私人运行数据保护。

## Diagnostics

| 变量 | 必填 | 默认值 | 作用 | 敏感性 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `WECHAT_IDENTITY_OBSERVE` | 否 | `0` | 开启身份观测 token 日志 | 普通开关 | `1` 只观测，不授权；由 identity observer 模块读取 |

## 配置修改检查

新增变量时应同时更新 `src/config.ts`、`.env.example`、本文件和相关测试。日志/身份观测变量由各自模块读取，不要因为它们不在 `config.ts` 就遗漏审计。不要把实际值写入 README、issue、截图、测试 fixture 或 release archive。
