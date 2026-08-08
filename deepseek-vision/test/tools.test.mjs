// 零成本单元测试：工具注册清单与错误前缀（不发起任何网络请求）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTools } from '../build/tools.js';
import { toolError } from '../build/server.js';

test('7 个工具注册，名称齐全', () => {
  const names = buildTools()
    .map((t) => t.name)
    .sort();
  assert.deepEqual(
    names,
    [
      'analyze_chart',
      'analyze_image',
      'code_from_screenshot',
      'describe_ui',
      'diagnose_error',
      'extract_text',
      'understand_diagram',
    ].sort()
  );
});

test('每个工具必填 source，enum 为 clipboard|path', () => {
  for (const t of buildTools()) {
    assert.deepEqual(t.inputSchema.required, ['source']);
    const source = t.inputSchema.properties?.source;
    assert.ok(source, `${t.name} 应有 source`);
    assert.deepEqual(source.enum, ['clipboard', 'path']);
    assert.ok(t.inputSchema.properties?.image_path, `${t.name} 应有 image_path`);
  }
});

test('analyze_image 带可选 prompt 参数', () => {
  const t = buildTools().find((x) => x.name === 'analyze_image');
  assert.ok(t, 'analyze_image 应存在');
  assert.ok(t.inputSchema.properties?.prompt);
  assert.deepEqual(t.inputSchema.required, ['source']);
});

test('非 analyze_image 工具无 prompt 参数', () => {
  const t = buildTools().find((x) => x.name === 'extract_text');
  assert.ok(t, 'extract_text 应存在');
  assert.equal(t.inputSchema.properties?.prompt, undefined);
});

test('source=path 时 image_path 为条件字段（schema 非必填，运行时校验）', () => {
  for (const t of buildTools()) {
    // image_path 不进 required：仅 source=path 时运行时要求
    assert.ok(!((t.inputSchema.required ?? []).includes('image_path')));
    assert.equal(t.inputSchema.properties?.image_path?.type, 'string');
  }
});

test('source=path 缺 image_path → 带前缀错误 isError', async () => {
  const { createServer } = await import('../build/server.js');
  // stub：校验在调用 VisionClient 之前返回，不会触网
  const server = createServer({ analyze: async () => 'should-not-run' });
  const handler = server._requestHandlers.get('tools/call');
  assert.ok(handler, 'tools/call handler 应存在');
  const result = await handler({
    method: 'tools/call',
    params: { name: 'extract_text', arguments: { source: 'path' } },
  });
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /\[deepseek-vision 内部错误\] ValidationError: image_path is required when source=path/
  );
});

test('未知工具 → 带前缀错误 isError', async () => {
  const { createServer } = await import('../build/server.js');
  const server = createServer({ analyze: async () => 'should-not-run' });
  const handler = server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call',
    params: { name: 'analyze_image_from_clipboard', arguments: {} },
  });
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /\[deepseek-vision 内部错误\] ValidationError: 未知工具: analyze_image_from_clipboard/
  );
});

test('错误前缀格式', () => {
  assert.equal(
    toolError('ImageValidationError', 'x'),
    '[deepseek-vision 内部错误] ImageValidationError: x'
  );
});
