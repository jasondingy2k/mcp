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

## Tool picker (8 tools × `source`)

Capability = tool name. Source = required `source` (`clipboard` | `path` | `screenshot` | `base64`). When `source=path`, also pass `image_path`. When `source=base64`, also pass `image_base64` (raw base64 or data URL; decoded in memory, no temp file).

| Need | Tool | Args |
|------|------|------|
| General describe / Q&A | `analyze_image` | `source` + optional `prompt`; `image_path` if path; `image_base64` if base64; optional `lang=zh\|en`; optional `region` |
| OCR | `extract_text` | `source` (+ `image_path` if path; `image_base64` if base64); optional `lang`; optional `region` |
| UI layout / components | `describe_ui` | same; optional `format=json`; optional `region` |
| Error screenshot → cause + fix | `diagnose_error` | same; optional `format=json`; optional `region` |
| Diagram (flowchart / architecture) | `understand_diagram` | same; optional `region` |
| Data chart (line/bar/pie) | `analyze_chart` | same; optional `region` |
| Code in screenshot → editable code | `code_from_screenshot` | same; optional `region` |
| **Before/after or A vs B** | `compare_images` | `source_a` + `source_b` (each `clipboard\|path\|screenshot\|base64`); `image_path_a`/`image_path_b` when path; `image_base64_a`/`image_base64_b` when base64; optional `prompt`; optional `lang`; optional `region_a`/`region_b`. **A = first image, B = second.** Mix sources per side. For true before/after, use `path` or `base64` — consecutive clipboard reads may return the same image. |

**Do not** call removed names: `analyze_clipboard`, `*_from_clipboard`. Those tools no longer exist.

## Workflow

1. Pick the capability tool (OCR / UI / error / code / diagram / chart); otherwise `analyze_image`.
2. Set `source=clipboard` (user just screenshotted/copied), `source=screenshot` (capture the current screen — no clipboard copy needed), `source=path` with `image_path`, or `source=base64` with `image_base64` when the caller already has inline image data.
3. Answer using the returned text. Quote exact error strings / UI labels when relevant.
4. If clipboard is empty, try `source=screenshot` or ask the user to copy a screenshot first (macOS: `Cmd+Ctrl+Shift+4`), then retry.

## Response language (`lang`)

All 8 tools accept optional `lang`: `zh` (Simplified Chinese) or `en` (English). Omit to keep default English prompts. **Chinese-speaking agents should pass `lang=zh`.** For `extract_text` and `code_from_screenshot`, image text/code stays in the original language — only labels/headings/meta follow `lang`.

## Structured output (`format`)

`describe_ui` and `diagnose_error` accept optional `format`: `text` (prose, default) or `json`. With `format=json`, the tool returns pretty-printed JSON with fixed English property names:

- `diagnose_error`: `error_message`, `causes`, `fixes`, `prevention`
- `describe_ui`: `layout`, `components`, `labels`, `state`

Combine with `lang`: property names stay English; string values follow `lang` (`zh` → Simplified Chinese values, `en` → English values). Invalid or unparseable JSON from the model returns `FormatError` (not prose).

## Crop region (`region`)

All 7 single-image tools accept optional `region` to crop before downscale — useful for toasts, error banners, or a code block in a large screenshot:

```json
{ "x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5, "unit": "ratio" }
```

- `unit=px`: pixels relative to the **current raster image** (after HEIC transcode, before longest-edge resize).
- `unit=ratio`: normalized fractions in `[0,1]`; `width`/`height` are fractions of image width/height.
- Omit `region` to analyze the full image. Partial overflow is clamped to image bounds; fully outside regions error with `（卡在 区域裁切）`.

## Environment rules installation

To keep the rules active in every session (not only when this skill triggers), install them into the project file:

1. Check whether the project's `AGENTS.md` / `CLAUDE.md` already covers these rules:
   - the exact marker `## DeepSeek Vision rules` is present, OR
   - an equivalent rule exists (capability tools + required `source=clipboard|path|screenshot|base64`)
2. If already covered → do nothing (idempotent).
3. If NOT covered → ask the user for confirmation, then append the following block:

```markdown
## DeepSeek Vision rules (active when `deepseek-vision` MCP is in the tool list)

Text-only model environment: there is NO native image capability — built-in image tools are disabled.
- Pick a capability tool (`analyze_image` / `extract_text` / `describe_ui` / `diagnose_error` / `understand_diagram` / `analyze_chart` / `code_from_screenshot` / `compare_images`) and set `source=clipboard`, `source=screenshot`, `source=path` (`image_path` required when path), or `source=base64` (`image_base64` required when base64). For `compare_images`, use `source_a`/`source_b` instead (A=first, B=second).
- Do NOT say you cannot see images; call the matching tool immediately.
```

## Notes

- Backend: OpenCode Go `mimo-v2.5` via local MCP `deepseek-vision`.
- Prefer `source=clipboard` over asking for a saved file path when the user just took a screenshot.
- Use `source=base64` when another tool or API already returns inline image data (no disk write).
- Use `source=screenshot` when you need what's on screen but the user hasn't copied to clipboard (e.g. "look at my screen", "what's on this page").
- **HEIC/HEIF** (e.g. iPhone photos) is supported: on macOS the MCP transcodes via `sips` to PNG before analysis; on other platforms conversion may fail — ask the user to export PNG/JPEG or use macOS.
