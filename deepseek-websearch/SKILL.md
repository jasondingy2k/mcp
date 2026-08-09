---
name: deepseek-websearch
description: "Live web info when native WebSearch unavailable (OpenCode Go DeepSeek etc). Triggers: search, docs lookup, releases, errors."
---

# DeepSeek Web Search (Tavily → Exa)

MCP for backends without native web search (OpenCode Go DeepSeek, Claude Code text-only, etc.).

## Call when

- Backend lacks native `WebSearch` / `WebFetch`
- User needs current web info (docs, versions, errors, news)
- Search snippets too thin → follow with `deepseek_extract`
- Whole-site URL inventory or crawl needed

## Do not call when

- OpenCode app built-in websearch
- Official DeepSeek API with native WebSearch in Claude Code
- Purely local / codebase questions
- User gave URLs only → `deepseek_extract`, not search

## Tool picker

| Need | Tool |
|------|------|
| Live news / facts / time-sensitive info | `deepseek_search` |
| Content of specific URLs | `deepseek_extract` |
| Crawl a whole site (async, ~5 min) | `deepseek_crawl` |
| List a site's URLs / sitemap | `deepseek_map` |
| Deep multi-source research report | `deepseek_research` |
| Raw content of a single known URL | `web_fetch` (if available) |

## Constraints

- Semantic query (describe ideal page), not bare keywords
- `search_depth`: basic default (1 credit); advanced for precise facts (2)
- Thin snippets → `deepseek_extract` on best URLs; cite returned URLs
- Keys: weighted round-robin Tavily/Exa pools; extract/crawl/map Tavily only

## Persistent rules (optional)

If the project needs always-on rules, append to `AGENTS.md` under `## DeepSeek WebSearch rules`:

- DeepSeek-backend env: no native web search; do not call native WebSearch/WebFetch
- Live info → `deepseek_search`
- User URLs → `deepseek_extract`
- Site crawl → `deepseek_crawl`; URL list → `deepseek_map`
- Deep report → `deepseek_research`
