# deepseek-vision MCP Server

迁移自 `mimo-vision-mcp`（Python）的 TS 版：剪贴板优先的视觉 MCP，为 DeepSeek 系纯文本 agent 提供看图能力，模型走 OpenCode Go `mimo-v2.5`。

## 功能（2 个工具，v0.5.0）

| 工具 | 说明 |
|---|---|
| `vision` | 单图分析；必填 `task`；可选 `image`（默认 clipboard）、`region` |
| `compare` | 双图对比 A→B；必填 `image1`、`image2`、`task` |

### `vision`

```json
{
  "task": "describe this error",
  "image?": "clipboard | screenshot | <abs-path> | <data-url|base64>",
  "region?": { "x": 100, "y": 200, "width": 800, "height": 400 }
}
```

- `task`：自由文本，表达看图意图（OCR、UI、报错、图表、代码等）
- `image`：可省略（默认剪贴板）；`screenshot` 须显式传入；亦支持绝对路径、data URL 或 raw base64
- `region`：可选像素裁切（HEIC 转码后、缩图前）；部分越界 clamp

### `compare`

```json
{
  "image1": "...",
  "image2": "...",
  "task": "what changed?"
}
```

`image1`/`image2` 解析规则同 `vision.image`。两图均用 `clipboard` 可能读到同一内容，before/after 请优先 path/base64。

**v0.5.0 破坏性变更**：移除 `deepseek_vision`、`compare_images` 及 capability/source/lang/format 对外参数。

## 构建与运行

Node 20+。macOS 剪贴板需 `pngpaste`；Windows `powershell.exe`；Linux 剪贴板/截屏未承诺，请用 path/base64。截屏：`image: "screenshot"`（macOS `screencapture`、Windows CopyFromScreen）。

```bash
npm install
npm run build
node build/index.js
```

配套 Agent Skill：[`SKILL.md`](./SKILL.md)。

## 配置

| 环境变量 | 说明 |
|---|---|
| `OPENCODE_API_KEY`（或 `VISION_API_KEY`） | **主池** key；逗号分隔等权 RR；鉴权/429/额度失败换下一个 key |
| `VISION_BASE_URL` | 主池端点（默认 https://opencode.ai/zen/go/v1；Google：`…/v1beta/openai/`） |
| `VISION_MODEL_NAME` / `VISION_MODEL` | 主池模型（默认 mimo-v2.5；Google 例 `gemini-3.1-flash-lite`） |
| `VISION_FALLBACK_API_KEY` | **备用池** key（主池 provider 级失败或 key 耗尽后再 RR） |
| `VISION_FALLBACK_BASE_URL` | 备用端点（默认 https://api.groq.com/openai/v1） |
| `VISION_FALLBACK_MODEL_NAME` | 备用模型（默认 `qwen/qwen3.6-27b`） |
| `VISION_REASONING_EFFORT` | thinking 开关（默认 `none` 且省略字段；`default` 开启） |
| `VISION_REASONING_EFFORT_CAPABILITY` | 主池 `reasoning_effort` 策略：`auto`（默认，遇 400 unknown field 窄降级并缓存）/ `supported` / `unsupported` |
| `VISION_FALLBACK_REASONING_EFFORT_CAPABILITY` | 备用池同上 |
| `VISION_MAX_TOKENS` | 完成 token 上限含 reasoning（默认 4096） |
| `VISION_MAX_IMAGE_BYTES` | 图片大小上限（默认 20MB） |
| `VISION_MAX_IMAGE_PIXELS` | 像素上限（默认 40_000_000） |
| `VISION_VERIFY_TIMEOUT_MS` | sharp 解码超时 ms（默认 15000） |
| `VISION_MAX_SEND_EDGE` | 送模最长边（默认 2048；`0` 禁用） |
| `VISION_OUTPUT_FORMAT` | 送模编码：`auto`（默认）按源自适应；`png`/`jpeg`/`webp` 强制覆盖。auto：JPEG/WebP/HEIC 照片→JPEG q90；PNG/截图/含 alpha→PNG。WebP 默认不启用 |
| `VISION_OUTPUT_QUALITY` | JPEG/WebP 质量 1–100（默认 90） |
| `DEEPSEEK_VISION_LOG_LEVEL` | 日志级别；缺省静默 |

## 平台能力

darwin: `pngpaste` 剪贴板、`screencapture` 截屏、HEIC→PNG (`sips`)。win32: PowerShell 剪贴板/截屏。base64 内存解码。

## 约定

- 错误：`[deepseek-vision 内部错误] <类型>: <信息>`；阶段 `（卡在 …）`
- Failover：key-scoped（401/403/429/额度）同池换 key；provider-scoped（5xx/模型/空响应/网络+有备池）整池 skip；request-scoped（大多数 400）直接返回
- 空 content 自动重试 1 次并加倍 `max_tokens`；仍空且有备池 → 转下级池；无备池且 `finish_reason=length` → `increase VISION_MAX_TOKENS and retry`
- 剪贴板临时文件：`tmp/`，用完即删
- capability 关键词仅作内部 prompt enhancer，不暴露给 agent

## License

MIT
