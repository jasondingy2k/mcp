// image.ts — 图片路径 / 魔数 / 完整解码校验（移植自 mimo-vision server.py）
import { execFile, type ExecFileOptions } from 'child_process';
import { randomBytes } from 'crypto';
import { statSync } from 'fs';
import { readFile, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { extname, join, resolve } from 'path';
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
  unit: 'px' | 'ratio';
};

const RATIO_EPS = 1e-6;

function regionError(message: string): never {
  throw new ImageValidationError(`${message}（卡在 区域裁切）`);
}

/** 结构校验 region 参数；失败抛 ImageValidationError（卡在 区域裁切） */
export function parseRegion(raw: unknown): ImageRegion {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    regionError('region 必须是对象');
  }
  const o = raw as Record<string, unknown>;
  for (const f of ['x', 'y', 'width', 'height', 'unit'] as const) {
    if (!(f in o)) {
      regionError(`region 缺少字段 "${f}"`);
    }
  }
  const { x, y, width, height, unit } = o;
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
  if (unit !== 'px' && unit !== 'ratio') {
    regionError(`region.unit 必须是 "px" 或 "ratio"，收到: ${JSON.stringify(unit)}`);
  }
  if (width <= 0 || height <= 0) {
    regionError('region 的 width/height 必须大于 0');
  }
  if (unit === 'ratio') {
    if (x < 0 || y < 0) {
      regionError('region ratio 的 x/y 不能为负');
    }
    if (x + width > 1 + RATIO_EPS) {
      regionError('region ratio 的 x+width 不能超过 1');
    }
    if (y + height > 1 + RATIO_EPS) {
      regionError('region ratio 的 y+height 不能超过 1');
    }
  }
  return { x, y, width, height, unit };
}

const DATA_URL_BASE64_RE = /^data:image\/[a-zA-Z0-9.+-]+;base64,/i;
const BASE64_PAYLOAD_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const FTYP_BOX = Buffer.from('ftyp');
const HEIF_BRANDS = new Set(['heic', 'heif', 'mif1', 'msf1', 'heix', 'hevc', 'avci']);
const HEIC_TRANSCODE_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

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
  let st;
  try {
    st = statSync(p);
  } catch {
    throw new ImageValidationError(`不是一个文件: ${pathStr}`);
  }
  if (!st.isFile()) {
    throw new ImageValidationError(`不是一个文件: ${pathStr}`);
  }
  const ext = extname(p).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new ImageValidationError(
      `拒绝读取 '${ext}' —— 仅允许图片格式 (${[...ALLOWED_EXTENSIONS].sort().join(', ')}).`
    );
  }
  const size = st.size;
  const maxBytes = maxImageBytes();
  if (size > maxBytes) {
    throw new ImageValidationError(`图片过大: ${size} 字节 (最大 ${maxBytes})。`);
  }
  return p;
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
  execFileFn: ExecFileLike = execFileAsync
): Promise<Buffer> {
  const id = randomBytes(8).toString('hex');
  const inPath = join(tmpdir(), `deepseek-vision-heic-${id}.heic`);
  const outPath = join(tmpdir(), `deepseek-vision-heic-${id}.png`);
  try {
    await writeFile(inPath, data);
    await execFileFn(
      'sips',
      ['-s', 'format', 'png', inPath, '--out', outPath],
      { timeout: HEIC_TRANSCODE_TIMEOUT_MS }
    );
    return await readFile(outPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ImageValidationError(`HEIC→PNG failed: ${msg.slice(0, 120)}（卡在 HEIC 转码）`);
  } finally {
    await Promise.allSettled([unlink(inPath), unlink(outPath)]);
  }
}

async function transcodeHeicWithSharp(data: Buffer): Promise<Buffer> {
  try {
    return await sharp(data).png().toBuffer();
  } catch {
    throw new ImageValidationError(
      'HEIC decode unsupported (no HEVC); use PNG/JPEG or darwin（卡在 HEIC 转码）'
    );
  }
}

/** HEIC/HEIF 先转栅格图（PNG buffer）；其它格式原样返回。须在 validateMagic/verifyImage 之前调用。 */
export async function ensureRasterImage(
  data: Buffer,
  execFileFn?: ExecFileLike
): Promise<Buffer> {
  if (!isHeicLike(data)) return data;
  if (process.platform === 'darwin') {
    return transcodeHeicWithSips(data, execFileFn);
  }
  return transcodeHeicWithSharp(data);
}

// 完整解码校验：仅 metadata() 会漏检「头部完整、主体截断」的文件
// （spike 已实测），因此对齐 Pillow Image.verify() 语义做完整解码。
// 像素上限 + 解码超时，避免巨型/恶意图拖死进程。
// 注意：sharp/libvips 无原生 abort；超时后 Promise.race 返回，底层解码可能短暂继续，
// 但 limitInputPixels 已封顶工作量（有界消耗）。峰值：40M 像素 raw ≈160MB + 原图 + base64。
export async function verifyImage(data: Buffer): Promise<void> {
  const maxPixels = maxImagePixels();
  const timeoutMs = verifyImageTimeoutMs();

  // metadata + raw 共用同一超时预算
  const work = (async () => {
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
      // metadata 失败仍尝试 raw 解码（部分截断图 metadata 也会挂）
    }
    await sharp(data, { limitInputPixels: maxPixels }).raw().toBuffer();
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ImageValidationError(
            `图片解码超时（>${timeoutMs}ms）（卡在 图片解码）`
          )
        ),
      timeoutMs
    );
  });
  try {
    await Promise.race([work, timed]);
  } catch (e) {
    if (e instanceof ImageValidationError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/limitInputPixels|Input image exceeds pixel limit/i.test(msg)) {
      throw new ImageValidationError(`图片像素过多（上限 ${maxPixels}）。`);
    }
    throw new ImageValidationError(`图片文件损坏或截断，无法解析（${msg.slice(0, 120)}）。`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 按 region 裁切当前栅格图（HEIC 转码后、缩图前）；输出 PNG。部分越界 clamp 到图内。 */
export async function applyRegion(data: Buffer, region: ImageRegion): Promise<Buffer> {
  const maxPixels = maxImagePixels();
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

  let left: number;
  let top: number;
  let w: number;
  let h: number;
  if (region.unit === 'ratio') {
    left = Math.floor(region.x * imgW);
    top = Math.floor(region.y * imgH);
    w = Math.round(region.width * imgW);
    h = Math.round(region.height * imgH);
  } else {
    left = Math.floor(region.x);
    top = Math.floor(region.y);
    w = Math.round(region.width);
    h = Math.round(region.height);
  }

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
}

/** 送模前按最长边缩小；小图不放大、不无谓重编码；edge=0 时原样返回 */
export async function prepareImageForModel(
  data: Buffer
): Promise<{ buffer: Buffer; mime: string }> {
  const edge = maxSendEdge();
  if (edge === 0) {
    return { buffer: data, mime: mimeSubtypeFromMagic(data) };
  }

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
}
