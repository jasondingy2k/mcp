// server.ts — MCP server（deepseek-vision）+ VisionClient（OpenCode Go MiMo-V2.5）
// 约定：错误前缀 [deepseek-vision 内部错误]；默认静默日志（DEEPSEEK_VISION_LOG_LEVEL 开启）；
// 空 content 自动重试 1 次并加倍 max_tokens（对齐 Python 版，mimo-v2.5 会把 token 预算耗在 reasoning 上）。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import OpenAI from 'openai';
import { readFile, unlink } from 'fs/promises';
import { makeLogger } from './logging.js';
import { makeToolError } from './errors.js';
import {
  apiKey,
  baseUrl,
  maxTokens,
  modelName,
  ANALYZE_TOTAL_TIMEOUT_MS,
  retryMaxTokens,
} from './config.js';
import {
  validateImagePath,
  validateMagic,
  verifyImage,
  prepareImageForModel,
  loadImageBufferFromBase64,
  ensureRasterImage,
  parseRegion,
  applyRegion,
  type ImageRegion,
} from './image.js';
import { extractReasoning } from './reasoning.js';
import { saveClipboardImage } from './clipboard.js';
import { saveScreenshotImage } from './screenshot.js';
import {
  applyFormat,
  applyLang,
  buildTools,
  parseToolJson,
  PROMPTS,
  VISION_CAPABILITIES,
  type VisionCapability,
  type VisionFormat,
  type VisionLang,
} from './tools.js';

const SERVER_NAME = 'deepseek-vision';
const SERVER_VERSION = '0.4.3';
const FORMAT_SUPPORTED_CAPABILITIES = new Set<VisionCapability>(['describe_ui', 'diagnose_error']);
const VALID_CAPABILITIES = new Set<string>(VISION_CAPABILITIES);
type ImageSource = 'clipboard' | 'path' | 'screenshot' | 'base64';

const VALID_SOURCES: ImageSource[] = ['clipboard', 'path', 'screenshot', 'base64'];
// keyless：有意不以 isError 返回，便于 agent 把设置指引转述给用户（配置提示，非工具执行失败）。
const KEYLESS_GUIDANCE =
  'OPENCODE_API_KEY unset. Set OPENCODE_API_KEY (or VISION_API_KEY) in MCP server env.';

// ---- 静默日志 + 错误前缀 ----
export const toolError = makeToolError('deepseek-vision');
export const log = makeLogger('deepseek-vision', 'DEEPSEEK_VISION_LOG_LEVEL');

export async function prepareVisionPayload(
  data: Buffer,
  region?: ImageRegion
): Promise<{ mime: string; b64: string }> {
  data = await ensureRasterImage(data);
  validateMagic(data);
  await verifyImage(data);
  if (region !== undefined) {
    data = await applyRegion(data, region);
  }

  const prepared = await prepareImageForModel(data);
  return {
    mime: prepared.mime,
    b64: prepared.buffer.toString('base64'),
  };
}

async function loadSourceBuffer(
  source: ImageSource,
  args: { image_path?: string; image_base64?: string }
): Promise<Buffer> {
  if (source === 'clipboard') {
    const path = await saveClipboardImage();
    try {
      return await readFile(validateImagePath(path));
    } finally {
      try {
        await unlink(path);
      } catch {
        /* 忽略 */
      }
    }
  }
  if (source === 'screenshot') {
    const path = await saveScreenshotImage();
    try {
      return await readFile(validateImagePath(path));
    } finally {
      try {
        await unlink(path);
      } catch {
        /* 忽略 */
      }
    }
  }
  if (source === 'base64') {
    return loadImageBufferFromBase64(args.image_base64!);
  }
  return readFile(validateImagePath(args.image_path!));
}

function isValidSource(value: unknown): value is ImageSource {
  return VALID_SOURCES.includes(value as ImageSource);
}

export class VisionClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKeyValue: string, baseURL: string, model: string) {
    this.model = model;
    this.client = new OpenAI({
      apiKey: apiKeyValue,
      baseURL,
      // 单请求上限；analyze 另有 ANALYZE_TOTAL_TIMEOUT_MS 总墙钟（含重试）。
      timeout: ANALYZE_TOTAL_TIMEOUT_MS,
      // 空 content 已手动重试，关掉 SDK 自动重试避免叠乘。
      maxRetries: 0,
    });
  }

  async analyzeData(data: Buffer, prompt: string, region?: ImageRegion): Promise<string> {
    const payload = await prepareVisionPayload(data, region);
    return this.chatWithImages([payload], prompt);
  }

  async analyzeCompare(
    payloadA: { mime: string; b64: string },
    payloadB: { mime: string; b64: string },
    prompt: string
  ): Promise<string> {
    const text = `Image A is the first image; Image B is the second.\n\n${prompt}`;
    return this.chatWithImages([payloadA, payloadB], text);
  }

  private async chatWithImages(
    images: Array<{ mime: string; b64: string }>,
    prompt: string
  ): Promise<string> {
    const messages = [
      {
        role: 'user' as const,
        content: [
          ...images.map(({ mime, b64 }) => ({
            type: 'image_url' as const,
            image_url: { url: `data:image/${mime};base64,${b64}` },
          })),
          { type: 'text' as const, text: prompt },
        ],
      },
    ];

    // 自动重试 1 次：空 content 时 max_tokens 用 retryMaxTokens（不向下钳制）。
    // 总墙钟 ANALYZE_TOTAL_TIMEOUT_MS，避免 120s×2 静默挂起。
    const started = Date.now();
    const base = maxTokens();
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = ANALYZE_TOTAL_TIMEOUT_MS - (Date.now() - started);
      if (remaining < 3_000) {
        throw new Error('视觉推理总超时（卡在 视觉推理）');
      }
      const tokens = attempt === 0 ? base : retryMaxTokens(base);
      let response;
      try {
        response = await this.client.chat.completions.create(
          {
            model: this.model,
            messages,
            temperature: 0.3,
            max_tokens: tokens,
          },
          { timeout: remaining }
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/timeout|ETIMEDOUT|timed out/i.test(msg) || (e as { name?: string })?.name?.includes('Timeout')) {
          throw new Error(`视觉推理单次请求超时（卡在 视觉推理）: ${msg.slice(0, 120)}`);
        }
        throw e;
      }

      if (!response.choices?.length) {
        throw new Error('模型返回空 choices');
      }

      const msg: any = response.choices[0].message;
      let content = '';
      const rawContent = msg?.content;
      if (typeof rawContent === 'string') {
        content = rawContent;
      } else if (Array.isArray(rawContent)) {
        content = rawContent
          .map((part: any) =>
            part && typeof part === 'object' && 'text' in part ? String(part.text ?? '') : ''
          )
          .join('');
      } else if (rawContent != null) {
        content = String(rawContent);
      }
      if (content) return content;

      const finishReason = response.choices[0].finish_reason;
      const reasoning = extractReasoning(msg);
      const reasoningHint = reasoning ? `；reasoning 前 200 字: ${reasoning.slice(0, 200)}` : '';

      if (attempt === 0) {
        log(
          'warn',
          `模型返回空 content（finish_reason=${finishReason}${reasoningHint}），自动重试一次，max_tokens 加倍为 ${retryMaxTokens(base)}`
        );
        continue;
      }

      if (finishReason === 'length') {
        throw new Error(
          `empty content after retry (finish_reason=length). increase VISION_MAX_TOKENS and retry${reasoningHint}`
        );
      }
      throw new Error(
        `empty content after retry (finish_reason=${finishReason})${reasoningHint}`
      );
    }
    throw new Error('模型未返回正文'); // unreachable
  }

  async analyze(imagePath: string, prompt: string, region?: ImageRegion): Promise<string> {
    const p = validateImagePath(imagePath);
    const data = await readFile(p);
    return this.analyzeData(data, prompt, region);
  }
}

function applyFormatPostProcess(
  text: string,
  promptKey: string,
  format?: VisionFormat
): string {
  if (format === 'json' && FORMAT_SUPPORTED_CAPABILITIES.has(promptKey as VisionCapability)) {
    return parseToolJson(text, promptKey as 'diagnose_error' | 'describe_ui');
  }
  return text;
}

function validationError(message: string): {
  content: Array<{ type: string; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: toolError('ValidationError', message) }],
    isError: true,
  };
}

function resolveCapability(
  toolName: string,
  args: Record<string, unknown>
):
  | { ok: true; capability: VisionCapability }
  | { ok: false; response: ReturnType<typeof validationError> } {
  if (toolName === 'deepseek_vision') {
    const capability = args.capability;
    if (capability === undefined || capability === null || capability === '') {
      return {
        ok: false,
        response: validationError('capability is required'),
      };
    }
    if (typeof capability !== 'string' || !VALID_CAPABILITIES.has(capability)) {
      return {
        ok: false,
        response: validationError(
          `capability must be one of: ${VISION_CAPABILITIES.join(', ')}, got: ${JSON.stringify(capability)}`
        ),
      };
    }
    return { ok: true, capability: capability as VisionCapability };
  }

  return {
    ok: false,
    response: validationError(`未知工具: ${toolName}`),
  };
}

async function runDeepseekVision(
  client: VisionClient,
  capability: VisionCapability,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  if (args.prompt !== undefined && capability !== 'analyze') {
    return validationError('prompt is only supported when capability=analyze');
  }

  let lang: VisionLang | undefined;
  if (args.lang !== undefined) {
    if (args.lang !== 'zh' && args.lang !== 'en') {
      return validationError(
        `lang must be "zh" or "en", got: ${JSON.stringify(args.lang)}`
      );
    }
    lang = args.lang;
  }

  let format: VisionFormat | undefined;
  if (args.format !== undefined) {
    if (args.format !== 'text' && args.format !== 'json') {
      return validationError(
        `format must be "text" or "json", got: ${JSON.stringify(args.format)}`
      );
    }
    if (!FORMAT_SUPPORTED_CAPABILITIES.has(capability)) {
      return validationError(
        'format is only supported when capability is describe_ui or diagnose_error'
      );
    }
    format = args.format;
  }

  let region: ImageRegion | undefined;
  if (args.region !== undefined) {
    try {
      region = parseRegion(args.region);
    } catch (e) {
      const type = e instanceof Error ? e.name : 'Error';
      const message = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: toolError(type, message) }], isError: true };
    }
  }

  const source = args.source;
  if (!isValidSource(source)) {
    return validationError(
      `source must be "clipboard", "path", "screenshot", or "base64", got: ${JSON.stringify(source)}`
    );
  }

  const promptKey = capability;
  const override =
    capability === 'analyze' && typeof args.prompt === 'string' ? args.prompt : undefined;

  let text: string;
  if (source === 'clipboard') {
    text = await runClipboard(client, promptKey, override, lang, format, region);
  } else if (source === 'screenshot') {
    text = await runScreenshot(client, promptKey, override, lang, format, region);
  } else if (source === 'base64') {
    if (!args.image_base64) {
      return validationError('image_base64 is required when source=base64');
    }
    if (typeof args.image_base64 !== 'string') {
      return validationError(
        `image_base64 must be a string, got ${typeof args.image_base64}`
      );
    }
    text = await runBase64(
      client,
      promptKey,
      args.image_base64,
      override,
      lang,
      format,
      region
    );
  } else {
    if (!args.image_path) {
      return validationError('image_path is required when source=path');
    }
    if (typeof args.image_path !== 'string') {
      return validationError(
        `image_path must be a string, got ${typeof args.image_path}`
      );
    }
    text = await runImage(
      client,
      promptKey,
      args.image_path,
      override,
      lang,
      format,
      region
    );
  }
  return { content: [{ type: 'text', text }] };
}

function buildPrompt(
  promptKey: string,
  override?: string,
  lang?: VisionLang,
  format?: VisionFormat
): string {
  const base = override ?? PROMPTS[promptKey];
  return applyLang(applyFormat(base, format, promptKey), lang, promptKey, format);
}

async function runImage(
  client: VisionClient,
  promptKey: string,
  imagePath: string,
  override?: string,
  lang?: VisionLang,
  format?: VisionFormat,
  region?: ImageRegion
): Promise<string> {
  const prompt = buildPrompt(promptKey, override, lang, format);
  const text = await client.analyze(imagePath, prompt, region);
  return applyFormatPostProcess(text, promptKey, format);
}

async function runBase64(
  client: VisionClient,
  promptKey: string,
  imageBase64: string,
  override?: string,
  lang?: VisionLang,
  format?: VisionFormat,
  region?: ImageRegion
): Promise<string> {
  const prompt = buildPrompt(promptKey, override, lang, format);
  const data = loadImageBufferFromBase64(imageBase64);
  const text = await client.analyzeData(data, prompt, region);
  return applyFormatPostProcess(text, promptKey, format);
}

async function runClipboard(
  client: VisionClient,
  promptKey: string,
  override?: string,
  lang?: VisionLang,
  format?: VisionFormat,
  region?: ImageRegion
): Promise<string> {
  const path = await saveClipboardImage();
  try {
    return await runImage(client, promptKey, path, override, lang, format, region);
  } finally {
    try {
      await unlink(path); // 用完删除临时文件
    } catch {
      /* 忽略 */
    }
  }
}

async function runScreenshot(
  client: VisionClient,
  promptKey: string,
  override?: string,
  lang?: VisionLang,
  format?: VisionFormat,
  region?: ImageRegion
): Promise<string> {
  const path = await saveScreenshotImage();
  try {
    return await runImage(client, promptKey, path, override, lang, format, region);
  } finally {
    try {
      await unlink(path);
    } catch {
      /* 忽略 */
    }
  }
}

async function runCompareImages(
  client: VisionClient,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  if (args.lang !== undefined) {
    if (args.lang !== 'zh' && args.lang !== 'en') {
      return {
        content: [
          {
            type: 'text',
            text: toolError(
              'ValidationError',
              `lang must be "zh" or "en", got: ${JSON.stringify(args.lang)}`
            ),
          },
        ],
        isError: true,
      };
    }
  }
  const lang = args.lang as VisionLang | undefined;

  let regionA: ImageRegion | undefined;
  if (args.region_a !== undefined) {
    try {
      regionA = parseRegion(args.region_a);
    } catch (e) {
      const type = e instanceof Error ? e.name : 'Error';
      const message = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: toolError(type, message) }], isError: true };
    }
  }

  let regionB: ImageRegion | undefined;
  if (args.region_b !== undefined) {
    try {
      regionB = parseRegion(args.region_b);
    } catch (e) {
      const type = e instanceof Error ? e.name : 'Error';
      const message = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: toolError(type, message) }], isError: true };
    }
  }

  for (const [field, suffix] of [
    ['source_a', 'a'],
    ['source_b', 'b'],
  ] as const) {
    const source = args[field];
    if (!isValidSource(source)) {
      return {
        content: [
          {
            type: 'text',
            text: toolError(
              'ValidationError',
              `${field} must be "clipboard", "path", "screenshot", or "base64", got: ${JSON.stringify(source)}`
            ),
          },
        ],
        isError: true,
      };
    }
    if (source === 'path') {
      const pathKey = `image_path_${suffix}`;
      if (!args[pathKey]) {
        return {
          content: [
            {
              type: 'text',
              text: toolError(
                'ValidationError',
                `${pathKey} is required when ${field}=path`
              ),
            },
          ],
          isError: true,
        };
      }
      if (typeof args[pathKey] !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: toolError(
                'ValidationError',
                `${pathKey} must be a string, got ${typeof args[pathKey]}`
              ),
            },
          ],
          isError: true,
        };
      }
    }
    if (source === 'base64') {
      const b64Key = `image_base64_${suffix}`;
      if (!args[b64Key]) {
        return {
          content: [
            {
              type: 'text',
              text: toolError(
                'ValidationError',
                `${b64Key} is required when ${field}=base64`
              ),
            },
          ],
          isError: true,
        };
      }
      if (typeof args[b64Key] !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: toolError(
                'ValidationError',
                `${b64Key} must be a string, got ${typeof args[b64Key]}`
              ),
            },
          ],
          isError: true,
        };
      }
    }
  }

  const override = typeof args.prompt === 'string' ? args.prompt : undefined;
  const prompt = applyLang(
    override ?? PROMPTS.compare,
    lang,
    'compare'
  );

  const sourceA = args.source_a as ImageSource;
  const sourceB = args.source_b as ImageSource;
  const dataA = await loadSourceBuffer(sourceA, {
    image_path: args.image_path_a as string | undefined,
    image_base64: args.image_base64_a as string | undefined,
  });
  const dataB = await loadSourceBuffer(sourceB, {
    image_path: args.image_path_b as string | undefined,
    image_base64: args.image_base64_b as string | undefined,
  });

  const payloadA = await prepareVisionPayload(dataA, regionA);
  const payloadB = await prepareVisionPayload(dataB, regionB);
  const text = await client.analyzeCompare(payloadA, payloadB, prompt);
  return { content: [{ type: 'text', text }] };
}

export function createServer(visionClient: VisionClient | null): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    if (!visionClient) {
      return { content: [{ type: 'text', text: KEYLESS_GUIDANCE }] };
    }

    try {
      const args = request.params.arguments ?? {};
      const name: string = request.params.name;

      if (name === 'compare_images') {
        return await runCompareImages(visionClient, args);
      }

      const resolved = resolveCapability(name, args);
      if (!resolved.ok) {
        return resolved.response;
      }

      return await runDeepseekVision(visionClient, resolved.capability, args);
    } catch (e) {
      const type = e instanceof Error ? e.name : 'Error';
      const message = e instanceof Error ? e.message : String(e);
      log('error', `调用工具 ${request.params.name} 失败: ${type}: ${message}`);
      return {
        content: [{ type: 'text', text: toolError(type, message) }],
        isError: true,
      };
    }
  });

  server.onerror = (error: any) => {
    log('error', `[MCP Error] ${error?.message ?? error}`);
  };

  return server;
}
