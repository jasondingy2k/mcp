// config.ts — 环境变量读取（.env 启动时只加载一次）
import { loadEnvFile } from './env.js';
import { parseApiKeys } from './keypool.js';

export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const DEFAULT_MODEL = 'mimo-v2.5';
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** sharp 解码像素上限（宽×高）；超限拒绝，防巨型图拖死进程 */
export const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000;
/** sharp 全量解码超时（ms） */
export const DEFAULT_VERIFY_IMAGE_TIMEOUT_MS = 15_000;
/** 送模前最长边缩放上限（像素）；0 表示禁用 */
export const DEFAULT_MAX_SEND_EDGE = 2048;
/** 送模输出编码：auto=按源格式/alpha 自适应；webp 仅显式启用 */
export type VisionOutputFormat = 'auto' | 'png' | 'jpeg' | 'webp';
export const DEFAULT_OUTPUT_FORMAT: VisionOutputFormat = 'auto';
/** JPEG/WebP 有损质量（1–100）；默认 90（WS-6 基准） */
export const DEFAULT_OUTPUT_QUALITY = 90;
/** 单次 analyze（含空 content 重试 + 多池 failover）总墙钟预算 */
export const ANALYZE_TOTAL_TIMEOUT_MS = 120_000;
/**
 * 非最后一层提供商的单次探测超时（ms）。
 * 阻断/挂起时尽快放弃主池，把预算留给 fallback（如 Groq）。
 */
export const DEFAULT_PRIMARY_PROBE_TIMEOUT_MS = 20_000;
/** 空 content 重试时 max_tokens 钳制基准；首次已 ≥ 此值则第二次只翻倍、不再向下钳 */
export const RETRY_MAX_TOKENS_CAP = 8192;
/** sharp/libvips 并发解码/缩放上限（排队） */
export const DEFAULT_SHARP_CONCURRENCY = 2;

export const ALLOWED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.heic',
  '.heif',
]);
/** 简单魔数前缀；WebP 需 RIFF + 偏移 8 的 WEBP，见 validateMagic */
export const IMAGE_MAGIC_PREFIXES: Buffer[] = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG
  Buffer.from([0xff, 0xd8, 0xff]),                                // JPEG
  Buffer.from('GIF87a'),
  Buffer.from('GIF89a'),
  Buffer.from('BM'),     // BMP
];
export const WEBP_RIFF = Buffer.from('RIFF');
export const WEBP_TAG = Buffer.from('WEBP');

/** 原始 key 环境变量（OPENCODE_API_KEY 优先，否则 VISION_API_KEY）。支持逗号分隔多 key。 */
export function apiKeyRaw(): string | undefined {
  return process.env.OPENCODE_API_KEY || process.env.VISION_API_KEY || undefined;
}

/** 解析后的主池 key 列表；空 → []。 */
export function apiKeys(): string[] {
  return parseApiKeys(apiKeyRaw());
}

/** 兼容：返回第一个 key（无则 undefined）。新逻辑请用 apiKeys() / loadVisionProviders()。 */
export function apiKey(): string | undefined {
  return apiKeys()[0];
}

export function baseUrl(): string {
  return (process.env.VISION_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function modelName(): string {
  return process.env.VISION_MODEL_NAME || process.env.VISION_MODEL || DEFAULT_MODEL;
}

/** 备用池（主池 key 耗尽或 provider 级失败后使用）。例：Google 主池 + Groq 备用。 */
export function fallbackApiKeys(): string[] {
  return parseApiKeys(process.env.VISION_FALLBACK_API_KEY);
}

export function fallbackBaseUrl(): string {
  return (process.env.VISION_FALLBACK_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
}

export function fallbackModelName(): string {
  return (
    process.env.VISION_FALLBACK_MODEL_NAME ||
    process.env.VISION_FALLBACK_MODEL ||
    'qwen/qwen3.6-27b'
  );
}

/**
 * reasoning_effort 发送策略：
 * - auto：先按配置发送；端点 400 报 unknown field 时同 key 窄降级一次并缓存；
 * - supported：非 none 时始终发送；
 * - unsupported：始终省略。
 */
export type ReasoningEffortCapability = 'auto' | 'supported' | 'unsupported';

/** 单提供商池：同池内等权 RR；多池按数组顺序优先（主 → 备）。 */
export interface VisionProvider {
  name: string;
  baseURL: string;
  model: string;
  keys: string[];
  reasoningEffortCapability: ReasoningEffortCapability;
}

export function parseReasoningEffortCapability(
  raw: string | undefined,
  fallback: ReasoningEffortCapability = 'auto'
): ReasoningEffortCapability {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (v === 'auto' || v === 'supported' || v === 'unsupported') return v;
  return fallback;
}

export function primaryReasoningEffortCapability(): ReasoningEffortCapability {
  return parseReasoningEffortCapability(process.env.VISION_REASONING_EFFORT_CAPABILITY);
}

export function fallbackReasoningEffortCapability(): ReasoningEffortCapability {
  return parseReasoningEffortCapability(process.env.VISION_FALLBACK_REASONING_EFFORT_CAPABILITY);
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 启动时校验配置；返回不含 secret 的错误文案列表。
 * 全空 key → []（keyless 模式，非错误）。
 */
export function validateVisionConfig(): string[] {
  const errors: string[] = [];
  const primaryKeys = apiKeys();
  const fbKeys = fallbackApiKeys();

  const primaryUrl = baseUrl();
  if (primaryKeys.length > 0) {
    if (!isValidHttpUrl(primaryUrl)) {
      errors.push(`VISION_BASE_URL 无效: ${primaryUrl}`);
    }
    const model = modelName().trim();
    if (!model) errors.push('VISION_MODEL_NAME 不能为空');
    const cap = process.env.VISION_REASONING_EFFORT_CAPABILITY;
    if (cap && !['auto', 'supported', 'unsupported'].includes(cap.trim().toLowerCase())) {
      errors.push(`VISION_REASONING_EFFORT_CAPABILITY 无效: ${cap.trim()}`);
    }
  }

  if (fbKeys.length > 0) {
    const fbUrl = fallbackBaseUrl();
    if (!isValidHttpUrl(fbUrl)) {
      errors.push(`VISION_FALLBACK_BASE_URL 无效: ${fbUrl}`);
    }
    const fbModel = fallbackModelName().trim();
    if (!fbModel) errors.push('VISION_FALLBACK_MODEL_NAME 不能为空');
    const cap = process.env.VISION_FALLBACK_REASONING_EFFORT_CAPABILITY;
    if (cap && !['auto', 'supported', 'unsupported'].includes(cap.trim().toLowerCase())) {
      errors.push(`VISION_FALLBACK_REASONING_EFFORT_CAPABILITY 无效: ${cap.trim()}`);
    }
  }

  const effort = (process.env.VISION_REASONING_EFFORT ?? DEFAULT_REASONING_EFFORT).trim().toLowerCase();
  if (effort && effort !== 'none' && effort !== 'default' && effort !== 'low' && effort !== 'medium' && effort !== 'high') {
    errors.push(`VISION_REASONING_EFFORT 无效: ${effort}`);
  }

  const outFmt = process.env.VISION_OUTPUT_FORMAT;
  if (outFmt && !['auto', 'png', 'jpeg', 'webp'].includes(outFmt.trim().toLowerCase())) {
    errors.push(`VISION_OUTPUT_FORMAT 无效: ${outFmt.trim()}`);
  }
  const outQ = process.env.VISION_OUTPUT_QUALITY;
  if (outQ !== undefined && outQ !== '') {
    const n = Number.parseInt(outQ.trim(), 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      errors.push(`VISION_OUTPUT_QUALITY 无效: ${outQ.trim()}`);
    }
  }

  return errors;
}

/**
 * 组装提供商层级：primary（OPENCODE/VISION_*）→ fallback（VISION_FALLBACK_*）。
 * 缺 key 的层级跳过；全空 → []（入口建 null client）。
 */
export function loadVisionProviders(): VisionProvider[] {
  const out: VisionProvider[] = [];
  const primaryKeys = apiKeys();
  if (primaryKeys.length > 0) {
    out.push({
      name: 'primary',
      baseURL: baseUrl(),
      model: modelName(),
      keys: primaryKeys,
      reasoningEffortCapability: primaryReasoningEffortCapability(),
    });
  }
  const fbKeys = fallbackApiKeys();
  if (fbKeys.length > 0) {
    out.push({
      name: 'fallback',
      baseURL: fallbackBaseUrl(),
      model: fallbackModelName(),
      keys: fbKeys,
      reasoningEffortCapability: fallbackReasoningEffortCapability(),
    });
  }
  return out;
}

/** Groq/Qwen 等：none=关 thinking；default=开。缺省 none（省额度、视觉任务通常不需要）。 */
export const DEFAULT_REASONING_EFFORT = 'none';

export function reasoningEffort(): string {
  const raw = (process.env.VISION_REASONING_EFFORT || DEFAULT_REASONING_EFFORT).trim().toLowerCase();
  if (!raw) return DEFAULT_REASONING_EFFORT;
  return raw;
}

export function parseMaxTokens(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_TOKENS;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? Math.max(512, n) : DEFAULT_MAX_TOKENS;
}
export function maxTokens(): number {
  return parseMaxTokens(process.env.VISION_MAX_TOKENS);
}

/** 非最后一层的单次探测超时；可用 VISION_PRIMARY_PROBE_TIMEOUT_MS 覆盖。 */
export function primaryProbeTimeoutMs(): number {
  const raw = process.env.VISION_PRIMARY_PROBE_TIMEOUT_MS;
  if (!raw) return DEFAULT_PRIMARY_PROBE_TIMEOUT_MS;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 3_000 ? n : DEFAULT_PRIMARY_PROBE_TIMEOUT_MS;
}

export function parseMaxImageBytes(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_IMAGE_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_IMAGE_BYTES;
}
export function maxImageBytes(): number {
  return parseMaxImageBytes(process.env.VISION_MAX_IMAGE_BYTES);
}

export function parseMaxImagePixels(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_IMAGE_PIXELS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_IMAGE_PIXELS;
}
export function maxImagePixels(): number {
  return parseMaxImagePixels(process.env.VISION_MAX_IMAGE_PIXELS);
}

export function parseVerifyImageTimeoutMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_VERIFY_IMAGE_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_VERIFY_IMAGE_TIMEOUT_MS;
}
export function verifyImageTimeoutMs(): number {
  return parseVerifyImageTimeoutMs(process.env.VISION_VERIFY_TIMEOUT_MS);
}

export function parseMaxSendEdge(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_SEND_EDGE;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_SEND_EDGE;
  if (n === 0) return 0;
  if (n < 0) return DEFAULT_MAX_SEND_EDGE;
  return Math.max(256, n);
}
export function maxSendEdge(): number {
  return parseMaxSendEdge(process.env.VISION_MAX_SEND_EDGE);
}

export function parseOutputFormat(raw: string | undefined): VisionOutputFormat {
  if (!raw) return DEFAULT_OUTPUT_FORMAT;
  const v = raw.trim().toLowerCase();
  if (v === 'auto' || v === 'png' || v === 'jpeg' || v === 'webp') return v;
  return DEFAULT_OUTPUT_FORMAT;
}
export function outputFormat(): VisionOutputFormat {
  return parseOutputFormat(process.env.VISION_OUTPUT_FORMAT);
}

export function parseOutputQuality(raw: string | undefined): number {
  if (!raw) return DEFAULT_OUTPUT_QUALITY;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > 100) return DEFAULT_OUTPUT_QUALITY;
  return n;
}
export function outputQuality(): number {
  return parseOutputQuality(process.env.VISION_OUTPUT_QUALITY);
}

export function parseSharpConcurrency(raw: string | undefined): number {
  if (!raw) return DEFAULT_SHARP_CONCURRENCY;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SHARP_CONCURRENCY;
  return Math.min(n, 8);
}
export function sharpConcurrency(): number {
  return parseSharpConcurrency(process.env.VISION_SHARP_CONCURRENCY);
}

/** 空 content 重试用的 max_tokens：翻倍；仅当 base < CAP 时钳到 CAP，避免 VISION_MAX_TOKENS>CAP 时第二次反而变小 */
export function retryMaxTokens(base: number, cap: number = RETRY_MAX_TOKENS_CAP): number {
  const doubled = base * 2;
  if (base >= cap) return doubled;
  return Math.min(doubled, cap);
}

export function logLevel(): string | undefined {
  return process.env.DEEPSEEK_VISION_LOG_LEVEL;
}

// 模块加载即加载 .env（一次）：所有依赖本模块的文件在读取环境变量前，
// 都已先执行 loadEnvFile()，保证「只在启动时加载一次」的顺序约定。
loadEnvFile();
