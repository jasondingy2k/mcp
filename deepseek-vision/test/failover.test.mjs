// failover / 多池 stub 单测：主备 RR、鉴权换 key、网络 skip、总墙钟、主池耗尽进备池
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { VisionClient } from '../build/server.js';
import { RoundRobin } from '../build/keypool.js';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function completion(content) {
  return JSON.stringify({
    id: 'c1',
    object: 'chat.completion',
    created: 1,
    model: 'mimo-v2.5',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function errorBody(status, message) {
  return JSON.stringify({ error: { message, type: 'invalid_request_error' } });
}

async function withFakeServer(respond, fn) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
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

function makeClient(port, opts = {}) {
  const providers = [
    {
      name: 'primary',
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: 'mimo-v2.5',
      keys: opts.keys ?? ['key-a', 'key-b'],
      reasoningEffortCapability: opts.primaryCapability ?? 'auto',
    },
  ];
  if (opts.fallbackPort != null) {
    providers.push({
      name: 'fallback',
      baseURL: `http://127.0.0.1:${opts.fallbackPort}/v1`,
      model: 'fallback-model',
      keys: opts.fallbackKeys ?? ['fb-key'],
      reasoningEffortCapability: opts.fallbackCapability ?? 'auto',
    });
  }
  return new VisionClient(providers);
}

test('主池 RR: 429 后换同池下一 key 成功', async () => {
  const seen = [];
  await withFakeServer(
    (parsed, res, req) => {
      const auth = req.headers.authorization ?? '';
      seen.push(auth);
      if (auth.includes('key-a')) {
        res.statusCode = 429;
        res.setHeader('content-type', 'application/json');
        res.end(errorBody(429, 'rate limit'));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(completion('from-key-b'));
    },
    async (port) => {
      const img = fixture('failover-rr.png');
      try {
        const client = makeClient(port);
        const out = await client.analyze(img, 'x');
        assert.equal(out, 'from-key-b');
        assert.equal(seen.length, 2);
        assert.ok(seen[0].includes('key-a'));
        assert.ok(seen[1].includes('key-b'));
      } finally {
        unlinkSync(img);
      }
    }
  );
});

test('并发起始 key: 连续 next 轮询不同起点', () => {
  const rr = new RoundRobin(['k1', 'k2']);
  const starts = [rr.next(), rr.next(), rr.next()];
  assert.deepEqual(starts, ['k1', 'k2', 'k1']);
  assert.deepEqual(rr.orderFrom('k2'), ['k2', 'k1']);
});

test('鉴权 401: 同池换 key 后成功', async () => {
  const seen = [];
  await withFakeServer(
    (_parsed, res, req) => {
      const auth = req.headers.authorization ?? '';
      seen.push(auth);
      if (auth.includes('bad-key')) {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(errorBody(401, 'invalid api key'));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(completion('auth-ok'));
    },
    async (port) => {
      const img = fixture('failover-auth.png');
      try {
        const client = new VisionClient([
          {
            name: 'primary',
            baseURL: `http://127.0.0.1:${port}/v1`,
            model: 'mimo-v2.5',
            keys: ['bad-key', 'good-key'],
            reasoningEffortCapability: 'auto',
          },
        ]);
        const out = await client.analyze(img, 'x');
        assert.equal(out, 'auth-ok');
        assert.equal(seen.length, 2);
      } finally {
        unlinkSync(img);
      }
    }
  );
});

test('网络阻断 + 备池: 主池 skip 后进 fallback', async () => {
  let primaryHits = 0;
  let fallbackHits = 0;

  const primaryServer = http.createServer((_req, res) => {
    primaryHits++;
    res.destroy();
  });
  const fallbackServer = http.createServer((_parsed, res) => {
    fallbackHits++;
    res.setHeader('content-type', 'application/json');
    res.end(completion('from-fallback'));
  });

  await new Promise((r) => primaryServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => fallbackServer.listen(0, '127.0.0.1', r));
  const primaryPort = primaryServer.address().port;
  const fallbackPort = fallbackServer.address().port;

  const img = fixture('failover-network.png');
  try {
    const client = new VisionClient([
      {
        name: 'primary',
        baseURL: `http://127.0.0.1:${primaryPort}/v1`,
        model: 'mimo-v2.5',
        keys: ['p1', 'p2'],
        reasoningEffortCapability: 'auto',
      },
      {
        name: 'fallback',
        baseURL: `http://127.0.0.1:${fallbackPort}/v1`,
        model: 'fallback-model',
        keys: ['fb'],
        reasoningEffortCapability: 'auto',
      },
    ]);
    const out = await client.analyze(img, 'x');
    assert.equal(out, 'from-fallback');
    assert.equal(primaryHits, 1, 'network skip 应整组放弃主池，不逐个 key');
    assert.equal(fallbackHits, 1);
  } finally {
    unlinkSync(img);
    primaryServer.close();
    fallbackServer.close();
  }
});

test('主池全部 key 失败 → 备池成功（空响应/错误耗尽后转下级池）', async () => {
  let primaryAttempts = 0;
  let fallbackAttempts = 0;

  const primaryServer = http.createServer((_parsed, res) => {
    primaryAttempts++;
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end(errorBody(401, 'invalid api key'));
  });
  const fallbackServer = http.createServer((_parsed, res) => {
    fallbackAttempts++;
    res.setHeader('content-type', 'application/json');
    res.end(completion('fallback-after-primary-exhausted'));
  });

  await new Promise((r) => primaryServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => fallbackServer.listen(0, '127.0.0.1', r));

  const img = fixture('failover-tier.png');
  try {
    const client = new VisionClient([
      {
        name: 'primary',
        baseURL: `http://127.0.0.1:${primaryServer.address().port}/v1`,
        model: 'mimo-v2.5',
        keys: ['p1', 'p2'],
        reasoningEffortCapability: 'auto',
      },
      {
        name: 'fallback',
        baseURL: `http://127.0.0.1:${fallbackServer.address().port}/v1`,
        model: 'fallback-model',
        keys: ['fb'],
        reasoningEffortCapability: 'auto',
      },
    ]);
    const out = await client.analyze(img, 'x');
    assert.equal(out, 'fallback-after-primary-exhausted');
    assert.equal(primaryAttempts, 2);
    assert.equal(fallbackAttempts, 1);
  } finally {
    unlinkSync(img);
    primaryServer.close();
    fallbackServer.close();
  }
});

test('公用 400: 不可重试的 request 级错误直接抛出', async () => {
  await withFakeServer(
    (_parsed, res) => {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(errorBody(400, 'bad request'));
    },
    async (port) => {
      const img = fixture('failover-400.png');
      try {
        const client = makeClient(port, { keys: ['only-key'] });
        await assert.rejects(
          () => client.analyze(img, 'x'),
          (e) =>
            (e.message.includes('400') || e.message.includes('bad request')) &&
            e.message.includes('卡在 视觉推理')
        );
      } finally {
        unlinkSync(img);
      }
    }
  );
});

test('500 provider-scoped: 有备池时整组 skip 不逐 key', async () => {
  let primaryHits = 0;
  let fallbackHits = 0;

  const primaryServer = http.createServer((_parsed, res) => {
    primaryHits++;
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(errorBody(500, 'server error'));
  });
  const fallbackServer = http.createServer((_parsed, res) => {
    fallbackHits++;
    res.setHeader('content-type', 'application/json');
    res.end(completion('fallback-after-500'));
  });

  await new Promise((r) => primaryServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => fallbackServer.listen(0, '127.0.0.1', r));

  const img = fixture('failover-500.png');
  try {
    const client = new VisionClient([
      {
        name: 'primary',
        baseURL: `http://127.0.0.1:${primaryServer.address().port}/v1`,
        model: 'mimo-v2.5',
        keys: ['p1', 'p2'],
        reasoningEffortCapability: 'auto',
      },
      {
        name: 'fallback',
        baseURL: `http://127.0.0.1:${fallbackServer.address().port}/v1`,
        model: 'fallback-model',
        keys: ['fb'],
        reasoningEffortCapability: 'auto',
      },
    ]);
    const out = await client.analyze(img, 'x');
    assert.equal(out, 'fallback-after-500');
    assert.equal(primaryHits, 1, '500 应整组 skip 主池');
    assert.equal(fallbackHits, 1);
  } finally {
    unlinkSync(img);
    primaryServer.close();
    fallbackServer.close();
  }
});

test('404 model not found: provider-scoped 整池 skip 进备池', async () => {
  let primaryHits = 0;
  let fallbackHits = 0;

  const primaryServer = http.createServer((_parsed, res) => {
    primaryHits++;
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(errorBody(404, 'model not found'));
  });
  const fallbackServer = http.createServer((_parsed, res) => {
    fallbackHits++;
    res.setHeader('content-type', 'application/json');
    res.end(completion('fallback-after-404'));
  });

  await new Promise((r) => primaryServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => fallbackServer.listen(0, '127.0.0.1', r));

  const img = fixture('failover-404.png');
  try {
    const client = new VisionClient([
      {
        name: 'primary',
        baseURL: `http://127.0.0.1:${primaryServer.address().port}/v1`,
        model: 'missing-model',
        keys: ['p1', 'p2'],
        reasoningEffortCapability: 'auto',
      },
      {
        name: 'fallback',
        baseURL: `http://127.0.0.1:${fallbackServer.address().port}/v1`,
        model: 'fallback-model',
        keys: ['fb'],
        reasoningEffortCapability: 'auto',
      },
    ]);
    const out = await client.analyze(img, 'x');
    assert.equal(out, 'fallback-after-404');
    assert.equal(primaryHits, 1, '404 应整组 skip 主池，不试 p2');
    assert.equal(fallbackHits, 1);
  } finally {
    unlinkSync(img);
    primaryServer.close();
    fallbackServer.close();
  }
});

test('空 choices + 备池: 主池空响应后进 fallback', async () => {
  let primaryHits = 0;
  let fallbackHits = 0;

  const primaryServer = http.createServer((_parsed, res) => {
    primaryHits++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'c', choices: [] }));
  });
  const fallbackServer = http.createServer((_parsed, res) => {
    fallbackHits++;
    res.setHeader('content-type', 'application/json');
    res.end(completion('fallback-after-empty-choices'));
  });

  await new Promise((r) => primaryServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => fallbackServer.listen(0, '127.0.0.1', r));

  const img = fixture('failover-empty-choices.png');
  try {
    const client = new VisionClient([
      {
        name: 'primary',
        baseURL: `http://127.0.0.1:${primaryServer.address().port}/v1`,
        model: 'mimo-v2.5',
        keys: ['p1'],
        reasoningEffortCapability: 'auto',
      },
      {
        name: 'fallback',
        baseURL: `http://127.0.0.1:${fallbackServer.address().port}/v1`,
        model: 'fallback-model',
        keys: ['fb'],
        reasoningEffortCapability: 'auto',
      },
    ]);
    const out = await client.analyze(img, 'x');
    assert.equal(out, 'fallback-after-empty-choices');
    assert.equal(primaryHits, 1);
    assert.equal(fallbackHits, 1);
  } finally {
    unlinkSync(img);
    primaryServer.close();
    fallbackServer.close();
  }
});

test('两次空 content + 备池: 主池重试后进 fallback', async () => {
  let primaryHits = 0;
  let fallbackHits = 0;

  const emptyCompletion = () =>
    JSON.stringify({
      id: 'c',
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
    });

  const primaryServer = http.createServer((_parsed, res) => {
    primaryHits++;
    res.setHeader('content-type', 'application/json');
    res.end(emptyCompletion());
  });
  const fallbackServer = http.createServer((_parsed, res) => {
    fallbackHits++;
    res.setHeader('content-type', 'application/json');
    res.end(completion('fallback-after-empty-content'));
  });

  await new Promise((r) => primaryServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => fallbackServer.listen(0, '127.0.0.1', r));

  const img = fixture('failover-empty-content.png');
  try {
    const client = new VisionClient([
      {
        name: 'primary',
        baseURL: `http://127.0.0.1:${primaryServer.address().port}/v1`,
        model: 'mimo-v2.5',
        keys: ['p1'],
        reasoningEffortCapability: 'auto',
      },
      {
        name: 'fallback',
        baseURL: `http://127.0.0.1:${fallbackServer.address().port}/v1`,
        model: 'fallback-model',
        keys: ['fb'],
        reasoningEffortCapability: 'auto',
      },
    ]);
    const out = await client.analyze(img, 'x');
    assert.equal(out, 'fallback-after-empty-content');
    assert.equal(primaryHits, 2, '主池应空 content 重试 1 次');
    assert.equal(fallbackHits, 1);
  } finally {
    unlinkSync(img);
    primaryServer.close();
    fallbackServer.close();
  }
});

test('纯空白 content 视为空，触发重试', async () => {
  let hits = 0;
  await withFakeServer(
    (_parsed, res) => {
      hits++;
      const content = hits === 1 ? '   \n\t  ' : 'real answer';
      res.setHeader('content-type', 'application/json');
      res.end(completion(content));
    },
    async (port) => {
      const img = fixture('failover-whitespace.png');
      try {
        const client = makeClient(port, { keys: ['k1'] });
        const out = await client.analyze(img, 'x');
        assert.equal(out, 'real answer');
        assert.equal(hits, 2);
      } finally {
        unlinkSync(img);
      }
    }
  );
});

test('reasoning_effort: unsupported 能力省略字段', async () => {
  let captured;
  await withFakeServer(
    (parsed, res) => {
      captured = parsed;
      res.setHeader('content-type', 'application/json');
      res.end(completion('ok'));
    },
    async (port) => {
      const img = fixture('failover-no-re.png');
      try {
        const client = makeClient(port, {
          keys: ['k1'],
          primaryCapability: 'unsupported',
        });
        const out = await client.analyze(img, 'x');
        assert.equal(out, 'ok');
        assert.equal(captured.reasoning_effort, undefined);
      } finally {
        unlinkSync(img);
      }
    }
  );
});

test('reasoning_effort: auto 窄降级并缓存', async () => {
  let hits = 0;
  let bodies = [];
  await withFakeServer(
    (parsed, res) => {
      hits++;
      bodies.push(parsed);
      if (hits === 1) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(errorBody(400, 'unknown field reasoning_effort'));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(completion('downgraded'));
    },
    async (port) => {
      const img = fixture('failover-re-downgrade.png');
      const prev = process.env.VISION_REASONING_EFFORT;
      process.env.VISION_REASONING_EFFORT = 'default';
      try {
        const client = makeClient(port, { keys: ['k1'], primaryCapability: 'auto' });
        const out = await client.analyze(img, 'x');
        assert.equal(out, 'downgraded');
        assert.equal(hits, 2);
        assert.equal(bodies[0].reasoning_effort, 'default');
        assert.equal(bodies[1].reasoning_effort, undefined);
      } finally {
        if (prev === undefined) delete process.env.VISION_REASONING_EFFORT;
        else process.env.VISION_REASONING_EFFORT = prev;
        unlinkSync(img);
      }
    }
  );
});

test('reasoning_effort: 窄降级后不占用空 content 重试名额', async () => {
  let hits = 0;
  const bodies = [];
  const emptyBody = () =>
    JSON.stringify({
      id: 'c',
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
    });

  await withFakeServer(
    (parsed, res) => {
      hits++;
      bodies.push(parsed);
      if (hits === 1) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(errorBody(400, 'unknown field reasoning_effort'));
        return;
      }
      if (hits === 2) {
        res.setHeader('content-type', 'application/json');
        res.end(emptyBody());
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(completion('after-empty-retry'));
    },
    async (port) => {
      const img = fixture('failover-re-empty-retry.png');
      const prev = process.env.VISION_REASONING_EFFORT;
      process.env.VISION_REASONING_EFFORT = 'default';
      try {
        const client = makeClient(port, { keys: ['k1'], primaryCapability: 'auto' });
        const out = await client.analyze(img, 'x');
        assert.equal(out, 'after-empty-retry');
        assert.equal(hits, 3, '降级 + 空 content 重试 + 成功');
        assert.equal(bodies[0].reasoning_effort, 'default');
        assert.equal(bodies[1].reasoning_effort, undefined);
        assert.equal(bodies[1].max_tokens, 4096);
        assert.equal(bodies[2].max_tokens, 8192);
      } finally {
        if (prev === undefined) delete process.env.VISION_REASONING_EFFORT;
        else process.env.VISION_REASONING_EFFORT = prev;
        unlinkSync(img);
      }
    }
  );
});

test('总墙钟: 剩余预算不足 3s 时抛视觉推理超时', async () => {
  const realNow = Date.now;
  const start = realNow();
  let elapsed = 0;
  Date.now = () => start + elapsed;

  let reqCount = 0;
  await withFakeServer(
    (_parsed, res) => {
      reqCount++;
      if (reqCount === 1) {
        elapsed = 118_000;
        res.statusCode = 429;
        res.setHeader('content-type', 'application/json');
        res.end(errorBody(429, 'rate limit'));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(completion('should-not-reach'));
    },
    async (port) => {
      const img = fixture('failover-timeout.png');
      try {
        const client = makeClient(port, { keys: ['k1', 'k2'] });
        await assert.rejects(
          () => client.analyze(img, 'x'),
          (e) => e.message.includes('视觉推理总超时')
        );
        assert.equal(reqCount, 1, '第二 key 应在墙钟检查前中止，不再发请求');
      } finally {
        Date.now = realNow;
        unlinkSync(img);
      }
    }
  );
});
