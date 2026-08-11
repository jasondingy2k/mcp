// server.ts — MCP server（deepseek-vision）+ VisionClient（OpenCode Go MiMo-V2.5）
// 约定：错误前缀 [deepseek-vision 内部错误]；默认静默日志（DEEPSEEK_VISION_LOG_LEVEL 开启）；
// 空 content 自动重试 1 次并加倍 max_tokens（对齐 Python 版，mimo-v2.5 会把 token 预算耗在 reasoning 上）。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import OpenAI from 'openai';
import { statSync } from 'fs';
import { isAbsolute } from 'path';
import { makeLogger } from './logging.js';
import { makeToolError } from './errors.js';
import {
  maxTokens,
  primaryProbeTimeoutMs,
  reasoningEffort,
  ANALYZE_TOTAL_TIMEOUT_MS,
  retryMaxTokens,
  type ReasoningEffortCapability,
  type VisionProvider,
} from './config.js';
import {
  validateMagic,
  verifyImage,
  prepareImageForModel,
  loadImageBufferFromBase64,
  ensureRasterImage,
  parseRegion,
  applyRegion,
  detectSourceFormat,
  looksLikeImageBase64,
  readImageFile,
  type ImageRegion,
} from './image.js';
import { PipelineBudget } from './pipeline-budget.js';
import { removeTempFile } from './temp-manager.js';
import { extractReasoning } from './reasoning.js';
import { saveClipboardImage } from './clipboard.js';
import { saveScreenshotImage } from './screenshot.js';
import { VISION_SYSTEM_GUARD } from './guards.js';
import { buildTools, enhanceComparePrompt, enhancePrompt } from './tools.js';
import {
  classifyFailure,
  isNetworkOrBlockError,
  isUnsupportedReasoningEffortError,
  redactKeys,
  RoundRobin,
} from './keypool.js';

const SERVER_NAME = 'deepseek-vision';
const SERVER_VERSION = '0.5.0';

type ResolvedImageSource =
  | { kind: 'clipboard' }
  | { kind: 'screenshot' }
  | { kind: 'path'; path: string }
  | { kind: 'base64'; data: string };

// keyless：有意不以 isError 返回，便于 agent 把设置指引转述给用户（配置提示，非工具执行失败）。
const KEYLESS_GUIDANCE =
  'OPENCODE_API_KEY unset. Set OPENCODE_API_KEY (or VISION_API_KEY) and/or VISION_FALLBACK_API_KEY. Same pool: comma-separated equal RR; key-scoped errors (auth/429/quota) rotate keys; provider-scoped errors (network/5xx/model/empty) skip to fallback.';

// ---- 静默日志 + 错误前缀 ----
export const toolError = makeToolError('deepseek-vision');
export const log = makeLogger('deepseek-vision', 'DEEPSEEK_VISION_LOG_LEVEL');

/** vision 缺省 image → clipboard；解析字面量/路径/base64 */
export function resolveImageSource(image: string | undefined): ResolvedImageSource {
  if (image === undefined || image === '') {
    return { kind: 'clipboard' };
  }
  if (typeof image !== 'string') {
    throw new Error('image must be a string（卡在 图片解析）');
  }
  const trimmed = image.trim();
  if (trimmed === 'clipboard') {
    return { kind: 'clipboard' };
  }
  if (trimmed === 'screenshot') {
    return { kind: 'screenshot' };
  }
  if (looksLikeImageBase64(trimmed)) {
    return { kind: 'base64', data: trimmed };
  }
  if (isAbsolute(trimmed)) {
    try {
      const st = statSync(trimmed);
      if (st.isFile()) {
        return { kind: 'path', path: trimmed };
      }
      throw new Error(`不是一个文件: ${trimmed}（卡在 图片解析）`);
    } catch (e) {
      if (e instanceof Error && e.message.includes('（卡在 图片解析）')) throw e;
      throw new Error(`不是一个文件: ${trimmed}（卡在 图片解析）`);
    }
  }
  throw new Error(
    `image must be clipboard, screenshot, absolute path, or base64/data URL; got: ${JSON.stringify(image)}（卡在 图片解析）`
  );
}

export async function prepareVisionPayload(
  data: Buffer,
  region?: ImageRegion,
  budget?: PipelineBudget
): Promise<{ mime: string; b64: string }> {
  // HEIC→PNG 会抹掉源格式；须在 ensureRasterImage 前记录，照片仍走 JPEG
  const sourceFormat = detectSourceFormat(data);
  data = await ensureRasterImage(data, undefined, budget);
  validateMagic(data);
  await verifyImage(data, budget);
  if (region !== undefined) {
    data = await applyRegion(data, region, budget, sourceFormat);
  }

  const prepared = await prepareImageForModel(data, budget, sourceFormat);
  return {
    mime: prepared.mime,
    b64: prepared.buffer.toString('base64'),
  };
}

async function loadResolvedBuffer(
  resolved: ResolvedImageSource,
  budget?: PipelineBudget
): Promise<Buffer> {
  budget?.assertRemaining('图片读取', 1_000);
  if (resolved.kind === 'clipboard') {
    const path = await saveClipboardImage(budget);
    try {
      return await readImageFile(path, budget);
    } finally {
      await removeTempFile(path);
    }
  }
  if (resolved.kind === 'screenshot') {
    const path = await saveScreenshotImage(budget);
    try {
      return await readImageFile(path, budget);
    } finally {
      await removeTempFile(path);
    }
  }
  if (resolved.kind === 'base64') {
    return loadImageBufferFromBase64(resolved.data);
  }
  return readImageFile(resolved.path, budget);
}

type VisionTier = {
  name: string;
  model: string;
  keys: string[];
  pool: RoundRobin;
  clients: Map<string, OpenAI>;
  reasoningEffortCapability: ReasoningEffortCapability;
  /** auto 模式下端点拒绝 reasoning_effort 后，本池后续请求省略该字段 */
  omitReasoningEffort: boolean;
};

function extractMessageContent(msg: unknown): string {
  const rawContent = (msg as { content?: unknown })?.content;
  let content = '';
  if (typeof rawContent === 'string') {
    content = rawContent;
  } else if (Array.isArray(rawContent)) {
    content = rawContent
      .map((part: unknown) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as { text?: unknown }).text ?? '')
          : ''
      )
      .join('');
  } else if (rawContent != null) {
    content = String(rawContent);
  }
  return content.trim();
}

function shouldIncludeReasoningEffort(
  capability: ReasoningEffortCapability,
  omitCached: boolean
): boolean {
  if (omitCached || capability === 'unsupported') return false;
  if (capability === 'supported') return reasoningEffort() !== 'none';
  // auto：none 时省略；否则先发送，遇 unknown field 再窄降级
  return reasoningEffort() !== 'none';
}

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: unknown[] };

function buildChatBody(
  tier: VisionTier,
  messages: ChatMessage[],
  tokens: number,
  omitReasoningEffort: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: tier.model,
    messages,
    temperature: 0.3,
    max_tokens: tokens,
  };
  if (shouldIncludeReasoningEffort(tier.reasoningEffortCapability, omitReasoningEffort)) {
    body.reasoning_effort = reasoningEffort();
  }
  return body;
}

async function createChatCompletion(
  client: OpenAI,
  tier: VisionTier,
  messages: ChatMessage[],
  tokens: number,
  omitReasoningEffort: boolean,
  attemptTimeout: number
): Promise<{ response: OpenAI.Chat.Completions.ChatCompletion; omitReasoningEffort: boolean }> {
  let omit = omitReasoningEffort;
  for (;;) {
    try {
      const body = buildChatBody(tier, messages, tokens, omit);
      const response = await client.chat.completions.create(body as any, {
        timeout: attemptTimeout,
      });
      return { response, omitReasoningEffort: omit };
    } catch (e) {
      if (isUnsupportedReasoningEffortError(e) && !omit) {
        tier.omitReasoningEffort = true;
        omit = true;
        continue;
      }
      throw e;
    }
  }
}

/** 视觉推理阶段统一标注：追加「卡在 视觉推理」；已标注则原样返回 */
function withVisionStage(message: string): string {
  return message.includes('（卡在 视觉推理）') ? message : `${message}（卡在 视觉推理）`;
}

/** 远程错误保留原类型与栈，仅补阶段标注（幂等） */
function annotateVisionStage(err: unknown): unknown {
  if (err instanceof Error) {
    err.message = withVisionStage(err.message);
  }
  return err;
}

export class VisionClient {
  private tiers: VisionTier[];
  private allKeys: string[];

  constructor(providers: VisionProvider[]) {
    this.tiers = [];
    this.allKeys = [];
    for (const p of providers) {
      if (!p.keys.length) continue;
      const clients = new Map<string, OpenAI>();
      for (const key of p.keys) {
        clients.set(
          key,
          new OpenAI({
            apiKey: key,
            baseURL: p.baseURL,
            timeout: ANALYZE_TOTAL_TIMEOUT_MS,
            maxRetries: 0,
          })
        );
        this.allKeys.push(key);
      }
      this.tiers.push({
        name: p.name,
        model: p.model,
        keys: [...p.keys],
        pool: new RoundRobin(p.keys),
        clients,
        reasoningEffortCapability: p.reasoningEffortCapability,
        omitReasoningEffort: false,
      });
    }
    if (this.tiers.length === 0) {
      throw new Error('VisionClient requires at least one API key');
    }
  }

  async analyzeData(
    data: Buffer,
    prompt: string,
    region?: ImageRegion,
    budget?: PipelineBudget
  ): Promise<string> {
    const b = budget ?? new PipelineBudget();
    const payload = await prepareVisionPayload(data, region, b);
    return this.chatWithImages([payload], prompt, b);
  }

  async analyzeCompare(
    payloadA: { mime: string; b64: string },
    payloadB: { mime: string; b64: string },
    prompt: string,
    budget?: PipelineBudget
  ): Promise<string> {
    const text = `Image A is the first image; Image B is the second.\n\n${prompt}`;
    const b = budget ?? new PipelineBudget();
    return this.chatWithImages([payloadA, payloadB], text, b);
  }

  private async chatWithImages(
    images: Array<{ mime: string; b64: string }>,
    prompt: string,
    budget: PipelineBudget
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: VISION_SYSTEM_GUARD },
      {
        role: 'user',
        content: [
          ...images.map(({ mime, b64 }) => ({
            type: 'image_url' as const,
            image_url: { url: `data:image/${mime};base64,${b64}` },
          })),
          { type: 'text' as const, text: prompt },
        ],
      },
    ];

    const base = maxTokens();
    const failures: string[] = [];

    // 层级：key-scoped 同池 RR → provider-scoped 整池 skip → 备用池
    for (let tierIdx = 0; tierIdx < this.tiers.length; tierIdx++) {
      const tier = this.tiers[tierIdx]!;
      const hasLaterTier = tierIdx < this.tiers.length - 1;
      const startKey = tier.pool.next();
      const keyOrder = tier.pool.orderFrom(startKey);
      let tierExhausted = false;

      keyLoop: for (const key of keyOrder) {
        const client = tier.clients.get(key);
        if (!client) continue;

        let omitReasoningEffort = tier.omitReasoningEffort;

        for (let attempt = 0; attempt < 2; attempt++) {
          const remaining = budget.remaining();
          if (remaining < 3_000) {
            throw new Error('视觉推理总超时（卡在 视觉推理）');
          }
          const attemptTimeout = hasLaterTier
            ? Math.min(remaining, primaryProbeTimeoutMs())
            : remaining;
          const tokens = attempt === 0 ? base : retryMaxTokens(base);

          let response;
          try {
            const result = await createChatCompletion(
              client,
              tier,
              messages,
              tokens,
              omitReasoningEffort,
              attemptTimeout
            );
            response = result.response;
            omitReasoningEffort = result.omitReasoningEffort;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const redacted = redactKeys(msg.slice(0, 200), this.allKeys);
            const scope = classifyFailure(e);

            if (scope === 'request') throw annotateVisionStage(e);

            if (isNetworkOrBlockError(e)) {
              failures.push(`[${tier.name}] network/block: ${redacted}`);
              if (hasLaterTier) {
                tierExhausted = true;
                break keyLoop;
              }
              continue keyLoop;
            }

            if (scope === 'provider') {
              failures.push(`[${tier.name}] provider: ${redacted}`);
              tierExhausted = true;
              break keyLoop;
            }

            if (scope === 'key') {
              failures.push(`[${tier.name}] ${redacted}`);
              continue keyLoop;
            }

            throw annotateVisionStage(e);
          }

          if (!response.choices?.length) {
            failures.push(`[${tier.name}] 模型返回空 choices`);
            tierExhausted = true;
            break keyLoop;
          }

          const msg: any = response.choices[0].message;
          const content = extractMessageContent(msg);
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

          failures.push(
            `[${tier.name}] empty content after retry (finish_reason=${finishReason})${reasoningHint}`
          );
          tierExhausted = true;
          break keyLoop;
        }
      }

      if (tierExhausted && hasLaterTier) continue;

      if (tierExhausted && !hasLaterTier) {
        const last = failures[failures.length - 1] ?? '模型未返回正文';
        if (last.includes('finish_reason=length')) {
          throw new Error(
            withVisionStage(
              `empty content after retry (finish_reason=length). increase VISION_MAX_TOKENS and retry${last.includes('reasoning') ? last.slice(last.indexOf('；')) : ''}`
            )
          );
        }
        if (last.includes('empty content after retry')) {
          throw new Error(withVisionStage(last.replace(/^\[[^\]]+\]\s*/, '')));
        }
        throw new Error(withVisionStage(last));
      }
    }

    if (failures.length > 0) {
      throw new Error(`全部 API key 调用失败（卡在 视觉推理）:\n- ${failures.join('\n- ')}`);
    }
    throw new Error('模型未返回正文（卡在 视觉推理）');
  }

  async analyze(imagePath: string, prompt: string, region?: ImageRegion): Promise<string> {
    const budget = new PipelineBudget();
    const data = await readImageFile(imagePath, budget);
    return this.analyzeData(data, prompt, region, budget);
  }
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

function requireTask(task: unknown): string | { ok: false; response: ReturnType<typeof validationError> } {
  if (task === undefined || task === null || task === '') {
    return { ok: false, response: validationError('task is required') };
  }
  if (typeof task !== 'string') {
    return {
      ok: false,
      response: validationError(`task must be a string, got ${typeof task}`),
    };
  }
  const trimmed = task.trim();
  if (!trimmed) {
    return { ok: false, response: validationError('task is required') };
  }
  return trimmed;
}

function parseImageArg(
  value: unknown,
  fieldName: string
):
  | { ok: true; value: ResolvedImageSource }
  | { ok: false; response: ReturnType<typeof validationError> } {
  if (value === undefined || value === null || value === '') {
    return {
      ok: false,
      response: validationError(`${fieldName} is required`),
    };
  }
  if (typeof value !== 'string') {
    return {
      ok: false,
      response: validationError(`${fieldName} must be a string, got ${typeof value}`),
    };
  }
  try {
    return { ok: true, value: resolveImageSource(value) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, response: validationError(message) };
  }
}

async function runVision(
  client: VisionClient,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const taskResult = requireTask(args.task);
  if (typeof taskResult !== 'string') {
    return taskResult.response;
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

  if (args.image !== undefined && typeof args.image !== 'string') {
    return validationError(`image must be a string, got ${typeof args.image}`);
  }

  let resolved: ResolvedImageSource;
  try {
    resolved = resolveImageSource(args.image as string | undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return validationError(message);
  }

  const prompt = enhancePrompt(taskResult);
  const budget = new PipelineBudget();
  const data = await loadResolvedBuffer(resolved, budget);
  const text = await client.analyzeData(data, prompt, region, budget);
  return { content: [{ type: 'text', text }] };
}

async function runCompare(
  client: VisionClient,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const taskResult = requireTask(args.task);
  if (typeof taskResult !== 'string') {
    return taskResult.response;
  }

  const image1 = parseImageArg(args.image1, 'image1');
  if (!image1.ok) {
    return image1.response;
  }
  const image2 = parseImageArg(args.image2, 'image2');
  if (!image2.ok) {
    return image2.response;
  }

  const prompt = enhanceComparePrompt(taskResult);
  const budget = new PipelineBudget();
  const dataA = await loadResolvedBuffer(image1.value, budget);
  const payloadA = await prepareVisionPayload(dataA, undefined, budget);
  const dataB = await loadResolvedBuffer(image2.value, budget);
  const payloadB = await prepareVisionPayload(dataB, undefined, budget);
  const text = await client.analyzeCompare(payloadA, payloadB, prompt, budget);
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

      if (name === 'vision') {
        return await runVision(visionClient, args);
      }
      if (name === 'compare') {
        return await runCompare(visionClient, args);
      }

      return validationError(`未知工具: ${name}`);
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
