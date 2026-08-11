// image.ts — 图片路径 / 魔数 / 完整解码校验（移植自 mimo-vision server.py）
import { execFile, type ExecFileOptions } from 'child_process';
import { statSync } from 'fs';
import { open } from 'fs/promises';
import { extname, resolve } from 'path';
import { promisify } from 'util';
import sharp from 'sharp';
import {
  ALLOWED_EXTENSIONS,
  IMAGE_MAGIC_PREFIXES,
  WEBP_RIFF,
  WEBP_TAG,
  maxImageBytes,
  maxImagePixels,
  maxSendEdge,
  verifyImageTimeoutMs,
} from './config.js';
import type { PipelineBudget } from './pipeline-budget.js';
import { withSharpConcurrency } from './semaphore.js';
import {
  allocTempPath,
  removeTempFile,
  secureExistingTempFile,
  writePrivateTempFile,
} from './temp-manager.js';

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

export type ImageRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function regionError(message: string): never {
  throw new ImageValidationError(`${message}（卡在 区域裁切）`);
}

/** 结构校验 region 参数（仅像素坐标）；失败抛 ImageValidationError（卡在 区域裁切） */
export function parseRegion(raw: unknown): ImageRegion {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    regionError('region 必须是对象');
  }
  const o = raw as Record<string, unknown>;
  if ('unit' in o) {
    regionError('region 不支持 unit；仅接受像素坐标 x/y/width/height');
  }
  for (const f of ['x', 'y', 'width', 'height'] as const) {
    if (!(f in o)) {
      regionError(`region 缺少字段 "${f}"`);
    }
  }
  const { x, y, width, height } = o;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    regionError('region 的 x/y/width/height 必须是有限数字');
  }
  if (width <= 0 || height <= 0) {
    regionError('region 的 width/height 必须大于 0');
  }
  return { x, y, width, height };
}

const DATA_URL_BASE64_RE = /^data:image\/[a-zA-Z0-9.+-]+;base64,/i;
const BASE64_PAYLOAD_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const FTYP_BOX = Buffer.from('ftyp');
const HEIF_BRANDS = new Set(['heic', 'heif', 'mif1', 'msf1', 'heix', 'hevc', 'avci']);
const HEIC_TRANSCODE_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

/**
 * sharp 阶段：semaphore 内 race 超时；超时后 drain 仍在飞的 work 再抛错，保证槽位在请求结束前释放。
 */
async function withTimedSharpStage<T>(
  stage: string,
  budget: PipelineBudget | undefined,
  desiredTimeoutMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const timeoutMs = budget
    ? budget.stageTimeout(stage, desiredTimeoutMs, 500)
    : desiredTimeoutMs;

  return withSharpConcurrency(async () => {
    const work = fn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(
              new ImageValidationError(`图片处理超时（>${timeoutMs}ms）（卡在 ${stage}）`)
            );
          }, timeoutMs);
        }),
      ]);
    } catch (e) {
      if (timedOut) {
        try {
          await work;
        } catch {
          /* drain in-flight libvips before releasing semaphore slot */
        }
      }
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

/** ISO BMFF HEIF/HEIC：偏移 4 为 ftyp，偏移 8 起 major brand */
export function isHeicLike(data: Buffer): boolean {
  if (data.length < 12) return false;
  if (!data.subarray(4, 8).equals(FTYP_BOX)) return false;
  const brand = data.subarray(8, 12).toString('ascii').toLowerCase();
  return HEIF_BRANDS.has(brand);
}

/** 判断字符串是否为 data URL 或 raw base64 图片载荷 */
export function looksLikeImageBase64(input: string): boolean {
  const trimmed = input.trim();
  if (DATA_URL_BASE64_RE.test(trimmed)) return true;
  const payload = trimmed.replace(/\s/g, '');
  return payload.length >= 16 && BASE64_PAYLOAD_RE.test(payload);
}

/** 解码 raw base64 或 data URL；不落盘。MIME 由后续魔数校验决定。 */
export function decodeImageBase64(input: string): Buffer {
  let payload = input.trim();
  if (DATA_URL_BASE64_RE.test(payload)) {
    payload = payload.replace(DATA_URL_BASE64_RE, '');
  }
  payload = payload.replace(/\s/g, '');
  if (!payload) {
    throw new ImageValidationError('base64 为空，无有效图片（卡在 base64 解码）');
  }
  if (!BASE64_PAYLOAD_RE.test(payload)) {
    throw new ImageValidationError('base64 含非法字符（卡在 base64 解码）');
  }
  const data = Buffer.from(payload, 'base64');
  if (data.length === 0) {
    throw new ImageValidationError('base64 解码结果为空，无有效图片（卡在 base64 解码）');
  }
  return data;
}

/** decodeImageBase64 + 大小上限检查 */
export function loadImageBufferFromBase64(input: string): Buffer {
  const data = decodeImageBase64(input);
  const maxBytes = maxImageBytes();
  if (data.length > maxBytes) {
    throw new ImageValidationError(`图片过大: ${data.length} 字节 (最大 ${maxBytes})。`);
  }
  return data;
}

export function validateImagePath(pathStr: string): string {
  const p = resolve(pathStr);
  const ext = extname(p).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new ImageValidationError(
      `拒绝读取 '${ext}' —— 仅允许图片格式 (${[...ALLOWED_EXTENSIONS].sort().join(', ')}).`
    );
  }
  let st;
  try {
    st = statSync(p);
  } catch {
    throw new ImageValidationError(`不是一个文件: ${pathStr}`);
  }
  if (!st.isFile()) {
    throw new ImageValidationError(`不是一个文件: ${pathStr}`);
  }
  const size = st.size;
  const maxBytes = maxImageBytes();
  if (size > maxBytes) {
    throw new ImageValidationError(`图片过大: ${size} 字节 (最大 ${maxBytes})。`);
  }
  return p;
}

/** 单次 open+fstat+read，读后复核长度，关闭 TOCTOU */
export async function readImageFile(pathStr: string, budget?: PipelineBudget): Promise<Buffer> {
  budget?.assertRemaining('图片读取', 500);
  const p = validateImagePath(pathStr);
  const maxBytes = maxImageBytes();
  const fh = await open(p, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new ImageValidationError(`不是一个文件: ${pathStr}`);
    }
    if (st.size > maxBytes) {
      throw new ImageValidationError(`图片过大: ${st.size} 字节 (最大 ${maxBytes})。`);
    }
    if (st.size === 0) {
      throw new ImageValidationError('图片文件为空。');
    }
    const data = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(data, 0, st.size, 0);
    if (bytesRead !== st.size) {
      throw new ImageValidationError(
        `图片读取不完整: 期望 ${st.size} 字节，实际 ${bytesRead} 字节。`
      );
    }
    return data;
  } finally {
    await fh.close();
  }
}

async function readBoundedFile(path: string, maxBytes: number, stage: string): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size <= 0) {
      throw new ImageValidationError(`HEIC 转码产物无效（卡在 ${stage}）`);
    }
    if (st.size > maxBytes) {
      throw new ImageValidationError(
        `HEIC 转码产物过大: ${st.size} 字节 (最大 ${maxBytes})（卡在 ${stage}）`
      );
    }
    const data = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(data, 0, st.size, 0);
    if (bytesRead !== st.size) {
      throw new ImageValidationError(`HEIC 转码产物读取不完整（卡在 ${stage}）`);
    }
    return data;
  } finally {
    await fh.close();
  }
}

export function validateMagic(data: Buffer): void {
  const simpleOk = IMAGE_MAGIC_PREFIXES.some((m) =>
    data.length >= m.length && data.subarray(0, m.length).equals(m)
  );
  const webpOk =
    data.length >= 12 &&
    data.subarray(0, 4).equals(WEBP_RIFF) &&
    data.subarray(8, 12).equals(WEBP_TAG);
  const heifOk = isHeicLike(data);
  if (!simpleOk && !webpOk && !heifOk) {
    throw new ImageValidationError('文件内容不像是支持的图片格式。');
  }
}

/** 按已校验魔数推导 MIME 子类型（勿用扩展名，避免 .jpg 实为 PNG） */
export function mimeSubtypeFromMagic(data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(IMAGE_MAGIC_PREFIXES[0]!)) return 'png';
  if (data.length >= 3 && data.subarray(0, 3).equals(IMAGE_MAGIC_PREFIXES[1]!)) return 'jpeg';
  if (
    data.length >= 6 &&
    (data.subarray(0, 6).equals(Buffer.from('GIF87a')) ||
      data.subarray(0, 6).equals(Buffer.from('GIF89a')))
  ) {
    return 'gif';
  }
  if (data.length >= 2 && data.subarray(0, 2).equals(Buffer.from('BM'))) return 'bmp';
  if (
    data.length >= 12 &&
    data.subarray(0, 4).equals(WEBP_RIFF) &&
    data.subarray(8, 12).equals(WEBP_TAG)
  ) {
    return 'webp';
  }
  if (isHeicLike(data)) return 'heic';
  return 'png';
}

async function transcodeHeicWithSips(
  data: Buffer,
  execFileFn: ExecFileLike = execFileAsync,
  budget?: PipelineBudget
): Promise<Buffer> {
  budget?.assertRemaining('HEIC 转码', 1_000);
  const timeoutMs = budget
    ? budget.stageTimeout('HEIC 转码', HEIC_TRANSCODE_TIMEOUT_MS, 500)
    : HEIC_TRANSCODE_TIMEOUT_MS;
  const maxBytes = maxImageBytes();
  const inPath = allocTempPath('heic-in', '.heic');
  const outPath = allocTempPath('heic-out', '.png');
  try {
    await writePrivateTempFile(inPath, data);
    await execFileFn(
      'sips',
      ['-s', 'format', 'png', inPath, '--out', outPath],
      { timeout: timeoutMs }
    );
    secureExistingTempFile(outPath);
    return await readBoundedFile(outPath, maxBytes, 'HEIC 转码');
  } catch (e) {
    if (e instanceof ImageValidationError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new ImageValidationError(`HEIC→PNG failed: ${msg.slice(0, 120)}（卡在 HEIC 转码）`);
  } finally {
    await Promise.allSettled([removeTempFile(inPath), removeTempFile(outPath)]);
  }
}

async function transcodeHeicWithSharp(data: Buffer, budget?: PipelineBudget): Promise<Buffer> {
  budget?.assertRemaining('HEIC 转码', 500);
  const maxBytes = maxImageBytes();
  try {
    const out = await withTimedSharpStage('HEIC 转码', budget, HEIC_TRANSCODE_TIMEOUT_MS, () =>
      sharp(data).png().toBuffer()
    );
    if (out.length > maxBytes) {
      throw new ImageValidationError(
        `HEIC 转码产物过大: ${out.length} 字节 (最大 ${maxBytes})（卡在 HEIC 转码）`
      );
    }
    return out;
  } catch (e) {
    if (e instanceof ImageValidationError) throw e;
    throw new ImageValidationError(
      'HEIC decode unsupported (no HEVC); use PNG/JPEG or darwin（卡在 HEIC 转码）'
    );
  }
}

/** HEIC/HEIF 先转栅格图（PNG buffer）；其它格式原样返回。须在 validateMagic/verifyImage 之前调用。 */
export async function ensureRasterImage(
  data: Buffer,
  execFileFn?: ExecFileLike,
  budget?: PipelineBudget
): Promise<Buffer> {
  if (!isHeicLike(data)) return data;
  if (process.platform === 'darwin') {
    return transcodeHeicWithSips(data, execFileFn, budget);
  }
  return transcodeHeicWithSharp(data, budget);
}

// 完整解码校验：仅 metadata() 会漏检「头部完整、主体截断」的文件
// 超时在 semaphore 内 race；超时后 drain 底层解码再释放槽位（libvips 无原生 abort）。
export async function verifyImage(data: Buffer, budget?: PipelineBudget): Promise<void> {
  budget?.assertRemaining('图片解码', 500);
  const maxPixels = maxImagePixels();

  await withTimedSharpStage('图片解码', budget, verifyImageTimeoutMs(), async () => {
    try {
      const meta = await sharp(data, { limitInputPixels: maxPixels }).metadata();
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      if (w > 0 && h > 0 && w * h > maxPixels) {
        throw new ImageValidationError(
          `图片像素过多: ${w}×${h}=${w * h}（上限 ${maxPixels}）。`
        );
      }
    } catch (e) {
      if (e instanceof ImageValidationError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/limitInputPixels|Input image exceeds pixel limit/i.test(msg)) {
        throw new ImageValidationError(`图片像素过多（上限 ${maxPixels}）。`);
      }
    }
    try {
      await sharp(data, { limitInputPixels: maxPixels }).raw().toBuffer();
    } catch (e) {
      if (e instanceof ImageValidationError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/limitInputPixels|Input image exceeds pixel limit/i.test(msg)) {
        throw new ImageValidationError(`图片像素过多（上限 ${maxPixels}）。`);
      }
      throw new ImageValidationError(`图片文件损坏或截断，无法解析（${msg.slice(0, 120)}）。`);
    }
  });
}

/** 按 region 裁切当前栅格图（HEIC 转码后、缩图前）；输出 PNG。部分越界 clamp 到图内。 */
export async function applyRegion(
  data: Buffer,
  region: ImageRegion,
  budget?: PipelineBudget
): Promise<Buffer> {
  budget?.assertRemaining('区域裁切', 500);
  const maxPixels = maxImagePixels();

  return withTimedSharpStage('区域裁切', budget, verifyImageTimeoutMs(), async () => {
    let imgW: number;
    let imgH: number;
    try {
      const meta = await sharp(data, { limitInputPixels: maxPixels }).metadata();
      imgW = meta.width ?? 0;
      imgH = meta.height ?? 0;
      if (imgW <= 0 || imgH <= 0) {
        regionError('无法读取图片宽高');
      }
    } catch (e) {
      if (e instanceof ImageValidationError) throw e;
      regionError('读取图片元数据失败');
    }

    const left = Math.floor(region.x);
    const top = Math.floor(region.y);
    const w = Math.round(region.width);
    const h = Math.round(region.height);

    if (w < 1 || h < 1) {
      regionError('region 换算后宽高小于 1 像素');
    }

    const right = Math.min(left + w, imgW);
    const bottom = Math.min(top + h, imgH);
    const clampedLeft = Math.max(0, left);
    const clampedTop = Math.max(0, top);
    const clampedW = right - clampedLeft;
    const clampedH = bottom - clampedTop;

    if (clampedW < 1 || clampedH < 1) {
      regionError('region 与图片无交集');
    }

    try {
      return await sharp(data, { limitInputPixels: maxPixels })
        .extract({ left: clampedLeft, top: clampedTop, width: clampedW, height: clampedH })
        .png()
        .toBuffer();
    } catch (e) {
      if (e instanceof ImageValidationError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      regionError(`区域裁切失败: ${msg.slice(0, 120)}`);
    }
  });
}

/** 送模前按最长边缩小；小图不放大、不无谓重编码；edge=0 时原样返回 */
export async function prepareImageForModel(
  data: Buffer,
  budget?: PipelineBudget
): Promise<{ buffer: Buffer; mime: string }> {
  budget?.assertRemaining('图片缩放', 500);
  const edge = maxSendEdge();
  if (edge === 0) {
    return { buffer: data, mime: mimeSubtypeFromMagic(data) };
  }

  return withTimedSharpStage('图片缩放', budget, verifyImageTimeoutMs(), async () => {
    const maxPixels = maxImagePixels();
    let w: number;
    let h: number;
    try {
      const meta = await sharp(data, { limitInputPixels: maxPixels }).metadata();
      w = meta.width ?? 0;
      h = meta.height ?? 0;
      if (w <= 0 || h <= 0) {
        throw new ImageValidationError('无法读取图片宽高（卡在 图片缩放）');
      }
    } catch (e) {
      if (e instanceof ImageValidationError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/limitInputPixels|Input image exceeds pixel limit/i.test(msg)) {
        throw new ImageValidationError(`图片像素过多（上限 ${maxPixels}）（卡在 图片缩放）`);
      }
      throw new ImageValidationError(`图片缩放失败（卡在 图片缩放）: ${msg.slice(0, 120)}`);
    }

    if (Math.max(w, h) <= edge) {
      return { buffer: data, mime: mimeSubtypeFromMagic(data) };
    }

    try {
      const buffer = await sharp(data, { limitInputPixels: maxPixels })
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      return { buffer, mime: 'png' };
    } catch (e) {
      if (e instanceof ImageValidationError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/limitInputPixels|Input image exceeds pixel limit/i.test(msg)) {
        throw new ImageValidationError(`图片像素过多（上限 ${maxPixels}）（卡在 图片缩放）`);
      }
      throw new ImageValidationError(`图片缩放失败（卡在 图片缩放）: ${msg.slice(0, 120)}`);
    }
  });
}
