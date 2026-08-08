---
name: deepseek-websearch
description: "Use when Claude Code/Codex/etc. need live web info but native WebSearch/WebFetch is unavailable (OpenCode Go DeepSeek or similar). Triggers: search the web, look up docs online, latest version, release notes, error googling. Do NOT use on OpenCode app built-in search or official DeepSeek API native WebSearch."
---

# DeepSeek Web Search (Tavily → Exa)

## When to use

Use the **`deepseek-websearch` MCP** tools when:

- You are in **Claude Code / Codex / Gemini / Hermes** (or similar), AND
- The model backend **cannot** call native Anthropic `WebSearch` / `WebFetch` (common with **OpenCode Go DeepSeek**), AND
- The user needs current web information (docs, errors, releases, news)

## When NOT to use

- **OpenCode app**: use its built-in websearch
- **Official DeepSeek API** in Claude Code: use native WebSearch
- Purely local / codebase questions that do not need the internet

## Tool picker

| Need | Tool |
|------|------|
| Live news / facts / time-sensitive info | `deepseek_search` |
| Content of specific user-provided URLs | `deepseek_extract` |
| Crawl a whole site (async job + polling, ~5 min) | `deepseek_crawl` |
| List a site's URLs / sitemap | `deepseek_map` |
| Deep multi-source research report | `deepseek_research` |
| Raw content of a single known URL | `web_fetch` (if available) |

## How

1. Pick the matching tool above; `deepseek_search` is the default for any live-info query.
2. Cite returned URLs in your answer.
3. Provider order is automatic: **Tavily first**; **Exa** only on Tavily non-auth failure (5xx/timeout). 401/403 auth failures never fall back.
4. Never answer time-sensitive queries from memory.

## Environment rules installation

This skill serves DeepSeek-backend environments. To keep the rules active in every session (not only when this skill triggers), install them into the project file:

1. Check whether the project's `AGENTS.md` / `CLAUDE.md` already covers these rules:
   - the exact marker `## DeepSeek WebSearch rules` is present, OR
   - an equivalent rule exists (e.g. it states the backend has no native web search and names `deepseek_search` / `deepseek_extract` as the tools to use)
2. If already covered → do nothing (idempotent).
3. If NOT covered → ask the user for confirmation, then append the following block:

```markdown
## DeepSeek WebSearch rules (active when `deepseek-websearch` MCP is in the tool list)

DeepSeek-backend environment: there is NO native web search. Even if a native WebSearch/WebFetch appears in the tool list, calling it hangs the conversation — never use it.
- Live info / news / facts / time-sensitive queries → `deepseek_search`
- Content of specific user-provided URLs → `deepseek_extract`
- Whole-site crawl → `deepseek_crawl`; list a site's URLs → `deepseek_map`
- Deep multi-source research reports → `deepseek_research`
```
