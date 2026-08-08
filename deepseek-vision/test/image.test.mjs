// 零成本单元测试：图片路径/魔数/完整解码校验（sharp 本地处理，无网络）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  validateMagic,
  verifyImage,
  validateImagePath,
  mimeSubtypeFromMagic,
  ImageValidationError,
} from '../build/image.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('validateMagic: 合法 PNG 通过', () => {
  assert.doesNotThrow(() => validateMagic(TINY_PNG));
});

test('mimeSubtypeFromMagic: PNG/JPEG 魔数优先于扩展名语义', () => {
  assert.equal(mimeSubtypeFromMagic(TINY_PNG), 'png');
  const jpegHdr = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  assert.equal(mimeSubtypeFromMagic(jpegHdr), 'jpeg');
});

test('validateMagic: 垃圾字节抛错', () => {
  assert.throws(() => validateMagic(Buffer.from('not an image')), ImageValidationError);
});

test('validateMagic: 裸 RIFF(非 WEBP) 拒绝；RIFF+WEBP 通过', () => {
  const wavLike = Buffer.alloc(12, 0);
  Buffer.from('RIFF').copy(wavLike, 0);
  Buffer.from('WAVE').copy(wavLike, 8);
  assert.throws(() => validateMagic(wavLike), ImageValidationError);

  const webp = Buffer.alloc(12, 0);
  Buffer.from('RIFF').copy(webp, 0);
  Buffer.from('WEBP').copy(webp, 8);
  assert.doesNotThrow(() => validateMagic(webp));
});

test('verifyImage: 合法图片通过', async () => {
  await assert.doesNotReject(verifyImage(TINY_PNG));
});

test('verifyImage: 截断 PNG 抛错（含深截断：头部完整、主体缺失）', async () => {
  await assert.rejects(
    verifyImage(TINY_PNG.subarray(0, Math.floor(TINY_PNG.length / 2))),
    ImageValidationError
  );
  const full = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer();
  await assert.rejects(
    verifyImage(full.subarray(0, Math.floor(full.length * 0.15))),
    ImageValidationError
  );
});

test('validateImagePath: 不存在的文件抛错', () => {
  assert.throws(() => validateImagePath('/no/such/file.png'), ImageValidationError);
});

test('validateImagePath: 非法扩展名抛错', () => {
  const f = join(process.cwd(), 'test', 'notimg.txt');
  writeFileSync(f, 'hello');
  try {
    assert.throws(() => validateImagePath(f), ImageValidationError);
  } finally {
    unlinkSync(f);
  }
});

test('validateImagePath: 合法图片路径通过', () => {
  const f = join(process.cwd(), 'test', 'fixture.png');
  writeFileSync(f, TINY_PNG);
  try {
    const p = validateImagePath(f);
    assert.equal(p.endsWith('fixture.png'), true);
  } finally {
    unlinkSync(f);
  }
});
