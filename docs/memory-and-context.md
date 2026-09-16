# Memory and Context

本项目有多种“记忆”形态。它们的生命周期、可见范围和可信度不同，不能混称为一个 Memory。

## 分层模型

| 层 | 范围 | 内容 | 生命周期/预算 | 是否持久化 | 可信度与用途 |
| --- | --- | --- | --- | --- | --- |
| Current turn | 当前请求 | 当前消息及其受信结构化字段 | 单次请求 | 否 | 由 runtime contract 提供，参与当前请求 |
| `REQUESTER_LOCAL` | `(groupConversationId, requesterId)` | 同一 GROUP、同一请求者的近期事件 | 默认 30 分钟、50 条、8000 字符 | 否 | 只作为当前请求者上下文，不是身份授权 |
| `GROUP_AMBIENT` | GROUP | 群内公共消息和已 `SENT` 的 assistant 消息 | 默认 30 分钟、30 条、4000 字符 | 否 | 公共但不可信；用于群聊连续性 |
| `TOPIC_CAPSULE` | GROUP | 旧 ambient 的有限主题压缩 | 默认 24 小时；每群最多 8 个，单次最多取 3 个、总 2400 字符 | 否 | 低优先级、不含个人归属证明 |
| Persistent Memory | OWNER/MEMBER/GROUP scope | 经过规则允许的偏好、事实或显式记忆 | JSON 文件；由 scope、软删除和代码预算约束 | 是 | 可被检索的应用数据，不是身份源/授权源 |
| Legacy `GroupContext` | GROUP 进程内 | legacy Wechaty 路径的短期 transcript | 默认最多 100 条并受字符预算限制 | 否 | 旧入口使用的短期上下文 |

生产 GROUP provider view 的顺序是：当前请求 > requester-local > recent ambient > topic capsule。后层不能覆盖前层的当前请求者归属，也不能提升为 trusted identity。

## 请求者隔离

`REQUESTER_LOCAL` 由 group conversation 和 requester identity 共同限定。一个成员的本地上下文不会因为处于同一个群而展示给另一个成员；当前请求者 active path 之外的 requester-local 只作为隔离统计，不作为回答上下文。

`GROUP_AMBIENT` 可以被同群请求共享，因为它表达的是公共群聊历史；但其中的消息仍然是 untrusted content。助手消息只有在外部 runtime 确认真实发送成功后才写入 ambient，生成但未发送的文本不会进入 ambient。

## Persistent Memory 规则

- 存储默认位于 `%LOCALAPPDATA%\WeChatAgent\memory\memory.json`，可由 `WECHAT_MEMORY_PATH` 覆盖；文件写入使用原子替换。
- scope 包含 `OWNER`、`MEMBER`、`GROUP`，并带有 visibility、origin、kind、subject 和软删除状态。
- active GROUP 请求会先做确定性 scope/visibility/授权，再在固定预算内取 working set；最终模型负责在已授权集合中判断相关性。
- passive context path 不读写、不抽取 Persistent Memory。直接私聊由于身份未验证，也不会启用普通 Memory 处理。
- 自动抽取只来自符合条件的 active GROUP 观察消息；显式记忆语法要求高精度的 owner mention 和用户内容 span。
- 原始身份标记、路径和其他内部字段不会作为 Memory 内容写入；Memory 内容也不能反向授予 owner 权限。

## 一个请求的简化例子

假设成员 A 在群里提及 bot：

1. 当前请求放入 `currentTurn`。
2. 只读取 `(这个群, A)` 的 `REQUESTER_LOCAL`。
3. 读取这个群公共的 `GROUP_AMBIENT` 和低优先级 `TOPIC_CAPSULE`。
4. 按确定性规则筛选可见的 Persistent Memory，交给唯一的最终 Chat turn。
5. 生成答案并等待外部发送端的 `SENT` ACK；未收到成功 ACK 前不把答案加入群上下文。

成员 B 的 requester-local 不会因为 B 也在这个群里而被带入 A 的回答。任何层都不能替代外部 runtime 对 sender/requester/mention 的可信证明。

## 数据保护

Memory JSON、日志、`.env`、debug dump、screenshots 和运行时导出物都应视为本地私人数据。`.gitignore` 已覆盖常见运行目录、日志、临时文件、dump、IDE 配置和 `.local`；发布前仍应执行 Git 追踪清单审计。
