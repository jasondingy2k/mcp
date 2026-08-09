---
name: deepseek-vision
description: "Text-only model + image/OCR/UI/error/diagram/chart/code screenshot. Triggers: clipboard, screenshot, image path, base64."
---

# DeepSeek Vision

Text-only models cannot see pixels. Call **`deepseek-vision` MCP** (OpenCode Go MiMo-V2.5).

## Call immediately when

- User pasted/copied screenshot, mentions clipboard / 看剪贴板 / 这张图
- OCR, UI review, error diagnosis, code extraction from screenshot
- Local image path needs visual understanding

Do not claim inability to see images. Call the tool.

## Tools (2)

| Need | Tool | Args |
|------|------|------|
| Single image | `deepseek_vision` | `capability` + `source`; `image_path` if path; `image_base64` if base64; optional `lang`, `region`, `prompt` (analyze only), `format` (describe_ui/diagnose_error) |
| A vs B | `compare_images` | `source_a` + `source_b` (+ path/base64 fields); optional `prompt`, `lang`, `region_a`/`region_b`. A=first, B=second. Prefer path\|base64 for before/after (clipboard may repeat). |

### capabilities (`deepseek_vision`)

| capability | Use |
|------------|-----|
| `analyze` | General describe/Q&A; optional `prompt` |
| `extract_text` | OCR |
| `describe_ui` | UI layout/components/state; optional `format=json` |
| `diagnose_error` | Error screenshot; optional `format=json` |
| `understand_diagram` | Diagrams |
| `analyze_chart` | Charts |
| `code_from_screenshot` | Extract code |

Removed tool names (use `deepseek_vision` + `capability`): `analyze_image`, `extract_text`, `describe_ui`, `diagnose_error`, `understand_diagram`, `analyze_chart`, `code_from_screenshot`, `analyze_clipboard`, `*_from_clipboard`.

## Constraints

- `source`: `clipboard` \| `path` \| `screenshot` \| `base64`
- `lang`: optional `zh` \| `en`. OCR/code (`extract_text`, `code_from_screenshot`): image text stays original language.
- `format`: only `describe_ui` \| `diagnose_error`. `text` (default) \| `json`; fixed English keys (`diagnose_error`: error_message, causes, fixes, prevention; `describe_ui`: layout, components, labels, state).
- `prompt`: only when `capability=analyze`.
- `region`: optional crop before downscale. `unit=px` (raster pixels post-HEIC) or `ratio` \[0,1\]. Partial overflow clamped; fully outside → `（卡在 区域裁切）`.
- Empty clipboard: try `source=screenshot` or `source=path`.

## Persistent rules (optional)

If the project needs always-on rules, append to `AGENTS.md` under `## DeepSeek Vision rules`: text-only env; single image → `deepseek_vision`+`capability`+`source`; two images → `compare_images`; call immediately, do not refuse.
