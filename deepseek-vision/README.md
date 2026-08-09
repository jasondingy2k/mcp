# deepseek-vision MCP Server

迁移自 `mimo-vision-mcp`（Python）的 TS 版：剪贴板优先的视觉 MCP，为 DeepSeek 系纯文本 agent 提供看图能力，模型走 OpenCode Go `mimo-v2.5`。

## 功能（2 个工具，v0.4.2）

| 工具 | 说明 |
|---|---|
| `deepseek_vision` | 单图；必填 `capability` + `source` |
| `compare_images` | 双图对比 A→B；`source_a`/`source_b` 各自独立 |

### capability 枚举

| capability | 说明 |
|---|---|
| `analyze` | 通用描述；可选 `prompt` |
| `extract_text` | OCR |
| `describe_ui` | UI 分析；可选 `format=json` |
| `diagnose_error` | 错误诊断；可选 `format=json` |
| `understand_diagram` | 图表/流程图 |
| `analyze_chart` | 数据图表 |
| `code_from_screenshot` | 提代码 |

`source`: `clipboard` \| `path` \| `screenshot` \| `base64`。`image_path` when path；`image_base64` when base64。

旧工具名已移除 → 用 `deepseek_vision` + `capability`。Removed: `analyze_image`, `extract_text`, `describe_ui`, `diagnose_error`, `understand_diagram`, `analyze_chart`, `code_from_screenshot`, `analyze_clipboard`, `*_from_clipboard`.

可选 `lang` (`zh`\|`en`)。`format` 仅 `describe_ui`\|`diagnose_error`。`prompt` 仅 `analyze`。`region` 缩图前裁切（`unit=px`\|`ratio`）。

`compare_images`: 真 before/after 用 path/base64；可选 `prompt`、`lang`、`region_a`/`region_b`。

## 构建与运行

Node 20+。macOS 剪贴板需 `pngpaste`；Windows `powershell.exe`；Linux 用 `source=path`。截屏 `source=screenshot`：macOS `screencapture`、Windows CopyFromScreen。

```bash
npm install
npm run build
node build/index.js
```

配套 Agent Skill：[`SKILL.md`](./SKILL.md)。

## 配置

| 环境变量 | 说明 |
|---|---|
| `OPENCODE_API_KEY`（或 `VISION_API_KEY`） | API key；缺省返回 `OPENCODE_API_KEY unset. Set OPENCODE_API_KEY (or VISION_API_KEY) in MCP server env.`（非 isError） |
| `VISION_BASE_URL` | 端点（默认 https://opencode.ai/zen/go/v1） |
| `VISION_MODEL_NAME` / `VISION_MODEL` | 模型（默认 mimo-v2.5） |
| `VISION_MAX_TOKENS` | 完成 token 上限含 reasoning（默认 4096） |
| `VISION_MAX_IMAGE_BYTES` | 图片大小上限（默认 20MB） |
| `VISION_MAX_IMAGE_PIXELS` | 像素上限（默认 40_000_000） |
| `VISION_VERIFY_TIMEOUT_MS` | sharp 解码超时 ms（默认 15000） |
| `VISION_MAX_SEND_EDGE` | 送模最长边（默认 2048；`0` 禁用） |
| `DEEPSEEK_VISION_LOG_LEVEL` | 日志级别；缺省静默 |

## 平台能力

darwin: `pngpaste` 剪贴板、`screencapture` 截屏、HEIC→PNG (`sips`)。win32: PowerShell 剪贴板/截屏。`source=base64` 内存解码。

## 约定

- 错误：`[deepseek-vision 内部错误] <类型>: <信息>`；阶段 `（卡在 …）`
- 空 content 自动重试 1 次并加倍 `max_tokens`；仍空且 `finish_reason=length` → `increase VISION_MAX_TOKENS and retry`
- 剪贴板临时文件：`tmp/`，用完即删

## License

MIT
