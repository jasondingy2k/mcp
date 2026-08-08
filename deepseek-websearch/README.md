# deepseek-websearch MCP Server

fork 自 [tavily-ai/tavily-mcp](https://github.com/tavily-ai/tavily-mcp) v0.2.22（MIT，`LICENCE` 保留），为 DeepSeek 系纯文本 agent（如 OpenCode Go DeepSeek）补齐联网搜索能力。

## 功能

5 个 MCP 工具（`deepseek_*` 命名，协议语义 fork 自官方）：

| 工具 | 功能 |
|---|---|
| `deepseek_search` | AI 实时搜索（搜索深度、时间范围、域名过滤、图片等）；**多 key 加权轮询**：Tavily/Exa 池内按权重选 key，单次请求内失败（含 401/402/429）换下一 key |
| `deepseek_extract` | 指定 URL 正文提取（markdown / text）；**Tavily 池内轮询选 key** |
| `deepseek_map` | 域名 → URL 列表（站点结构地图）；**Tavily 池内轮询选 key** |
| `deepseek_crawl` | 站点爬取（建任务 + 轮询，可配深度/广度/路径过滤）；**Tavily 池内轮询选 key** |
| `deepseek_research` | 深度研究报告（主代理先广后深：广度并行 + 深度串行 + 综合报告；成本 5–10 点，封顶）；内部 search 走同一 key 池 |

## 构建与运行

要求 Node 20+：

```bash
npm install
npm run build
node build/index.js        # stdio 传输，接入 CC Switch / Claude Code 等 MCP 客户端
```

## Skill

配套 Agent Skill 在本目录 [`SKILL.md`](./SKILL.md)（何时用哪个 `deepseek_*` 工具）。

接入 CC Switch / Grok 时，把 skill 目录指到本包即可，例如：

```bash
ln -sfn /Users/jason/mcp/deepseek-websearch ~/.cc-switch/skills/deepseek-websearch
```

## 配置

| 环境变量 | 说明 |
|---|---|
| `TAVILY_API_KEY` | Tavily API key（**一个或多个，逗号分隔**，如 `tvly-a,tvly-b`）。缺省时进入 keyless 模式（`X-Tavily-Access-Mode: keyless`），仅 `deepseek_search` / `deepseek_extract` 可用 |
| `EXA_API_KEY` | 可选。Exa API key（**一个或多个，逗号分隔**）。`deepseek_search` 在 Tavily/Exa 池中按权重选 key；extract/crawl/map 仅用 Tavily 池 |
| `EXASEARCH_API_KEY` | 可选。Exa 别名；仅当 `EXA_API_KEY` 为空时使用（同样逗号解析） |
| `TAVILY_KEY_WEIGHT` / `EXA_KEY_WEIGHT` | 可选。多 key 加权轮询权重（正整数）；默认 `1000` / `1400`（按免费额度比例校准；额度变更用 env 覆盖，不改代码） |
| `TAVILY_HUMAN_ID` | 可选。请求归因用 Human ID（Tavily 侧 SHA-256 哈希后存储） |
| `DEFAULT_PARAMETERS` | 可选。JSON 字符串，设置工具参数默认值，如 `{"search_depth":"advanced","include_images":true}` |
| `RESEARCH_API_KEY` | 可选。research 主代理 LLM key；缺省时 `deepseek_research` 明确报错（不回退官方动态计费；与 vision 的 key 独立） |
| `RESEARCH_BASE_URL` | 可选。主代理端点（OpenAI 兼容）；默认 `https://opencode.ai/zen/go/v1` |
| `RESEARCH_MODEL` | 可选。主代理模型（默认 `deepseek-v4-flash`，2026-07-31 后训练 0731 正式版） |
| `RESEARCH_MIN_SEARCHES` / `RESEARCH_MAX_SEARCHES` | 可选。总搜索次数下限/上限（默认 `5` / `10`） |
| `RESEARCH_MIN_BREADTH` / `RESEARCH_MIN_DEPTH` | 可选。广度/深度子问题下限（默认 `3` / `2`） |
| `DEEPSEEK_WEBSEARCH_LOG_LEVEL` | 可选。诊断日志级别 `debug`/`info`/`warn`/`error`；缺省为静默 |

`.env` 加载约定（启动时只加载一次）：支持 `export ` 前缀、` #` 内联注释；非法值（如 null 字节）跳过不崩溃；已有环境变量不被覆盖。参考 `.env.example`。

## 工作区约定（继承自 MCP 工作区）

- **错误可定位**：工具错误返回 `[deepseek-websearch 内部错误] <异常类型>: <信息>`；长任务超时带阶段标注（`（卡在 tavily）` / `（卡在 exa）` / `（卡在 research 广度规划/广度搜索/深度规划/深度搜索/综合）`）；
- **默认静默日志**：诊断信息进工具返回文本，不落日志文件；排错时设 `DEEPSEEK_WEBSEARCH_LOG_LEVEL`；
- **超时护栏**：`deepseek_search` 单 provider 30s、单次请求 key 池全程 **60s** 总预算（超时报 `（卡在 tavily / exa）`，按当前尝试的 provider 标注）；`deepseek_research` 主代理编排：总墙钟 **480s 硬上限**（规划单次 60s×重试、深度串行每条前检查剩余、综合 120s），阶段标注 `（卡在 research 广度规划/广度搜索/深度规划/深度搜索/综合）`；
- **原子写**：写文件走临时文件 + rename（当前无持久化文件，预留约定）。

## 已知事项（记录在案）

- **npm audit 3 个漏洞**（`fast-uri` high、`ip-address` high、`hono` moderate）——全在 `@modelcontextprotocol/sdk@1.30.0` 的 HTTP 传输链传递依赖，本服务器仅用 stdio，不走相关代码路径。**决策（2026-08-07）：锁版本暂缓，全部开发完成后统一处理**——`npm audit fix` 非 force 修不动，force 会覆盖 SDK 依赖锁定有破坏风险；
- **上游不追踪**：fork 基线 v0.2.22，不跟随上游后续版本。

## 开发状态（2026-08-07）

- [x] fork 基线（官方 v0.2.22，5 工具原样跑通 + 回归）
- [x] 错误前缀 / 静默日志 / .env 约定 / 改名 deepseek-websearch
- [x] `deepseek_search` + Exa 失败回退（单 provider 30s / 全程 60s 预算 / 阶段标注 / 13 项单测）
- [x] extract/map 超时护栏（120s / 30s）；crawl 建任务+轮询（退避 1.5 / 5 分钟预算 / 阶段标注）
- [x] 真实 API smoke test（2026-08-07：A1.1–A1.8 全过；A1.3 Exa 回退为单测覆盖，活体触发需 quota/5xx）
- [x] research 主代理改造（2026-08-08）：先广后深编排替代官方 `/research`；5–10 点封顶 + 3 次模型；70 单测；`RESEARCH_*` 配置；6 轮真实 smoke 收敛（综合删 `max_tokens` 帽 + 深度规划输入瘦身首 300 字，见设计文档 §11）
- [x] 多 key 加权负载均衡（2026-08-08）：Tavily/Exa key 逗号多 key + WRR 选 key（默认 1000/1400，env 可覆盖）；search 成功路径按权重选引擎；单次请求失败换池内下一 key；extract/crawl/map 仅 Tavily 池；`shouldFallbackToExa` → `shouldRetryNextKey`（全 kind 换 key）；83 单测

## License

MIT（fork 自 tavily-mcp v0.2.22，`LICENCE` 文件保留）。
