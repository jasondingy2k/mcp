// 零成本单元测试：VisionClient.analyze 的空 content 重试逻辑
// （本地假 OpenAI 服务器模拟 mimo-v2.5 行为，不触网）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { VisionClient, createServer } from '../build/server.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const TINY_PNG_B64 = TINY_PNG.toString('base64');

function completion(id, content, reasoning, finishReason) {
  return JSON.stringify({
    id, object: 'chat.completion', created: 1, model: 'mimo-v2.5',
    choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: reasoning }, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

async function withFakeServer(respond, fn) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      respond(JSON.parse(body || '{}'), res, req);
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

/** v0.5 providers 数组构造；可选 fallbackPort 挂第二池 */
function makeClient(port, opts = {}) {
  const providers = [
    {
      name: opts.name ?? 'primary',
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: opts.model ?? 'mimo-v2.5',
      keys: opts.keys ?? ['test-key'],
      reasoningEffortCapability: opts.reasoningEffortCapability ?? 'auto',
    },
  ];
  if (opts.fallbackPort != null) {
    providers.push({
      name: 'fallback',
      baseURL: `http://127.0.0.1:${opts.fallbackPort}/v1`,
      model: opts.fallbackModel ?? 'fallback-model',
      keys: opts.fallbackKeys ?? ['fallback-key'],
      reasoningEffortCapability: opts.fallbackReasoningEffortCapability ?? 'auto',
    });
  }
  return new VisionClient(providers);
}

test('analyze: 空 content 自动重试 1 次并加倍 max_tokens', async () => {
  const requests = [];
  await withFakeServer(
    (parsed, res) => {
      requests.push(parsed);
      if (requests.length === 1) {
        res.end(completion('c1', null, 'thinking hard', 'length'));
      } else {
        res.end(completion('c2', 'final answer', 'thinking hard', 'stop'));
      }
    },
    async (port) => {
      const img = fixture('analyze-fixture.png');
      try {
        const client = makeClient(port);
        const out = await client.analyze(img, 'describe');
        assert.equal(out, 'final answer');
        assert.equal(requests.length, 2);
        assert.equal(requests[0].max_tokens, 4096);
        assert.equal(requests[1].max_tokens, 8192);
        assert.equal(requests[0].temperature, 0.3);
        assert.ok(
          requests[0].messages[1].content[0].image_url.url.startsWith('data:image/png;base64,')
        );
      } finally {
        unlinkSync(img);
      }
    }
  );
});

test('analyze: 两次空 content → 报错含 finish_reason 与 reasoning 提示', async () => {
  await withFakeServer(
    (parsed, res) => {
      res.end(completion('c', null, '  my reasoning  ', 'stop'));
    },
    async (port) => {
      const img = fixture('analyze-fixture2.png');
      try {
        const client = makeClient(port);
        await assert.rejects(
          client.analyze(img, 'x'),
          (e) =>
            e.message.includes('empty content after retry') &&
            e.message.includes('finish_reason=stop') &&
            e.message.includes('reasoning 前 200 字: my reasoning') &&
            e.message.includes('卡在 视觉推理')
        );
      } finally {
        unlinkSync(img);
      }
    }
  );
});

test('analyze: finish_reason=length 且重试后仍空 → 提示增大 VISION_MAX_TOKENS', async () => {
  await withFakeServer(
    (parsed, res) => {
      res.end(completion('c', null, 'long thinking', 'length'));
    },
    async (port) => {
      const img = fixture('analyze-fixture3.png');
      try {
        const client = makeClient(port);
        await assert.rejects(
          client.analyze(img, 'x'),
          (e) =>
            e.message.includes('increase VISION_MAX_TOKENS and retry') &&
            e.message.includes('卡在 视觉推理')
        );
      } finally {
        unlinkSync(img);
      }
    }
  );
});

test('analyze: 大图送模前最长边缩至 ≤2048', async () => {
  const largePath = join(process.cwd(), 'test', 'analyze-large.png');
  await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: { r: 50, g: 60, b: 70 } },
  })
    .png()
    .toFile(largePath);

  let capturedBody;
  await withFakeServer(
    (parsed, res) => {
      capturedBody = parsed;
      res.end(completion('c1', 'ok', '', 'stop'));
    },
    async (port) => {
      try {
        const client = makeClient(port);
        const out = await client.analyze(largePath, 'describe');
        assert.equal(out, 'ok');
        const dataUrl = capturedBody.messages[1].content[0].image_url.url;
        const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        const imgBuf = Buffer.from(b64, 'base64');
        const meta = await sharp(imgBuf).metadata();
        assert.ok(Math.max(meta.width ?? 0, meta.height ?? 0) <= 2048);
      } finally {
        unlinkSync(largePath);
      }
    }
  );
});

test('vision path + task: stub 收到 enhance 后 prompt', async () => {
  let capturedPrompt;
  const mockClient = {
    analyzeData: async (_data, prompt) => {
      capturedPrompt = prompt;
      return 'ok';
    },
  };
  const server = createServer(mockClient);
  const handler = server._requestHandlers.get('tools/call');
  const img = fixture('vision-path-task.png');
  try {
    const result = await handler({
      method: 'tools/call',
      params: {
        name: 'vision',
        arguments: {
          task: 'What color is the pixel?',
          image: img,
        },
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, 'ok');
    assert.equal(capturedPrompt, 'What color is the pixel?');
  } finally {
    unlinkSync(img);
  }
});

test('analyzeData: tiny PNG base64 走完整校验链并送模', async () => {
  let capturedBody;
  await withFakeServer(
    (parsed, res) => {
      capturedBody = parsed;
      res.end(completion('c1', 'base64 ok', '', 'stop'));
    },
    async (port) => {
      const client = makeClient(port);
      const data = Buffer.from(TINY_PNG_B64, 'base64');
      const out = await client.analyzeData(data, 'describe');
      assert.equal(out, 'base64 ok');
      assert.ok(
        capturedBody.messages[1].content[0].image_url.url.startsWith('data:image/png;base64,')
      );
    }
  );
});

test('vision base64 image + task: createServer stub 成功', async () => {
  let analyzeDataCalled = false;
  const mockClient = {
    analyzeData: async (data, prompt) => {
      analyzeDataCalled = true;
      assert.ok(data.length > 0);
      assert.match(prompt, /提取/);
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
        task: '提取截图里的文字',
        image: TINY_PNG_B64,
      },
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'from-base64');
  assert.equal(analyzeDataCalled, true);
});

test('vision 省略 image 默认 clipboard 路径（mock analyzeData）', async () => {
  let called = false;
  const mockClient = {
    analyzeData: async () => {
      called = true;
      return 'clip-ok';
    },
  };
  const server = createServer(mockClient);
  const handler = server._requestHandlers.get('tools/call');
  const orig = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const result = await handler({
      method: 'tools/call',
      params: { name: 'vision', arguments: { task: 'describe' } },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not supported|ClipboardError/i);
  } finally {
    Object.defineProperty(process, 'platform', { value: orig, configurable: true });
  }
  assert.equal(called, false);
});
