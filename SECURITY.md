# Security Policy

## 当前状态

本仓库目前没有公开声明的支持版本或安全响应 SLA。它是 Agent 层代码，不包含微信 Native Hook、C# runtime、Bridge 或生产发送端；外部组件的漏洞需要同时通知其维护者。

## 请不要公开提交

- API key、token、salt、cookie、私钥或 provider 原始响应；
- 微信账号、群、成员、owner 映射、内部 ID、signature 或原始消息正文；
- `%LOCALAPPDATA%` 下的 Memory、日志、崩溃 dump、截图或运行时导出；
- Named Pipe 配置、部署凭据和可用于控制外部发送端的操作细节。

提交 issue 前请去除真实身份和原始 payload，使用 synthetic placeholder。日志设计只允许 token、计数、枚举和错误码等诊断元数据；不要为了复现问题临时打印完整 prompt、Memory 或群聊内容。

## 报告方式

如果问题可能导致越权回复、身份泄露、Memory 越界、SSRF、密钥泄露或错误发送，请不要先公开完整细节。优先通过仓库维护者可用的私下渠道报告；如果尚未配置私下渠道，请先提交不含敏感细节的 issue，说明需要私下沟通，并只提供最小复现类别。

报告应包含：受影响的模块/版本、可重复的 synthetic 步骤、预期与实际边界、是否需要外部 runtime，以及已经采取的隔离措施。不要附加真实日志或数据库文件。

## 平台与合规边界

使用者负责确认微信客户端、账号、Hook/Native 组件、provider 和所在地区的条款、授权与法律要求。Agent 不提供绕过平台限制、未经授权读取会话、自动注入或隐蔽发送的保证。生产运行时由用户人工控制，真实收发和发送 ACK 必须在获得适当授权的环境中完成。

## 已知安全边界

- 外部 runtime 提供的 trusted identity、mention spans 和 delivery ACK 是安全前提；Agent 无法替代其实现或证明其来源。
- 普通非 mention GROUP 消息进入被动上下文，不自动触发回答；模型和网页内容不能提升权限。
- Search 网页内容是不可信输入；网页抓取器对本地、私网、metadata 和危险 URL 做阻断。
- 生成文本不等于已发送文本；只有内容哈希匹配的 `SENT` ACK 才提交 assistant 上下文。
- Persistent Memory 受 scope/visibility/软删除与预算约束，但仍是本地敏感数据，应按私人数据保护。
