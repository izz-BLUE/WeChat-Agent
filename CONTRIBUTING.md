# Contributing

感谢贡献。请先阅读 [README.md](README.md)、[docs/architecture.md](docs/architecture.md) 和 [SECURITY.md](SECURITY.md)，理解 Agent 与外部微信/Native runtime 的边界。

## 提交前要求

1. 保持变更聚焦，不顺手重构无关模块。
2. 不提交 `.env`、API key、token salt、真实身份映射、聊天内容、Memory JSON、日志、截图、dump、`dist/` 或依赖目录。
3. 不弱化 mention、trusted identity、Memory scope、answer guard 或 outbound ACK 校验来让测试通过。
4. 运行 `npm run build`、`npm test` 和 `git diff --check`，在描述中记录结果与未验证的外部条件。
5. 影响 wire contract、外部 C# / Native runtime 或平台行为时，明确写出上下游兼容影响；本仓库不能独自证明真实微信链路。

## 工作流

请先开 issue 或在已有 issue 下说明目标，再从默认分支创建短生命周期分支；分支名可使用 `codex/` 前缀。提交 PR 时写清变更、测试命令和未验证的外部条件。涉及 identity、Memory、authorization、Native outbound 或 search grounding 的 PR 必须带对应回归测试或说明为何不适用。

## 许可证状态

项目采用 Apache License 2.0，完整文本见 [LICENSE](LICENSE)。贡献者提交代码时应保留许可证与适用的第三方版权/许可证声明，并遵守 Apache-2.0 的 NOTICE 相关要求（如适用）。
