// 零成本单元测试：工具注册清单与错误前缀（不发起任何网络请求）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildTools } from '../build/tools.js';
import { toolError, createServer, resolveImageSource } from '../build/server.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function fixture(name) {
  const p = join(process.cwd(), 'test', name);
  writeFileSync(p, TINY_PNG);
  return p;
}

test('2 个工具注册：vision + compare', () => {
  const names = buildTools().map((t) => t.name).sort();
  assert.deepEqual(names, ['compare', 'vision']);
});

test('vision 必填 task；image 可选', () => {
  const t = buildTools().find((x) => x.name === 'vision');
  assert.ok(t, 'vision 应存在');
  assert.deepEqual(t.inputSchema.required, ['task']);
  assert.ok(t.inputSchema.properties?.image);
  assert.ok(t.inputSchema.properties?.region);
  assert.equal(t.inputSchema.properties?.capability, undefined);
  assert.equal(t.inputSchema.properties?.source, undefined);
  assert.equal(t.inputSchema.properties?.format, undefined);
  assert.equal(t.inputSchema.properties?.lang, undefined);
});

test('compare 必填 image1/image2/task', () => {
  const t = buildTools().find((x) => x.name === 'compare');
  assert.ok(t, 'compare 应存在');
  assert.deepEqual(t.inputSchema.required, ['image1', 'image2', 'task']);
  assert.equal(t.inputSchema.properties?.region_a, undefined);
  assert.equal(t.inputSchema.properties?.region_b, undefined);
  assert.equal(t.inputSchema.properties?.format, undefined);
});

test('vision region schema 仅像素字段，无 unit', () => {
  const t = buildTools().find((x) => x.name === 'vision');
  const region = t.inputSchema.properties?.region;
  assert.ok(region);
  assert.deepEqual(region.required, ['x', 'y', 'width', 'height']);
  assert.equal(region.properties?.unit, undefined);
});

test('resolveImageSource: 缺省 → clipboard', () => {
  assert.deepEqual(resolveImageSource(undefined), { kind: 'clipboard' });
  assert.deepEqual(resolveImageSource(''), { kind: 'clipboard' });
  assert.deepEqual(resolveImageSource('clipboard'), { kind: 'clipboard' });
});

test('resolveImageSource: screenshot 字面量', () => {
  assert.deepEqual(resolveImageSource('screenshot'), { kind: 'screenshot' });
});

test('resolveImageSource: 绝对路径存在 → path', () => {
  const img = fixture('resolve-path.png');
  try {
    const r = resolveImageSource(img);
    assert.equal(r.kind, 'path');
    assert.equal(r.path, img);
  } finally {
    unlinkSync(img);
  }
});

test('resolveImageSource: base64 → base64', () => {
  const b64 = TINY_PNG.toString('base64');
  const r = resolveImageSource(b64);
  assert.equal(r.kind, 'base64');
  assert.equal(r.data, b64);
});

test('resolveImageSource: 相对路径 → 抛错含 卡在 图片解析', () => {
  assert.throws(
    () => resolveImageSource('relative.png'),
    (e) => e instanceof Error && /卡在 图片解析/.test(e.message)
  );
});

test('vision 缺 task → ValidationError', async () => {
  const { createServer } = await import('../build/server.js');
  const server = createServer({ analyzeData: async () => 'no' });
  const handler = server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call',
    params: { name: 'vision', arguments: {} },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /task is required/);
});

test('vision path 缺文件 → ValidationError 图片解析', async () => {
  const server = createServer({ analyzeData: async () => 'no' });
  const handler = server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call',
    params: {
      name: 'vision',
      arguments: {
        task: 'describe',
        image: '/nonexistent/abs/path.png',
      },
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /卡在 图片解析/);
});

test('旧工具名 deepseek_vision → 未知工具 isError', async () => {
  const server = createServer({ analyzeData: async () => 'should-not-run' });
  const handler = server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call',
    params: {
      name: 'deepseek_vision',
      arguments: { task: 'x', image: '/tmp/x.png' },
    },
  });
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /\[deepseek-vision 内部错误\] ValidationError: 未知工具: deepseek_vision/
  );
});

test('旧工具名 compare_images → 未知工具 isError', async () => {
  const server = createServer({ analyzeCompare: async () => 'no' });
  const handler = server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call',
    params: {
      name: 'compare_images',
      arguments: { image1: 'a', image2: 'b', task: 'x' },
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /未知工具: compare_images/);
});

test('未知工具 → 带前缀错误 isError', async () => {
  const server = createServer({ analyzeData: async () => 'should-not-run' });
  const handler = server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call',
    params: { name: 'extract_text', arguments: { task: 'x' } },
  });
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /\[deepseek-vision 内部错误\] ValidationError: 未知工具: extract_text/
  );
});

test('vision base64 image → stub analyzeData 成功', async () => {
  const TINY_PNG_B64 = TINY_PNG.toString('base64');
  let analyzeDataCalled = false;
  const mockClient = {
    analyzeData: async (data, prompt) => {
      analyzeDataCalled = true;
      assert.ok(data.length > 0);
      assert.equal(typeof prompt, 'string');
      return 'from-base64';
    },
  };
  const server = createServer(mockClient);
  const handler = server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call',
    params: {
      name: 'vision',
      arguments: {
        task: 'extract text',
        image: TINY_PNG_B64,
      },
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'from-base64');
  assert.equal(analyzeDataCalled, true);
});

test('错误前缀格式', () => {
  assert.equal(
    toolError('ImageValidationError', 'x'),
    '[deepseek-vision 内部错误] ImageValidationError: x'
  );
});
