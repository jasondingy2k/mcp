// 零成本单元测试：region 裁切 parseRegion / applyRegion / schema
// 运行：npm run build && node --test test/region.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { parseRegion, applyRegion, ImageValidationError } from '../build/image.js';
import { buildTools } from '../build/tools.js';
import { createServer } from '../build/server.js';

async function make100x100Png() {
  return sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
}

test('parseRegion: 合法像素坐标通过', () => {
  assert.deepEqual(parseRegion({ x: 10, y: 20, width: 30, height: 40 }), {
    x: 10,
    y: 20,
    width: 30,
    height: 40,
  });
});

test('parseRegion: 含 unit → 抛错含 卡在 区域裁切', () => {
  assert.throws(
    () => parseRegion({ x: 0, y: 0, width: 10, height: 10, unit: 'px' }),
    (e) => e instanceof ImageValidationError && /不支持 unit/.test(e.message)
  );
  assert.throws(
    () => parseRegion({ x: 0, y: 0, width: 10, height: 10, unit: 'ratio' }),
    (e) => e instanceof ImageValidationError && /卡在 区域裁切/.test(e.message)
  );
});

test('parseRegion: 缺字段 / 负宽 → 抛错含 卡在 区域裁切', () => {
  assert.throws(
    () => parseRegion({ x: 0, y: 0, width: 10 }),
    (e) => e instanceof ImageValidationError && /卡在 区域裁切/.test(e.message)
  );
  assert.throws(
    () => parseRegion({ x: 0, y: 0, width: -1, height: 10 }),
    (e) => e instanceof ImageValidationError && /卡在 区域裁切/.test(e.message)
  );
});

test('applyRegion: 中心 50×50 px → 结果约 50×50', async () => {
  const src = await make100x100Png();
  const out = await applyRegion(src, { x: 25, y: 25, width: 50, height: 50 });
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 50);
  assert.equal(meta.height, 50);
});

test('applyRegion: 部分越界 clamp 仍成功且尺寸合理', async () => {
  const src = await make100x100Png();
  const out = await applyRegion(src, { x: -10, y: -10, width: 30, height: 30 });
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 20);
  assert.equal(meta.height, 20);
});

test('applyRegion: 完全在图外 → 报错含 卡在 区域裁切', async () => {
  const src = await make100x100Png();
  await assert.rejects(
    applyRegion(src, { x: 200, y: 200, width: 10, height: 10 }),
    (e) => e instanceof ImageValidationError && /卡在 区域裁切/.test(e.message)
  );
});

test('tools schema: vision 有 region 无 unit；compare 无 region', () => {
  const vision = buildTools().find((t) => t.name === 'vision');
  const compare = buildTools().find((t) => t.name === 'compare');
  const region = vision.inputSchema.properties?.region;
  assert.ok(region);
  assert.deepEqual(region.required, ['x', 'y', 'width', 'height']);
  assert.equal(region.properties?.unit, undefined);
  assert.equal(compare.inputSchema.properties?.region, undefined);
});

test('createServer: 非法 region → isError', async () => {
  const server = createServer({ analyzeData: async () => 'should-not-run' });
  const handler = server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call',
    params: {
      name: 'vision',
      arguments: {
        task: 'describe',
        image: '/tmp/x.png',
        region: { x: 0, y: 0, width: 10, height: 10, unit: 'px' },
      },
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /\[deepseek-vision 内部错误\] ImageValidationError:.*卡在 区域裁切/);
});
