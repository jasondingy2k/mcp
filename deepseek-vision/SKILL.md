---
name: deepseek-vision
description: "Use when the current model cannot see images, or the user pastes/copies a screenshot, mentions the clipboard image, asks to OCR/describe/diagnose a UI or error screenshot, or references an image file path. Triggers: clipboard screenshot, OCR, analyze image, describe UI, diagnose error screenshot, extract code from screenshot."
---

# DeepSeek Vision (clipboard eyes)

The active model may be **text-only** (e.g. DeepSeek V4 Flash). It cannot natively see pixels. Use the **`deepseek-vision` MCP** tools instead — they send the image to OpenCode Go **MiMo-V2.5** and return text you can reason over.

## When to use (do this immediately)

- User pasted / copied a screenshot, or says "look at clipboard / 看剪贴板 / 看看这张图"
- Conversation mentions an image attachment the model cannot understand
- User asks for OCR, UI review, error diagnosis from a screenshot, or code extraction from a screenshot
- User gives a local image path and wants visual understanding

**Do not** say you cannot see images. **Do not** ask the user to describe the image first. Call the matching tool.

## Tool picker (7 tools × `source`)

Capability = tool name. Source = required `source` (`clipboard` | `path`). When `source=path`, also pass `image_path`.

| Need | Tool | Args |
|------|------|------|
| General describe / Q&A | `analyze_image` | `source` + optional `prompt`; `image_path` if path |
| OCR | `extract_text` | `source` (+ `image_path` if path) |
| UI layout / components | `describe_ui` | same |
| Error screenshot → cause + fix | `diagnose_error` | same |
| Diagram (flowchart / architecture) | `understand_diagram` | same |
| Data chart (line/bar/pie) | `analyze_chart` | same |
| Code in screenshot → editable code | `code_from_screenshot` | same |

**Do not** call removed names: `analyze_clipboard`, `*_from_clipboard`. Those tools no longer exist.

## Workflow

1. Pick the capability tool (OCR / UI / error / code / diagram / chart); otherwise `analyze_image`.
2. Set `source=clipboard` (user just screenshotted/copied) or `source=path` with `image_path`.
3. Answer using the returned text. Quote exact error strings / UI labels when relevant.
4. If clipboard is empty, tell the user to copy a screenshot first (macOS: `Cmd+Ctrl+Shift+4`), then retry.

## Environment rules installation

To keep the rules active in every session (not only when this skill triggers), install them into the project file:

1. Check whether the project's `AGENTS.md` / `CLAUDE.md` already covers these rules:
   - the exact marker `## DeepSeek Vision rules` is present, OR
   - an equivalent rule exists (capability tools + required `source=clipboard|path`)
2. If already covered → do nothing (idempotent).
3. If NOT covered → ask the user for confirmation, then append the following block:

```markdown
## DeepSeek Vision rules (active when `deepseek-vision` MCP is in the tool list)

Text-only model environment: there is NO native image capability — built-in image tools are disabled.
- Pick a capability tool (`analyze_image` / `extract_text` / `describe_ui` / `diagnose_error` / `understand_diagram` / `analyze_chart` / `code_from_screenshot`) and set `source=clipboard` or `source=path` (`image_path` required when path).
- Do NOT say you cannot see images; call the matching tool immediately.
```

## Notes

- Backend: OpenCode Go `mimo-v2.5` via local MCP `deepseek-vision`.
- Prefer `source=clipboard` over asking for a saved file path when the user just took a screenshot.
