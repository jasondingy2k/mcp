// 零成本单元测试：compare 双图送模与校验
// 运行：npm run build && node --test test/compare.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { VisionClient, createServer } from '../build/server.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const TINY_PNG_B64 = TINY_PNG.toString('base64');

function completion(id, content) {
  return JSON.stringify({
    id,
    object: 'chat.completion',
    created: 1,
    model: 'mimo-v2.5',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

async function withFakeServer(respond, fn) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      respond(JSON.parse(body || '{}'), res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

function fixture(name) {
  const p = join(process.cwd(), 'test', name);
  writeFileSync(p, TINY_PNG);
  return p;
}

function makeClient(port, opts = {}) {
  const providers = [
    {
      name: opts.name ?? 'primary',
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: opts.model ?? 'mimo-v2.5',
      keys: opts.keys ?? ['test-key'],
    },
  ];
  if (opts.fallbackPort != null) {
    providers.push({
      name: 'fallback',
      baseURL: `http://127.0.0.1:${opts.fallbackPort}/v1`,
      model: opts.fallbackModel ?? 'fallback-model',
      keys: opts.fallbackKeys ?? ['fallback-key'],
    });
  }
  return new VisionClient(providers);
}

test('analyzeCompare: 请求含 2 个 image_url 与 Image A/B 文本', async () => {
  let capturedBody;
  await withFakeServer(
    (parsed, res) => {
      capturedBody = parsed;
      res.end(completion('c1', 'diff analysis'));
    },
    async (port) => {
      const client = makeClient(port);
      const payload = { mime: 'png', b64: TINY_PNG_B64 };
      const out = await client.analyzeCompare(payload, payload, 'compare these');
      assert.equal(out, 'diff analysis');
      const content = capturedBody.messages[1].content;
      const images = content.filter((p) => p.type === 'image_url');
      assert.equal(images.length, 2);
      const textPart = content.find((p) => p.type === 'text');
      assert.match(textPart.text, /Image A is the first image; Image B is the second/);
      assert.match(textPart.text, /compare these/);
    }
  );
});

test('compare path: 两张 tiny PNG → 返回模型正文', async () => {
  const imgA = fixture('compare-a.png');
  const imgB = fixture('compare-b.png');
  let capturedBody;
  await withFakeServer(
    (parsed, res) => {
      capturedBody = parsed;
      res.end(completion('c1', 'before and after differ'));
    },
    async (port) => {
      const client = makeClient(port);
      const server = createServer(client);
      const handler = server._requestHandlers.get('tools/call');
      const result = await handler({
        method: 'tools/call',
        params: {
          name: 'compare',
          arguments: {
            image1: imgA,
            image2: imgB,
            task: 'what changed?',
          },
        },
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.content[0].text, 'before and after differ');
      const images = capturedBody.messages[1].content.filter((p) => p.type === 'image_url');
      assert.equal(images.length, 2);
    }
  );
  unlinkSync(imgA);
  unlinkSync(imgB);
});

test('compare base64: 两张 tiny PNG → 返回模型正文', async () => {
  await withFakeServer(
    (parsed, res) => {
      res.end(completion('c1', 'base64 compare ok'));
    },
    async (port) => {
      const client = makeClient(port);
      const server = createServer(client);
      const handler = server._requestHandlers.get('tools/call');
      const result = await handler({
        method: 'tools/call',
        params: {
          name: 'compare',
          arguments: {
            image1: TINY_PNG_B64,
            image2: TINY_PNG_B64,
            task: 'are they identical?',
          },
        },
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.content[0].text, 'base64 compare ok');
    }
  );
});

test('compare 缺 task → ValidationError isError', async () => {
  const server = createServer({ analyzeCompare: async () => 'no' });
  const handler = server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call',
    params: {
      name: 'compare',
      arguments: { image1: '/tmp/a.png', image2: '/tmp/b.png' },
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /task is required/);
});

test('compare 缺 image2 → ValidationError isError', async () => {
  const imgA = fixture('compare-missing2-a.png');
  const server = createServer({ analyzeCompare: async () => 'no' });
  const handler = server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call',
    params: {
      name: 'compare',
      arguments: { image1: imgA, task: 'diff' },
    },
  });
  assert.equal(result.isError, true);
  assert.match(
    result.content[0].text,
    /\[deepseek-vision 内部错误\] ValidationError: image2 is required/
  );
  unlinkSync(imgA);
});

test('compare image2 不存在路径 → ValidationError 图片解析', async () => {
  const imgA = fixture('compare-missing-a.png');
  const server = createServer({ analyzeCompare: async () => 'no' });
  const handler = server._requestHandlers.get('tools/call');
  const result = await handler({
    method: 'tools/call',
    params: {
      name: 'compare',
      arguments: {
        image1: imgA,
        image2: '/nonexistent/abs/b.png',
        task: 'diff',
      },
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /卡在 图片解析/);
  unlinkSync(imgA);
});
