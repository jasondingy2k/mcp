// 自适应编码：JPEG/WebP/HEIC 源 → JPEG q90；PNG/alpha → PNG；显式覆盖
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {
  applyRegion,
  prepareImageForModel,
  detectSourceFormat,
  resolveOutputFormat,
  mimeSubtypeFromMagic,
} from '../build/image.js';

async function solidJpeg(w, h) {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 40, g: 80, b: 120 } },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function solidPng(w, h, alpha = false) {
  return sharp({
    create: {
      width: w,
      height: h,
      channels: alpha ? 4 : 3,
      background: alpha
        ? { r: 10, g: 20, b: 30, alpha: 0.5 }
        : { r: 10, g: 20, b: 30 },
    },
  })
    .png()
    .toBuffer();
}

async function solidWebp(w, h) {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 90, g: 50, b: 20 } },
  })
    .webp({ quality: 90 })
    .toBuffer();
}

function withEnv(vars, fn) {
  const keys = Object.keys(vars);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  return (async () => {
    try {
      for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      return await fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  })();
}

test('detectSourceFormat: jpeg/png/webp/heic', async () => {
  const jpeg = await solidJpeg(8, 8);
  const png = await solidPng(8, 8);
  const webp = await solidWebp(8, 8);
  assert.equal(detectSourceFormat(jpeg), 'jpeg');
  assert.equal(detectSourceFormat(png), 'png');
  assert.equal(detectSourceFormat(webp), 'webp');
  // minimal HEIC-like ftyp header (not decodable, format detect only)
  const heic = Buffer.alloc(12);
  heic.writeUInt32BE(0, 0);
  Buffer.from('ftyp').copy(heic, 4);
  Buffer.from('heic').copy(heic, 8);
  assert.equal(detectSourceFormat(heic), 'heic');
});

test('resolveOutputFormat: auto 分支', () => {
  assert.equal(resolveOutputFormat('jpeg', false, 'auto'), 'jpeg');
  assert.equal(resolveOutputFormat('webp', false, 'auto'), 'jpeg');
  assert.equal(resolveOutputFormat('heic', false, 'auto'), 'jpeg');
  assert.equal(resolveOutputFormat('png', false, 'auto'), 'png');
  assert.equal(resolveOutputFormat('jpeg', true, 'auto'), 'png');
  assert.equal(resolveOutputFormat('png', false, 'jpeg'), 'jpeg');
  assert.equal(resolveOutputFormat('jpeg', false, 'webp'), 'webp');
  assert.equal(resolveOutputFormat('jpeg', false, 'png'), 'png');
});

test('prepareImageForModel: 大 JPEG 照片 → jpeg（非 png）', async () => {
  await withEnv({ VISION_OUTPUT_FORMAT: undefined, VISION_OUTPUT_QUALITY: undefined }, async () => {
    const large = await solidJpeg(3000, 2000);
    const { buffer, mime } = await prepareImageForModel(large, undefined, 'jpeg');
    assert.equal(mime, 'jpeg');
    assert.equal(mimeSubtypeFromMagic(buffer), 'jpeg');
    const meta = await sharp(buffer).metadata();
    assert.ok(Math.max(meta.width ?? 0, meta.height ?? 0) <= 2048);
  });
});

test('prepareImageForModel: 大 PNG 截图 → png', async () => {
  await withEnv({ VISION_OUTPUT_FORMAT: undefined }, async () => {
    const large = await solidPng(3000, 2000);
    const { mime } = await prepareImageForModel(large, undefined, 'png');
    assert.equal(mime, 'png');
  });
});

test('prepareImageForModel: HEIC 源（已转 PNG raster）仍走 jpeg', async () => {
  await withEnv({ VISION_OUTPUT_FORMAT: undefined }, async () => {
    const raster = await solidPng(3000, 2000);
    const { mime } = await prepareImageForModel(raster, undefined, 'heic');
    assert.equal(mime, 'jpeg');
  });
});

test('prepareImageForModel: 含 alpha → png（即使 jpeg 源）', async () => {
  await withEnv({ VISION_OUTPUT_FORMAT: undefined }, async () => {
    const rgba = await solidPng(2200, 1800, true);
    const { mime } = await prepareImageForModel(rgba, undefined, 'jpeg');
    assert.equal(mime, 'png');
  });
});

test('prepareImageForModel: 显式 jpeg/webp/png 覆盖', async () => {
  const large = await solidPng(2500, 2500);
  await withEnv({ VISION_OUTPUT_FORMAT: 'jpeg', VISION_OUTPUT_QUALITY: '85' }, async () => {
    const { mime } = await prepareImageForModel(large, undefined, 'png');
    assert.equal(mime, 'jpeg');
  });
  await withEnv({ VISION_OUTPUT_FORMAT: 'webp' }, async () => {
    const { mime } = await prepareImageForModel(large, undefined, 'png');
    assert.equal(mime, 'webp');
  });
  await withEnv({ VISION_OUTPUT_FORMAT: 'png' }, async () => {
    const jpeg = await solidJpeg(2500, 2500);
    const { mime } = await prepareImageForModel(jpeg, undefined, 'jpeg');
    assert.equal(mime, 'png');
  });
});

test('applyRegion: JPEG 源裁切 → jpeg；PNG 源 → png', async () => {
  await withEnv({ VISION_OUTPUT_FORMAT: undefined }, async () => {
    const jpeg = await solidJpeg(200, 200);
    const outJ = await applyRegion(jpeg, { x: 10, y: 10, width: 80, height: 80 }, undefined, 'jpeg');
    assert.equal(mimeSubtypeFromMagic(outJ), 'jpeg');

    const png = await solidPng(200, 200);
    const outP = await applyRegion(png, { x: 10, y: 10, width: 80, height: 80 }, undefined, 'png');
    assert.equal(mimeSubtypeFromMagic(outP), 'png');
  });
});
