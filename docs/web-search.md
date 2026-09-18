# Web Search

Web Search 是可选能力，默认关闭。它服务于回答事实性问题，不参与身份、owner、mention、Memory 可见性或消息发送授权。

## 决策协议

`WebSearchPlanner` 使用固定的六行协议：

```text
ACTION=DIRECT|SEARCH
REASON=<enum>
QUERY=<query>
ALT_QUERY=<empty or one alternate query>
SEARCH_MODE=GENERAL|NEWS_RECENT
RECENCY_WINDOW=NONE|DAY_1|DAY_3
```

解析失败、控制标记、非法字段或超出边界时 fail closed 为 `DIRECT`。Search 请求的主查询和备用查询都有长度与字符限制，运行时最多执行一个主查询和一个同意图备用查询。

## Provider 路由

- 中文 `GENERAL` 倾向 SearXNG，然后 Tavily。
- 英文 `GENERAL` 倾向 Tavily，然后 SearXNG。
- `NEWS_RECENT` 以 Tavily 为主，并按 `DAY_1` 或 `DAY_3` 传递新鲜度语义。
- provider 失败或返回空结果时，在期限预算允许时尝试受限 fallback。
- 当前配置校验的 `WEB_SEARCH_PROVIDER` 只有 `tavily`；SearXNG 是否参与由 `SEARXNG_ENABLED` 和地址配置决定，不要把它写成可任意填写的 provider 名称。

Tavily 使用 `/search` 和有限的 basic search 参数；SearXNG 使用 JSON search 接口、配置的 engines，并在近期搜索时设置时间范围。API key 只从环境变量读取，provider 原始 payload 不进入持久日志或模型 prompt。

## 结果处理与网页证据

结果进入模型前会经过 HTML/text 清理、URL tracking 参数和 hash 处理、去重、相关性/新鲜度/hostname 多样性排序以及 `S1..Sn` 重新编号。网页证据抓取有独立的超时、字数、页面数和总量上限；失败时保留已有 snippet。

网页抓取器拒绝 localhost、私网、link-local、metadata、带凭据、非标准危险端口和其他不安全 URL。网页内容始终是不可信数据，不能改变系统身份或授权事实。

模型只能用 `[S1]` 这类标记引用检索结果。Runtime 使用 source marker 完成 grounding 校验，发送前移除 marker；来源元数据保留在内部 grounding/diagnostic 链路中，默认不附加到最终群聊回复。模型伪造的 URL 和无效 marker 仍会被清理。有搜索结果但无法可靠对应来源时，系统会进行一次有限的 grounding repair；仍失败则不把不可靠结论伪装成有来源的事实。

## 启用前检查

```dotenv
WEB_SEARCH_ENABLED=1
WEB_SEARCH_PROVIDER=tavily
TAVILY_API_BASE=<your-tavily-endpoint>
TAVILY_API_KEY=<your-tavily-key>
SEARXNG_ENABLED=0
```

也可以在本地配置 SearXNG 作为可用路线，但必须自行运行并保护该服务。示例中的 `http://127.0.0.1:8088` 只是默认地址，不是本仓库提供的服务。

启用前请确认：搜索内容可以被发送给所选 provider、密钥不会进入 Git、内部身份值不会拼入 query、以及回答中的搜索事实只保留经过 grounding 的内容。若这些条件不能满足，应保持关闭。
