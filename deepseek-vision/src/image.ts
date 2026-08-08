// image.ts — 图片路径 / 魔数 / 完整解码校验（移植自 mimo-vision server.py）
import { statSync } from 'fs';
import { extname, resolve } from 'path';
import sharp from 'sharp';
import {
  ALLOWED_EXTENSIONS,
  IMAGE_MAGIC_PREFIXES,
  WEBP_RIFF,
  WEBP_TAG,
  maxImageBytes,
  maxImagePixels,
  verifyImageTimeoutMs,
} from './config.js';

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageValidationError';
  }
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
  if (!simpleOk && !webpOk) {
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
  return 'png';
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
