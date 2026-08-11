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
- Compare two screenshots or before/after UI

Do not claim inability to see images. Call the tool.

## Tools (2)

| Need | Tool | Args |
|------|------|------|
| Single image | `vision` | `task` (required); optional `image` (default clipboard), `region` |
| A vs B | `compare` | `image1` + `image2` + `task` (all required). Prefer path/base64 for before/after (clipboard may repeat). |

### `vision`

```json
{
  "task": "extract text from this screenshot",
  "image?": "clipboard | screenshot | /abs/path.png | data:image/...;base64,...",
  "region?": { "x": 0, "y": 0, "width": 100, "height": 50 }
}
```

- `task`: free text — what to do with the image
- `image`: omit for clipboard; `screenshot` for full-screen capture; absolute path or base64/data URL for files
- `region`: optional pixel crop after HEIC transcode, before downscale

### `compare`

```json
{
  "image1": "/path/before.png",
  "image2": "/path/after.png",
  "task": "what changed between these UIs?"
}
```

## Agent selection (description self-check)

| User task | Expected tool |
|-----------|---------------|
| 看这个截图哪里报错 | `vision` |
| 提取截图里的文字 | `vision` |
| 比较两个界面变化 | `compare` |

## Constraints

- No capability/source/lang/format enums — express intent in `task`
- `region`: pixels only (`x`, `y`, `width`, `height`); no `unit` or ratio
- Empty clipboard: try `image: "screenshot"` or an absolute path
- Linux clipboard/screenshot not supported — use path or base64
- Payload encoding (server-side): default `VISION_OUTPUT_FORMAT=auto` — photo sources (JPEG/WebP/HEIC) → JPEG q90; PNG/screenshot/alpha → PNG. Bytes≠tokens (tokens follow resolution).

## Persistent rules (optional)

If the project needs always-on rules, append to `AGENTS.md` under `## DeepSeek Vision rules`: text-only env; single image → `vision`; two images → `compare`; call immediately, do not refuse.
