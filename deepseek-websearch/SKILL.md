---
name: deepseek-websearch-toolmap
description: "deepseek-websearch 工具名映射记录：官方 tavily-mcp v0.2.22 工具名 ↔ 本服务器改名后的 deepseek_* 工具名。用于对齐官方上游升级：官方发布新版本时，按此映射把变更应用到本项目的 deepseek_* 工具，保持协议语义一致。Triggers: 对齐官方升级、同步 tavily-mcp 上游变更、工具名映射查询。"
---

# deepseek-websearch 工具名映射（官方 ↔ 本服务器）

> 决策（2026-08-07）：工具名由官方 `tavily_*` 全部改为 `deepseek_*`（与服务器名 deepseek-websearch 一致）。MCP 工具名规范不允许点号，故用下划线。
> 协议语义、参数 schema、返回结构保持与官方 tavily-mcp v0.2.22 完全一致，仅名称不同。

## 映射表

| 官方（tavily-mcp v0.2.22） | 本服务器（deepseek-websearch） | 功能 |
|---|---|---|
| `tavily_search` | `deepseek_search` | AI 实时搜索（Tavily→Exa 回退） |
| `tavily_extract` | `deepseek_extract` | 指定 URL 正文提取 |
| `tavily_crawl` | `deepseek_crawl` | 站点爬取（建任务 + 轮询） |
| `tavily_map` | `deepseek_map` | 域名 → URL 列表 |
| `tavily_research` | `deepseek_research` | 深度研究报告（轮询 + 流式回退） |

## 对齐官方升级（v0.2.22 → 上游新版本）

当官方 tavily-mcp 发布新版本时：

1. 下载官方新版本源码，与当前基线（v0.2.22）diff，识别变更点；
2. 将变更按上表**反向映射**应用到本项目的 `deepseek_*` 工具：
   - 官方 `tavily_search` 的变更 → 应用为 `deepseek_search` 的变更，依此类推；
3. 保留本项目特色（不可被官方覆盖）：
   - 错误前缀 `[deepseek-websearch 内部错误]`；
   - 搜索失败切换（Tavily→Exa，401/403 不切换）；
   - crawl 双模式（job_id 轮询 + 直接结果）、research 三层护栏（退避 1.5 轮询 + 透明切流 + 多层超时）；
   - 阶段标注（`（卡在 xx）`）、静默日志 + 最新错误日志（mcp-common）；
4. 回归：`npm run build && node --test`，再按 `测试素材/websearch/用例清单.md` 做真实 API 回归。

## 注意

- 工具名是本服务器的对外协议标识：改名前客户端调用 `tavily_*`，改名后调用 `deepseek_*`；客户端（CC Switch、skill、AGENTS.md 规则块）已同步；
- 不要改动 `TAVILY_API_KEY` 等环境变量名（指向 Tavily API，非工具名）；
- 底层引擎不变：搜索仍 Tavily→Exa，`deepseek_*` 仅为命名。
