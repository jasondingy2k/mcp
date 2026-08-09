// config.ts — 环境变量读取（.env 启动时只加载一次）
import { loadEnvFile } from './env.js';

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
/** 单次 analyze（含空 content 重试）总墙钟预算 */
export const ANALYZE_TOTAL_TIMEOUT_MS = 120_000;
/** 空 content 重试时 max_tokens 钳制基准；首次已 ≥ 此值则第二次只翻倍、不再向下钳 */
export const RETRY_MAX_TOKENS_CAP = 8192;

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

export function apiKey(): string | undefined {
  return process.env.OPENCODE_API_KEY || process.env.VISION_API_KEY || undefined;
}

export function baseUrl(): string {
  return (process.env.VISION_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function modelName(): string {
  return process.env.VISION_MODEL_NAME || process.env.VISION_MODEL || DEFAULT_MODEL;
}

export function parseMaxTokens(raw: string | undefined): number {
  if (!raw) return DEFAULT_MAX_TOKENS;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? Math.max(512, n) : DEFAULT_MAX_TOKENS;
}
export function maxTokens(): number {
  return parseMaxTokens(process.env.VISION_MAX_TOKENS);
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
