# Development

## 环境

- Node.js 18+；npm 7+。
- TypeScript 编译目标为 ES2022，输出目录为被 Git 忽略的 `dist/`。
- production transport 使用 Windows Named Pipe；Agent-only build/test 不要求真实微信客户端或 Native runtime。

## 常用命令

```powershell
npm run build
npm test
npm run test:contract
npm run test:memory
npm run test:web-search
npm run test:transport-framing
npm run test:outbound-delivery-ack
```

`npm test` 会先构建，再按 `package.json` 中的固定顺序执行契约、边界、Memory、搜索、上下文、渲染和投递测试。单个 `test:*` 脚本适合修改某一边界后快速回归；交付前仍应运行完整 `npm test`。

## 测试范围

测试主要覆盖：

- 入站字段形状、GROUP/DIRECT 分类、mention admission 和 passive 分流；
- requester-local / ambient / topic capsule 的隔离、预算、TTL 和 ACK 触发边界；
- Memory scope、显式记忆、软删除、原始身份屏蔽和文件写入；
- Search planner 协议、结果归一化、grounding、网页抓取安全边界；
- answer guard、persona/rendering、request deadline、transport response；
- outbound `SENT`/`FAILED` ACK、重复/未知/哈希不匹配处理。

测试中的身份、路径和消息是 synthetic fixtures。不要把真实群聊内容、真实身份映射、日志或 provider 响应复制到测试目录。

## 修改原则

保持可信 runtime contract、授权边界和 `GENERATED != SENT` 不变量。新增能力时先补边界测试，再做最小实现；不要用放宽校验、删除测试、把被动消息改成主动回复或把生成文本提前写入 ambient 的方式解决失败。

与 C# / Native runtime 的变更应在本仓库记录字段/状态机影响，但不把外部实现伪造为本仓库内容。需要真实微信操作时，停止在 Agent-only 验证边界，由维护者人工进行运行时步骤。

## 本地数据

开发时 `.env`、`runtime-data/`、`.local/`、`dist/`、日志、coverage 和 dump 都属于本地数据。检查 Git 状态时应确认它们没有进入 tracked set；不要为了清理状态执行 reset、restore、clean 或删除用户目录。

## 发布前检查

```powershell
npm run build
npm test
git diff --check
git status --short --ignored
```

同时人工检查 Markdown 相对链接、`.env.example` 与 `src/config.ts` 的变量同步、依赖许可证闭包、LICENSE 状态和 README 中的稳定/实验/外部边界。发布前不要提交 secrets、真实身份、运行时 Memory、日志、截图、dump 或未审查的生成目录。
