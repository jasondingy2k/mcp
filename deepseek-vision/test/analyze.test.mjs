// 零成本单元测试：VisionClient.analyze 的空 content 重试逻辑
// （本地假 OpenAI 服务器模拟 mimo-v2.5 行为，不触网）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { VisionClient } from '../build/server.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

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
        const client = new VisionClient('test-key', `http://127.0.0.1:${port}/v1`, 'mimo-v2.5');
        const out = await client.analyze(img, 'describe');
        assert.equal(out, 'final answer');
        assert.equal(requests.length, 2);
        assert.equal(requests[0].max_tokens, 4096);
        assert.equal(requests[1].max_tokens, 8192); // 加倍
        assert.equal(requests[0].temperature, 0.3);
        assert.ok(
          requests[0].messages[0].content[0].image_url.url.startsWith('data:image/png;base64,')
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
        const client = new VisionClient('test-key', `http://127.0.0.1:${port}/v1`, 'mimo-v2.5');
        await assert.rejects(
          client.analyze(img, 'x'),
          (e) =>
            e.message.includes('已自动重试 1 次仍为空') &&
            e.message.includes('finish_reason=stop') &&
            e.message.includes('reasoning 前 200 字: my reasoning')
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
        const client = new VisionClient('test-key', `http://127.0.0.1:${port}/v1`, 'mimo-v2.5');
        await assert.rejects(
          client.analyze(img, 'x'),
          (e) => e.message.includes('请增大 VISION_MAX_TOKENS 后重试')
        );
      } finally {
        unlinkSync(img);
      }
    }
  );
});
