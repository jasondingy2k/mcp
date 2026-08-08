# deepseek-vision MCP Server

迁移自 `mimo-vision-mcp`（Python）的 TS 版：剪贴板优先的视觉 MCP，为 DeepSeek 系纯文本 agent（如 OpenCode Go DeepSeek）提供看图能力，模型走 OpenCode Go `mimo-v2.5`（OpenAI 兼容端点）。

## 功能（7 个工具）

能力 = 工具名；来源用 `source` 参数（`clipboard` | `path`）。`source=path` 时需传 `image_path`。

| 工具 | 说明 |
|---|---|
| `analyze_image` | 通用描述；可选 `prompt` 覆盖 |
| `extract_text` | OCR 提取文字 |
| `describe_ui` | UI 截图分析 |
| `diagnose_error` | 错误截图诊断 |
| `understand_diagram` | 流程图 / 架构图解读 |
| `analyze_chart` | 数据图表分析 |
| `code_from_screenshot` | 从截图提取代码 |

## 构建与运行

要求 Node 20+；macOS 剪贴板读图依赖 `pngpaste`（`brew install pngpaste`）；Windows 用系统自带 `powershell.exe`；Linux 未支持，请用 `source=path`。

```bash
npm install
npm run build
node build/index.js        # stdio 传输，接入 CC Switch / Claude Code 等 MCP 客户端
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
| `VISION_MODEL` | `VISION_MODEL_NAME` 的兼容别名 |
| `DEEPSEEK_VISION_LOG_LEVEL` | 诊断日志级别 debug/info/warn/error；缺省为静默 |

`.env` 加载约定：支持 `export ` 前缀、` #` 内联注释；非法值（如 null 字节）跳过不崩溃；启动时只加载一次；已有环境变量不被覆盖。参考 `.env.example`。

## 剪贴板平台支持

| 平台 | 读取方式 | 说明 |
|---|---|---|
| macOS | `pngpaste`（brew） | 直接写 PNG 单次落盘（本机实测 pbpaste 读图不可用，故维持 pngpaste）；文本/空剪贴板报明确无图错误 |
| Windows | 系统自带 `powershell.exe`（5.x，默认 STA；**勿用 pwsh**） | `Clipboard.GetImage()` → `Save(Png)` 单次落盘 |
| Linux 及其他 | 不支持 | 明确报「暂不支持」，请用 `source=path` 传图片文件 |

临时文件落项目内 `tmp/`（回退系统临时目录），用完即删、失败即清理；读图不依赖 brew / choco 等额外安装。

## 工作区约定

- **错误可定位**：工具错误返回 `[deepseek-vision 内部错误] <异常类型>: <信息>`；
- **默认静默日志**：诊断进工具返回文本，不落日志文件；排错时设 `DEEPSEEK_VISION_LOG_LEVEL`；
- **图片校验**：魔数 + sharp **完整解码**（仅 metadata 会漏检「头部完整、主体截断」，spike 实测后采用完整解码，对齐 Pillow `verify()`）；
- **空 content 重试**：模型把 token 预算耗在 reasoning 上返回空 content 时，自动重试 1 次并加倍 `max_tokens`（钳 8192），错误带 `finish_reason` 与 reasoning 前 200 字；
- **剪贴板临时文件**：优先项目内 `tmp/`（回退系统临时目录），用完即删。

## 迁移对照（Python mimo-vision → TS deepseek-vision）

| 项 | Python | TS | 差异 |
|---|---|---|---|
| 工具 | 12 个（5 剪贴板 + 7 磁盘） | 7 个（能力工具 + `source`） | 来源参数化合并 |
| 错误前缀 | `[mimo-vision 内部错误]` | `[deepseek-vision 内部错误]` | 随新名（已定决策） |
| 模型调用 | `AsyncOpenAI` | `openai` v7 | 端点/参数一致 |
| 超时 | httpx 四段（connect 10 / read 120 / write 60 / pool 10） | openai 整体 120s | openai-node 仅支持单值，120s 对齐 read |
| reasoning 提取 | SDK 属性 / model_extra | 直接属性（SDK 保留未知字段，spike 实测） | 更简单，无需 raw 解析 |
| 图片校验 | Pillow `verify()` | sharp 完整解码 | 语义对齐（spike 实测深截断） |
| 剪贴板 | PIL ImageGrab → pngpaste 回退 | darwin `pngpaste`；win32 `powershell.exe` | 方案 A：darwin 维持 pngpaste，新增 win32 完整支持；Linux 未支持 |
| 日志开关 | `VISION_LOG_LEVEL` | `DEEPSEEK_VISION_LOG_LEVEL` | 随新名 |

## 开发状态（2026-08-07）

- [x] 骨架 + config / image / reasoning / clipboard 基础模块
- [x] tools / server：7 工具（`source` 参数化）+ 空 content 重试逻辑
- [x] spike 验证：reasoning_content 在 openai v7 原样保留；sharp 需完整解码
- [x] 对照清单零成本回归（工具名/schema/PROMPTS/env 名/错误前缀，逐项比对）
- [x] 真实 API smoke（2026-08-07：B1.1–B1.8 全过）
- [x] 剪贴板方案 A（2026-08-07）：darwin `pngpaste` + win32 `powershell.exe`；Linux 明确暂不支持；45 单测；macOS 真机 smoke（截图→读图→校验链）通过
- [x] P2/P3 收口（2026-08-08）：剪贴板超时阶段标注、未知工具前缀、`.env` 引号内 `#`、MIME 魔数、README/`VISION_MAX_IMAGE_PIXELS` 等

## License

MIT
