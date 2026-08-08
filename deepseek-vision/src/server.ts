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
import { makeLogger, makeToolError } from 'mcp-common';
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
  mimeSubtypeFromMagic,
} from './image.js';
import { extractReasoning } from './reasoning.js';
import { saveClipboardImage } from './clipboard.js';
import { buildTools, PROMPTS } from './tools.js';

const SERVER_NAME = 'deepseek-vision';
const SERVER_VERSION = '0.3.0';
// keyless：有意不以 isError 返回，便于 agent 把设置指引转述给用户（配置提示，非工具执行失败）。
const KEYLESS_GUIDANCE =
  '❌ OPENCODE_API_KEY is not set.\n\n' +
  '1. Open https://opencode.ai/auth and copy an API Key\n' +
  '2. Set OPENCODE_API_KEY in the env of this MCP server (CC Switch).';

// ---- 工作区约定（mcp-common 单一实现）----
export const toolError = makeToolError('deepseek-vision');
export const log = makeLogger('deepseek-vision', 'DEEPSEEK_VISION_LOG_LEVEL');

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

  async analyze(imagePath: string, prompt: string): Promise<string> {
    const p = validateImagePath(imagePath);
    const data = await readFile(p);
    validateMagic(data);
    await verifyImage(data);

    const mime = mimeSubtypeFromMagic(data);
    const b64 = data.toString('base64');

    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'image_url' as const, image_url: { url: `data:image/${mime};base64,${b64}` } },
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
          `模型输出被截断（finish_reason=length，reasoning 占满 token 配额），已自动重试并加倍 max_tokens 仍为空。请增大 VISION_MAX_TOKENS 后重试。${reasoningHint}`
        );
      }
      throw new Error(
        `模型未返回正文（finish_reason=${finishReason}），已自动重试 1 次仍为空。${reasoningHint}`
      );
    }
    throw new Error('模型未返回正文'); // unreachable
  }
}

async function runImage(
  client: VisionClient,
  promptKey: string,
  imagePath: string,
  override?: string
): Promise<string> {
  const prompt = override || PROMPTS[promptKey];
  return client.analyze(imagePath, prompt);
}

async function runClipboard(
  client: VisionClient,
  promptKey: string,
  override?: string
): Promise<string> {
  const path = await saveClipboardImage();
  try {
    return await runImage(client, promptKey, path, override);
  } finally {
    try {
      await unlink(path); // 用完删除临时文件
    } catch {
      /* 忽略 */
    }
  }
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

      const promptKeyByTool: Record<string, string> = {
        analyze_image: 'analyze',
        extract_text: 'extract_text',
        describe_ui: 'describe_ui',
        diagnose_error: 'diagnose_error',
        understand_diagram: 'understand_diagram',
        analyze_chart: 'analyze_chart',
        code_from_screenshot: 'code_from_screenshot',
      };
      const promptKey = promptKeyByTool[name];
      if (!promptKey) {
        return {
          content: [
            {
              type: 'text',
              text: toolError('ValidationError', `未知工具: ${name}`),
            },
          ],
          isError: true,
        };
      }

      const source = args.source;
      if (source !== 'clipboard' && source !== 'path') {
        return {
          content: [
            {
              type: 'text',
              text: toolError(
                'ValidationError',
                `source must be "clipboard" or "path", got: ${JSON.stringify(source)}`
              ),
            },
          ],
          isError: true,
        };
      }

      const override =
        name === 'analyze_image' && typeof args.prompt === 'string'
          ? args.prompt
          : undefined;
      let text: string;
      if (source === 'clipboard') {
        text = await runClipboard(visionClient, promptKey, override);
      } else {
        if (!args.image_path) {
          return {
            content: [
              {
                type: 'text',
                text: toolError(
                  'ValidationError',
                  'image_path is required when source=path'
                ),
              },
            ],
            isError: true,
          };
        }
        if (typeof args.image_path !== 'string') {
          return {
            content: [
              {
                type: 'text',
                text: toolError(
                  'ValidationError',
                  `image_path must be a string, got ${typeof args.image_path}`
                ),
              },
            ],
            isError: true,
          };
        }
        text = await runImage(
          visionClient,
          promptKey,
          args.image_path,
          override
        );
      }
      return { content: [{ type: 'text', text }] };
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
