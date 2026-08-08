// research 深度阶段单测（零成本：纯函数 + 注入 mock，不发起任何网络请求）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDepthPlan,
  buildDepthPlan,
  runDepthSearches,
  readResearchConfig,
  RESEARCH_BREADTH_MAX_RESULTS,
} from '../build/index.js';

const R = (content, finishReason = 'stop', usage = null) => ({ content, finishReason, usage });

function cfg(env = {}) {
  return { ...readResearchConfig(env), apiKey: 'test-key' };
}

// ---- parseDepthPlan ----
test('parseDepthPlan: 合法 JSON → plan；field=depth 校验', () => {
  const p = parseDepthPlan('{"intent_summary":"i","depth":[{"question":"d","reason":"r"}]}');
  assert.ok(p);
  assert.equal(p.depth.length, 1);
  assert.equal(p.depth[0].question, 'd');
  // field 必须是 depth
  assert.equal(parseDepthPlan('{"intent_summary":"i","breadth":[{"question":"d"}]}'), null);
  assert.equal(parseDepthPlan('bad'), null);
});

// ---- buildDepthPlan ----
test('buildDepthPlan: prompt 含 x 预算 + brief 输入；合法返回', async () => {
  let seen = { system: '', user: '' };
  const plan = await buildDepthPlan({
    task: '调研 X',
    config: cfg(),
    intentSummary: 'i',
    breadthUsed: 3,
    briefs: [{ question: 'q1', title: 'T1', url: 'U1', content: 'C1' }],
    chatFn: async (opts) => {
      const sys = opts.messages.find((m) => m.role === 'system');
      const usr = opts.messages.find((m) => m.role === 'user');
      seen.system = sys ? sys.content : '';
      seen.user = usr ? usr.content : '';
      return R('{"intent_summary":"i2","depth":[{"question":"d","reason":"r"}]}');
    },
  });
  assert.equal(plan.depth.length, 1);
  assert.match(seen.system, /\[2, 7\]/); // minDepth=2, maxSearches-breadthUsed=10-3=7
  assert.match(seen.user, /Breadth intent: i/);
  assert.match(seen.user, /\[q1\] T1 \| U1 \| C1/);
});

test('buildDepthPlan: 深度只加深意图，不得开新面（prompt 含禁令）', async () => {
  let seenSystem = '';
  await buildDepthPlan({
    task: 't', config: cfg(), intentSummary: 'i', breadthUsed: 3, briefs: [],
    chatFn: async (opts) => {
      const sys = opts.messages.find((m) => m.role === 'system');
      seenSystem = sys ? sys.content : '';
      return R('{"intent_summary":"i","depth":[{"question":"d"}]}');
    },
  });
  assert.match(seenSystem, /Do not open unrelated new fronts/);
});

test('buildDepthPlan: brief content 只喂首段摘要，不塞全文（防挤崩输出）', async () => {
  let seenUser = '';
  const longContent = 'H'.repeat(1000); // 超 RESEARCH_DEPTH_BRIEF_HEAD_CHARS=300
  await buildDepthPlan({
    task: 't', config: cfg(), intentSummary: 'i', breadthUsed: 3,
    briefs: [{ question: 'q1', title: 'T1', url: 'U1', content: longContent }],
    chatFn: async (opts) => {
      const usr = opts.messages.find((m) => m.role === 'user');
      seenUser = usr ? usr.content : '';
      return R('{"intent_summary":"i","depth":[{"question":"d"}]}');
    },
  });
  // 标题 + url + 摘要头完整
  assert.match(seenUser, /\[q1\] T1 \| U1 \| H{300}…/);
  // 摘要头之后不得出现全文尾巴（第 301 个字符起是全文内容，应被截断）
  assert.ok(!seenUser.includes('H'.repeat(1000)), '全文不得进入深度规划 prompt');
  assert.ok(!seenUser.includes('H'.repeat(301)), '第 301 字符起全文内容已截断');
});

test('buildDepthPlan: 400 response_format → 第二次去 json；超上限截断到 max−breadthUsed', async () => {
  const jsonFlags = [];
  const plan = await buildDepthPlan({
    task: 't', config: cfg(), intentSummary: 'i', breadthUsed: 3, briefs: [],
    chatFn: async (opts) => {
      jsonFlags.push(opts.json);
      if (jsonFlags.length === 1) throw new Error('research LLM HTTP 400: response_format');
      return R(JSON.stringify({
        intent_summary: 'i',
        depth: Array.from({ length: 20 }, (_, i) => ({ question: `d${i}`, reason: '' })),
      }));
    },
  });
  assert.deepEqual(jsonFlags, [true, false]);
  assert.equal(plan.depth.length, 7); // 10 − 3
});

test('buildDepthPlan: 无 key → 明确报错', async () => {
  await assert.rejects(
    buildDepthPlan({ task: 't', config: readResearchConfig({}), intentSummary: 'i', breadthUsed: 3, briefs: [] }),
    /未配置主代理 key/
  );
});

test('buildDepthPlan: 首次非法 → 重试后成功', async () => {
  let calls = 0;
  const plan = await buildDepthPlan({
    task: 't', config: cfg(), intentSummary: 'i', breadthUsed: 3, briefs: [],
    chatFn: async () => {
      calls++;
      if (calls === 1) return R('not json');
      return R('{"intent_summary":"i","depth":[{"question":"d"}]}');
    },
  });
  assert.equal(calls, 2);
  assert.equal(plan.depth.length, 1);
});

// ---- runDepthSearches ----
test('runDepthSearches: 串行执行（前一个完成才发起下一个）', async () => {
  const order = [];
  const plan = { intentSummary: 'i', depth: [{ question: 'd1', reason: '' }, { question: 'd2', reason: '' }] };
  const out = await runDepthSearches({
    plan,
    searchFn: async ({ query }) => {
      order.push('start:' + query);
      await new Promise((r) => setTimeout(r, 5));
      order.push('end:' + query);
      return { results: [{ title: query, url: 'u', content: 'c' }] };
    },
  });
  assert.deepEqual(order, ['start:d1', 'end:d1', 'start:d2', 'end:d2']); // 严格串行
  assert.equal(out.evidence.length, 2);
  assert.equal(out.executed, 2);
  assert.ok(out.evidence.every((e) => e.phase === 'depth'));
});

test('runDepthSearches: 失败立即跳下一条（不阻塞后续）', async () => {
  const plan = { intentSummary: 'i', depth: [{ question: 'd1', reason: '' }, { question: 'd2', reason: '' }, { question: 'd3', reason: '' }] };
  const calls = [];
  const out = await runDepthSearches({
    plan,
    searchFn: async ({ query }) => {
      calls.push(query);
      if (query === 'd2') throw new Error('boom');
      return { results: [{ title: query, url: 'u', content: 'c', raw_content: 'RAW' }] };
    },
  });
  assert.deepEqual(calls, ['d1', 'd2', 'd3']); // d2 失败仍继续 d3
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].question, 'd2');
  assert.equal(out.evidence.length, 2);
  assert.equal(out.executed, 3);
  assert.equal(out.evidence[0].rawContent, 'RAW');
});

test('runDepthSearches: include_raw_content=true + max_results 默认 4 透传', async () => {
  const plan = { intentSummary: 'i', depth: [{ question: 'd', reason: '' }] };
  let seenParams = null;
  const out = await runDepthSearches({
    plan,
    searchFn: async (p) => { seenParams = p; return { results: [] }; },
  });
  assert.deepEqual(seenParams, {
    query: 'd', max_results: RESEARCH_BREADTH_MAX_RESULTS, search_depth: 'basic', include_raw_content: true,
  });
  assert.equal(out.executed, 1);
});

test('runDepthSearches: deadline 已过 → 放弃全部，executed=0', async () => {
  const plan = { intentSummary: 'i', depth: [{ question: 'd1', reason: '' }, { question: 'd2', reason: '' }] };
  let searchCalled = false;
  const out = await runDepthSearches({
    plan,
    searchFn: async () => { searchCalled = true; return { results: [] }; },
    deadlineMs: Date.now() - 1, // 预算已耗尽
  });
  assert.equal(out.executed, 0);
  assert.equal(searchCalled, false);
  assert.equal(out.evidence.length, 0);
  assert.ok(out.failed.some((f) => f.question === '（剩余深度）'));
});
