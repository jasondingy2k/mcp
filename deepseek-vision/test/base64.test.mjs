// 零成本单元测试：base64 解码（无网络、不落盘）。
// 运行：npm run build && node --test test/base64.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeImageBase64,
  loadImageBufferFromBase64,
  ImageValidationError,
} from '../build/image.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const TINY_PNG_B64 = TINY_PNG.toString('base64');

test('decodeImageBase64: 合法 PNG base64 解码', () => {
  const buf = decodeImageBase64(TINY_PNG_B64);
  assert.ok(buf.equals(TINY_PNG));
});

test('decodeImageBase64: data URL 前缀可剥', () => {
  const dataUrl = `data:image/png;base64,${TINY_PNG_B64}`;
  const buf = decodeImageBase64(dataUrl);
  assert.ok(buf.equals(TINY_PNG));
});

test('decodeImageBase64: data URL subtype 大小写不敏感', () => {
  const dataUrl = `data:image/PNG;base64,${TINY_PNG_B64}`;
  const buf = decodeImageBase64(dataUrl);
  assert.ok(buf.equals(TINY_PNG));
});

test('decodeImageBase64: 空字符串抛错', () => {
  assert.throws(() => decodeImageBase64(''), ImageValidationError);
  assert.throws(() => decodeImageBase64('   '), ImageValidationError);
});

test('decodeImageBase64: 非法字符抛错', () => {
  assert.throws(() => decodeImageBase64('!!!not-base64!!!'), ImageValidationError);
});

test('decodeImageBase64: 仅 data URL 前缀无 payload 抛错', () => {
  assert.throws(
    () => decodeImageBase64('data:image/png;base64,'),
    ImageValidationError
  );
});

test('loadImageBufferFromBase64: 超 maxImageBytes 抛错', () => {
  const prev = process.env.VISION_MAX_IMAGE_BYTES;
  process.env.VISION_MAX_IMAGE_BYTES = String(TINY_PNG.length - 1);
  try {
    assert.throws(
      () => loadImageBufferFromBase64(TINY_PNG_B64),
      (e) =>
        e instanceof ImageValidationError && e.message.includes('图片过大')
    );
  } finally {
    if (prev === undefined) delete process.env.VISION_MAX_IMAGE_BYTES;
    else process.env.VISION_MAX_IMAGE_BYTES = prev;
  }
});
