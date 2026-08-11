// HEIC/HEIF 支持单元测试（darwin 转码用 sips，无网络）。
// 运行：npm run build && node --test test/heic.test.mjs test/image.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  isHeicLike,
  validateMagic,
  ensureRasterImage,
  validateImagePath,
  ImageValidationError,
} from '../build/image.js';

const execFileAsync = promisify(execFile);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function minimalHeicBuffer(brand = 'heic') {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(12, 0);
  Buffer.from('ftyp').copy(buf, 4);
  Buffer.from(brand.padEnd(4, '\0').slice(0, 4)).copy(buf, 8);
  return buf;
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('isHeicLike: ftyp+heic 通过', () => {
  assert.equal(isHeicLike(minimalHeicBuffer('heic')), true);
  assert.equal(isHeicLike(minimalHeicBuffer('heif')), true);
  assert.equal(isHeicLike(minimalHeicBuffer('mif1')), true);
  assert.equal(isHeicLike(minimalHeicBuffer('msf1')), true);
});

test('isHeicLike: 垃圾字节失败', () => {
  assert.equal(isHeicLike(Buffer.from('not heic')), false);
  assert.equal(isHeicLike(minimalHeicBuffer('xxxx')), false);
});

test('validateMagic: 最小 ftyp+heic buffer 通过', () => {
  assert.doesNotThrow(() => validateMagic(minimalHeicBuffer()));
});

test('validateMagic: 垃圾 HEIC-like 失败', () => {
  assert.throws(() => validateMagic(Buffer.from('garbage')), ImageValidationError);
});

test('ensureRasterImage: 普通 PNG 原样返回', async () => {
  const out = await ensureRasterImage(TINY_PNG);
  assert.ok(out.equals(TINY_PNG));
});

test(
  'ensureRasterImage: darwin sips 将 HEIC 转为 PNG',
  { skip: process.platform !== 'darwin' ? '仅 macOS 有 sips HEIC 转码' : false },
  async () => {
    const samplePath = join(process.cwd(), 'tmp', 'heic-src.heic');
    let heic;
    try {
      heic = readFileSync(samplePath);
    } catch {
      const png = await sharp({
        create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 0, b: 0 } },
      })
        .png()
        .toBuffer();
      const pngPath = join(process.cwd(), 'test', `heic-src-${Date.now()}.png`);
      const heicPath = join(process.cwd(), 'test', `heic-src-${Date.now()}.heic`);
      writeFileSync(pngPath, png);
      try {
        await execFileAsync('sips', ['-s', 'format', 'heic', pngPath, '--out', heicPath]);
        heic = readFileSync(heicPath);
      } finally {
        for (const p of [pngPath, heicPath]) {
          try {
            unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
      }
    }

    assert.equal(isHeicLike(heic), true);
    const out = await ensureRasterImage(heic);
    assert.ok(out.subarray(0, 8).equals(PNG_MAGIC));
    const meta = await sharp(out).metadata();
    assert.ok((meta.width ?? 0) > 0);
    assert.ok((meta.height ?? 0) > 0);
  }
);

test('validateImagePath: .heic 扩展名允许', () => {
  const f = join(process.cwd(), 'test', `fixture-${Date.now()}.heic`);
  writeFileSync(f, minimalHeicBuffer());
  try {
    const p = validateImagePath(f);
    assert.ok(p.endsWith('.heic'));
  } finally {
    unlinkSync(f);
  }
});
