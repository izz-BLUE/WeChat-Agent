# Runtime and Native Integration

本仓库是 Agent 端。生产链路中的 Windows 微信客户端、C# runtime、Native Hook/Bridge、pipe client 和实际发送端不在仓库中，因此这里记录的是接口边界与人工验收前提，而不是一个可独立运行的微信集成包。

## 传输方式

`src/production-agent-transport.ts` 使用 Windows Named Pipe：

```text
\\.\pipe\<pipe-name>
```

数据为单连接、按行分隔的 JSON。receiver 的启动参数是：

```text
production-agent-receiver <pipeName> [real|fake] [summaryPath] [maxMessages] [invalidOutboundMessageId]
```

`pipeName` 必填；mode 默认 `real`；`maxMessages` 必须是正整数。`fake` 只用于测试和协议演练，不能证明真实微信链路。

## 入站 contract

外部 runtime 必须提供消息类型、时间、正文及受信的身份/会话字段。GROUP 主动请求必须使用一致的 `senderId`/`requesterId`、会话标识、请求者角色和 owner 配置状态，并由可信 runtime 提供 `isMentioned=true` 才能通过 mention admission。`botMentionSpans` 和 `userContentSpan` 用于 canonical framing 与受保护副作用边界；某些普通 Chat 路径允许 `ABSENT` span，而 Memory mutation、Owner dispatch、passive 及其他受保护路径会要求更强的 span trust。以下只是字段形状示意，不是可用身份值：

```json
{
  "kind": "INBOUND_MESSAGE",
  "message": {
    "msgId": "<message-id>",
    "type": 1,
    "timestamp": 0,
    "conversationType": "GROUP",
    "conversationId": "<group-conversation-id>",
    "senderId": "<sender-id>",
    "requesterId": "<requester-id>",
    "publicDisplayName": "<room-scoped-display-name-or-null>",
    "publicDisplayNameSource": "ROOM_DATA",
    "requesterRole": "MEMBER",
    "ownerConfigured": false,
    "isMentioned": true,
    "content": "<user-content>",
    "signature": "<runtime-signature>"
  }
}
```

`publicDisplayName` 是可选的、按群成员记录提供的展示元数据；`publicDisplayNameSource=ROOM_DATA` 只表示它来自 room-scoped member record。某些合法 room record 只有 member identity 而没有 display field，此时必须发送 `publicDisplayName=null`、`publicDisplayNameSource=NONE`，Agent 不猜测、不跨群复用，也不改变 `(conversationId, requesterId)` 身份和 Memory scope。展示字段不参与 authorization。

这些字段必须由可信 runtime 产生。Agent 不接受通过昵称、消息正文、`wxid`、signature 模式或模型输出推导出来的权限结论。`PASSIVE_CONTEXT_ONLY` 只接受普通 GROUP 被动事件，不能附带 owner authority 字段；它不产生同步 direct reply。命中 Owner Alias Wake 时，Agent 可能异步生成独立的 proactive outbound，但这不属于当前 passive transport response。

## 出站与 ACK

主动请求可能得到 `OUTBOUND_COMMAND`、`NO_REPLY` 或 `ERROR`；被动请求得到 `CONTEXT_ACCEPTED` 或 `CONTEXT_NOT_ACCEPTED`。外部 runtime 负责实际发送 `OUTBOUND_COMMAND`，再回传：

```json
{
  "kind": "OUTBOUND_DELIVERY_ACK",
  "outboundId": "<outbound-id>",
  "requestMessageId": "<message-id>",
  "status": "SENT",
  "contentSha256": "<sha256-of-sent-content>"
}
```

合法 ACK 必须匹配 pending outbound、request message 和内容哈希。`SENT` 才会提交 assistant ambient；`FAILED` 会丢弃待发送状态。重复、未知、过期、字段不匹配或哈希错误的 ACK 会被拒绝。ACK 不会触发新的 LLM、Memory 或 Search 工作。

外部 runtime 还可以发送 `PROACTIVE_OUTBOUND_POLL` 读取 owner alias wake 产生的有限 proactive command；取出的 command 仍必须经过同一发送与 ACK 责任边界。

## 外部 runtime 的责任

- 管理微信客户端、Native/Hook/Bridge 的生命周期和权限。
- 以可信来源填充契约中的身份、会话、mention 和 user-content span。
- 建立 Named Pipe、处理 JSONL framing、发送入站事件并消费 Agent 响应。
- 负责真实发送、返回 `SENT`/`FAILED` ACK，并处理重复投递、断线、升级和恢复。
- 在实际部署中保护原始消息、身份映射、日志、Memory 和 provider credentials。

本仓库不提供自动启动、关闭、重启、注入或真实发送操作。任何需要这些动作的验收都必须由用户人工完成。

## 已知限制

源码没有绑定特定微信版本或 Native build 的兼容矩阵，也没有在仓库内携带 C# / Native 实现。群 display name 只在外部 runtime 找到同一 room-scoped member record 的 display field 时可用；identity-only record 会保持 null。因而公开发布时只能声称“提供 Agent 与 wire contract”，不能声称“所有群成员昵称都可解析”、“开箱即用支持某个微信版本”或“已完成真实生产链路验证”。
