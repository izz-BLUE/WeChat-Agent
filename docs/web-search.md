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

- `SEARCH_PROVIDER=degoog`（默认）使用本机 Degoog；启用且配置了 SearXNG 时，Degoog 失败或返回空结果会按现有预算尝试一次 SearXNG fallback。
- `SEARCH_PROVIDER=searxng` 直接选择 SearXNG；未启用或未配置时 fail-soft。
- `WEB_SEARCH_PROVIDER=tavily` 作为旧配置保留，继续使用原有 Tavily/SearXNG 路由。
- provider 失败或返回空结果时，在期限预算允许时尝试受限 fallback。

Degoog 使用本机 `/api/search?q=...&lang=zh` 接口；Tavily 使用 `/search` 和有限的 basic search 参数；SearXNG 使用 JSON search 接口、配置的 engines，并在近期搜索时设置时间范围。API key 只从环境变量读取，provider 原始 payload 不进入持久日志或模型 prompt。

## 结果处理与网页证据

结果进入模型前会经过 HTML/text 清理、URL tracking 参数和 hash 处理、去重、相关性/新鲜度/hostname 多样性排序以及 `S1..Sn` 重新编号。网页证据抓取有独立的超时、字数、页面数和总量上限；失败时保留已有 snippet。

网页抓取器拒绝 localhost、私网、link-local、metadata、带凭据、非标准危险端口和其他不安全 URL。网页内容始终是不可信数据，不能改变系统身份或授权事实。

模型只能用 `[S1]` 这类标记引用检索结果。Runtime 使用 source marker 完成 grounding 校验，发送前移除 marker；来源元数据保留在内部 grounding/diagnostic 链路中，默认不附加到最终群聊回复。模型伪造的 URL 和无效 marker 仍会被清理。有搜索结果但无法可靠对应来源时，系统会进行一次有限的 grounding repair；仍失败则不把不可靠结论伪装成有来源的事实。

## 启用前检查

```dotenv
WEB_SEARCH_ENABLED=1
SEARCH_PROVIDER=degoog
DEGOOG_API_BASE=http://127.0.0.1:4444
SEARXNG_ENABLED=0
```

也可以设置 `SEARXNG_ENABLED=1` 作为 Degoog 的可用 fallback，但必须自行运行并保护该服务。示例中的 `http://127.0.0.1:8088` 只是默认地址，不是本仓库提供的服务。若需要使用 Tavily，优先设置 `SEARCH_PROVIDER=tavily` 并提供地址与密钥；旧配置 `WEB_SEARCH_PROVIDER=tavily` 仅在未设置 `SEARCH_PROVIDER` 时生效。

启用前请确认：搜索内容可以被发送给所选 provider、密钥不会进入 Git、内部身份值不会拼入 query、以及回答中的搜索事实只保留经过 grounding 的内容。若这些条件不能满足，应保持关闭。
