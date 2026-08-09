# deepseek-vision MCP Server

迁移自 `mimo-vision-mcp`（Python）的 TS 版：剪贴板优先的视觉 MCP，为 DeepSeek 系纯文本 agent（如 OpenCode Go DeepSeek）提供看图能力，模型走 OpenCode Go `mimo-v2.5`（OpenAI 兼容端点）。

## 功能（8 个工具）

能力 = 工具名；来源用 `source` 参数（`clipboard` | `path` | `screenshot` | `base64`）。`source=path` 时需传 `image_path`；`source=base64` 时需传 `image_base64`（raw base64 或 `data:image/...;base64,...` data URL，内存解码不落盘）。

| 工具 | 说明 |
|---|---|
| `analyze_image` | 通用描述；可选 `prompt` 覆盖 |
| `extract_text` | OCR 提取文字 |
| `describe_ui` | UI 截图分析 |
| `diagnose_error` | 错误截图诊断 |
| `understand_diagram` | 流程图 / 架构图解读 |
| `analyze_chart` | 数据图表分析 |
| `code_from_screenshot` | 从截图提取代码 |
| `compare_images` | 双图对比（A=第一张，B=第二张）；`source_a`/`source_b` 各自独立，可混用来源；真 before/after 建议用 path/base64（连续读剪贴板可能相同） |

全部工具可选 `lang`：`zh`（简体中文）或 `en`（英文）；省略则保持默认英文 prompt。OCR/提代码工具不翻译图内原文。

全部工具可选 `region` 对象，在**缩图前**裁切感兴趣区域（如 toast、错误条、代码区）：

```json
{ "x": 25, "y": 25, "width": 50, "height": 50, "unit": "px" }
```

- `unit=px`：像素，相对**当前栅格图**（HEIC 转码后、最长边缩放前）。
- `unit=ratio`：归一化比例 `[0,1]`；`width`/`height` 分别为相对图宽/图高的比例。
- 省略 `region` 则分析全图；部分越界自动 clamp 到图内；完全在图外报 `（卡在 区域裁切）`。

`describe_ui` 与 `diagnose_error` 另可选 `format`：`text`（散文，默认）或 `json`（结构化 JSON）。`format=json` 时返回固定英文字段名的 pretty JSON：

- `diagnose_error`：`error_message`、`causes`、`fixes`、`prevention`
- `describe_ui`：`layout`、`components`、`labels`、`state`

可与 `lang` 组合：键名保持英文，字符串值随 `lang`（`zh` 为简体中文值）。模型返回无法解析的 JSON 时工具报 `FormatError`（不把散文当成功返回）。

## 构建与运行

要求 Node 20+；macOS 剪贴板读图依赖 `pngpaste`（`brew install pngpaste`）；Windows 用系统自带 `powershell.exe`；Linux 未支持，请用 `source=path`。全屏抓屏（`source=screenshot`）：macOS `screencapture -x`、Windows `powershell.exe` CopyFromScreen、Linux 不支持。

```bash
npm install
npm run build
node build/index.js        # stdio 传输，接入 CC Switch / Claude Code 等 MCP 客户端
```

## Skill

配套 Agent Skill 在本目录 [`SKILL.md`](./SKILL.md)（8 工具；7 个单图 × `source`，`compare_images` × `source_a`/`source_b`）。

接入 CC Switch / Grok 时，把 skill 目录指到本包即可，例如：

```bash
ln -sfn /Users/jason/mcp/deepseek-vision ~/.cc-switch/skills/deepseek-vision
```

## 配置

| 环境变量 | 说明 |
|---|---|
| `OPENCODE_API_KEY`（或 `VISION_API_KEY`） | OpenCode Go API key（必填；缺省时工具返回设置指引） |
| `VISION_BASE_URL` | OpenAI 兼容端点（默认 https://opencode.ai/zen/go/v1） |
| `VISION_MODEL_NAME` / `VISION_MODEL` | 模型名（默认 mimo-v2.5） |
| `VISION_MAX_TOKENS` | 最大完成 token 数，含 reasoning（默认 4096，下限 512） |
| `VISION_MAX_IMAGE_BYTES` | 图片大小上限（默认 20MB） |
| `VISION_MAX_IMAGE_PIXELS` | 图片像素上限宽×高（默认 40_000_000） |
| `VISION_VERIFY_TIMEOUT_MS` | sharp 全量解码超时毫秒（默认 15000） |
| `VISION_MAX_SEND_EDGE` | 送模前最长边缩放上限像素（默认 2048；设为 `0` 禁用） |
| `VISION_MODEL` | `VISION_MODEL_NAME` 的兼容别名 |
| `DEEPSEEK_VISION_LOG_LEVEL` | 诊断日志级别 debug/info/warn/error；缺省为静默 |

`.env` 加载约定：支持 `export ` 前缀、` #` 内联注释；非法值（如 null 字节）跳过不崩溃；启动时只加载一次；已有环境变量不被覆盖。参考 `.env.example`。

## 剪贴板平台支持

| 平台 | 读取方式 | 说明 |
|---|---|---|
| macOS | `pngpaste`（brew） | 直接写 PNG 单次落盘（本机实测 pbpaste 读图不可用，故维持 pngpaste）；文本/空剪贴板报明确无图错误 |
| Windows | 系统自带 `powershell.exe`（5.x，默认 STA；**勿用 pwsh**） | `Clipboard.GetImage()` → `Save(Png)` 单次落盘 |
| Linux 及其他 | 不支持 | 明确报「暂不支持」，请用 `source=path` 传图片文件 |

## 全屏抓屏（`source=screenshot`）

| 平台 | 抓屏方式 | 说明 |
|---|---|---|
| macOS | `screencapture -x` | 系统自带，静音全屏主屏抓屏 |
| Windows | 系统自带 `powershell.exe`（5.x，**勿用 pwsh**） | `Screen.PrimaryScreen` + `CopyFromScreen` → PNG |
| Linux 及其他 | 不支持 | 明确报「暂不支持」，请用 `source=path` 传图片文件 |

临时文件落项目内 `tmp/`（回退系统临时目录），用完即删、失败即清理；读图不依赖 brew / choco 等额外安装。`source=base64` 全程内存解码，不写临时文件。

## 图片格式

支持 PNG、JPEG、GIF、WebP、BMP，以及 **HEIC/HEIF**（iPhone 等常见格式）。

| 平台 | HEIC/HEIF 处理 |
|---|---|
| macOS | 系统自带 `sips` 转 PNG 后再校验/送模（本机 sharp 未编入 HEVC，不可直接解码） |
| 其它 | 尝试 sharp 转 PNG；若失败则明确报错，提示改为 PNG/JPEG 或在 macOS 上使用 |

流水线在魔数校验与完整解码**之前**先 `ensureRasterImage`，因此送模 MIME 始终来自转码后的栅格图（通常为 PNG）。可选 `region` 在 `verifyImage` 之后、`prepareImageForModel` 之前裁切（先裁感兴趣区，再按最长边缩图）。

## 工作区约定

- **错误可定位**：工具错误返回 `[deepseek-vision 内部错误] <异常类型>: <信息>`；
- **默认静默日志**：诊断进工具返回文本，不落日志文件；排错时设 `DEEPSEEK_VISION_LOG_LEVEL`；
- **图片校验**：魔数 + sharp **完整解码**（仅 metadata 会漏检「头部完整、主体截断」，spike 实测后采用完整解码，对齐 Pillow `verify()`）；HEIC/HEIF 在 macOS 经 `sips` 转 PNG；
- **空 content 重试**：模型把 token 预算耗在 reasoning 上返回空 content 时，自动重试 1 次并加倍 `max_tokens`（钳 8192），错误带 `finish_reason` 与 reasoning 前 200 字；
- **剪贴板临时文件**：优先项目内 `tmp/`（回退系统临时目录），用完即删。

## 迁移对照（Python mimo-vision → TS deepseek-vision）

| 项 | Python | TS | 差异 |
|---|---|---|---|
| 工具 | 12 个（5 剪贴板 + 7 磁盘） | 8 个（7 单图 + `compare_images`） | 来源参数化合并 |
| 错误前缀 | `[mimo-vision 内部错误]` | `[deepseek-vision 内部错误]` | 随新名（已定决策） |
| 模型调用 | `AsyncOpenAI` | `openai` v7 | 端点/参数一致 |
| 超时 | httpx 四段（connect 10 / read 120 / write 60 / pool 10） | openai 整体 120s | openai-node 仅支持单值，120s 对齐 read |
| reasoning 提取 | SDK 属性 / model_extra | 直接属性（SDK 保留未知字段，spike 实测） | 更简单，无需 raw 解析 |
| 图片校验 | Pillow `verify()` | sharp 完整解码 | 语义对齐（spike 实测深截断） |
| 剪贴板 | PIL ImageGrab → pngpaste 回退 | darwin `pngpaste`；win32 `powershell.exe` | 方案 A：darwin 维持 pngpaste，新增 win32 完整支持；Linux 未支持 |
| 日志开关 | `VISION_LOG_LEVEL` | `DEEPSEEK_VISION_LOG_LEVEL` | 随新名 |

## 开发状态（2026-08-07）

- [x] 骨架 + config / image / reasoning / clipboard 基础模块
- [x] tools / server：8 工具（7 单图 `source` + `compare_images`）+ 空 content 重试逻辑
- [x] spike 验证：reasoning_content 在 openai v7 原样保留；sharp 需完整解码
- [x] 对照清单零成本回归（工具名/schema/PROMPTS/env 名/错误前缀，逐项比对）
- [x] 真实 API smoke（2026-08-07：B1.1–B1.8 全过）
- [x] 剪贴板方案 A（2026-08-07）：darwin `pngpaste` + win32 `powershell.exe`；Linux 明确暂不支持；45 单测；macOS 真机 smoke（截图→读图→校验链）通过
- [x] P2/P3 收口（2026-08-08）：剪贴板超时阶段标注、未知工具前缀、`.env` 引号内 `#`、MIME 魔数、README/`VISION_MAX_IMAGE_PIXELS` 等

## License

MIT
