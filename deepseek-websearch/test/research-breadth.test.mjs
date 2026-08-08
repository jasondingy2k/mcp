// research 广度阶段单测（零成本：纯函数 + 注入 mock，不发起任何网络请求）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBreadthPlan,
  stripCodeFence,
  clampBreadth,
  buildBreadthPlan,
  runBreadthSearches,
  readResearchConfig,
  RESEARCH_BREADTH_MAX_RESULTS,
} from '../build/index.js';

// chatFn mock 辅助：返回 ChatResult 对象
const R = (content, finishReason = 'stop', usage = null) => ({ content, finishReason, usage });

// ---- parseBreadthPlan ----
test('parseBreadthPlan: 合法 JSON → plan（reason 可缺省）', () => {
  const p = parseBreadthPlan('{"intent_summary":"研究 X","breadth":[{"question":"Q1","reason":"R1"},{"question":"Q2"}]}');
  assert.ok(p);
  assert.equal(p.intentSummary, '研究 X');
  assert.equal(p.breadth.length, 2);
  assert.equal(p.breadth[0].question, 'Q1');
  assert.equal(p.breadth[1].reason, '');
});

test('parseBreadthPlan: 畸形 / 缺字段 / 空 / 条目非法 → null', () => {
  assert.equal(parseBreadthPlan('not json'), null);
  assert.equal(parseBreadthPlan('{"breadth":[{"question":"Q"}]}'), null); // 缺 intent_summary
  assert.equal(parseBreadthPlan('{"intent_summary":"x","breadth":[]}'), null); // 空数组
  assert.equal(parseBreadthPlan('{"intent_summary":"x","breadth":[{"question":"  "}]}'), null); // question 空白
  assert.equal(parseBreadthPlan('{"intent_summary":"x","breadth":[1]}'), null); // 条目非对象
  assert.equal(parseBreadthPlan('[1,2]'), null); // 顶层数组
});

// ---- stripCodeFence ----
test('stripCodeFence: 剥 ```json fence；无 fence 原样', () => {
  assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFence('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');
});

test('parseBreadthPlan: 带 fence 也能解析（400 降级配套）', () => {
  const p = parseBreadthPlan('```json\n{"intent_summary":"i","breadth":[{"question":"q"}]}\n```');
  assert.ok(p);
  assert.equal(p.breadth.length, 1);
});

// ---- clampBreadth ----
test('clampBreadth: 超上限截断；不超不变（不补假问题）', () => {
  const plan = { intentSummary: 'x', breadth: [{ question: 'q', reason: '' }, { question: 'q2', reason: '' }] };
  assert.equal(clampBreadth(plan, 1).breadth.length, 1);
  assert.equal(clampBreadth(plan, 5).breadth.length, 2);
});

// ---- buildBreadthPlan ----
// mock 测试用假 key 走正常路径；无 key 报错单独测。
function cfg(env = {}) {
  return { ...readResearchConfig(env), apiKey: 'test-key' };
}

test('buildBreadthPlan: chatFn 合法返回 → plan（prompt 含 y 预算范围）', async () => {
  let seenSystem = '';
  const plan = await buildBreadthPlan({
    task: '调研 X',
    config: cfg(),
    chatFn: async (opts) => {
      const sys = opts.messages.find((m) => m.role === 'system');
      seenSystem = sys ? sys.content : '';
      return R('{"intent_summary":"i","breadth":[{"question":"q","reason":"r"}]}');
    },
  });
  assert.equal(plan.breadth.length, 1);
  assert.match(seenSystem, /\[3, 8\]/); // minBreadth=3, maxSearches-minDepth=10-2=8
});

test('buildBreadthPlan: 首次非法 → 重试后成功；始终非法 → 抛错', async () => {
  let calls = 0;
  const p = await buildBreadthPlan({
    task: 't',
    config: cfg(),
    chatFn: async () => {
      calls++;
      if (calls === 1) return R('bad');
      return R('{"intent_summary":"i","breadth":[{"question":"q"}]}');
    },
  });
  assert.equal(calls, 2);
  assert.equal(p.breadth.length, 1);

  await assert.rejects(
    buildBreadthPlan({ task: 't', config: cfg(), chatFn: async () => R('bad') }),
    /广度规划失败/
  );
});

test('buildBreadthPlan: 400 response_format → 第二次去 json 降级', async () => {
  const jsonFlags = [];
  const p = await buildBreadthPlan({
    task: 't',
    config: cfg(),
    chatFn: async (opts) => {
      jsonFlags.push(opts.json);
      if (jsonFlags.length === 1) throw new Error('research LLM HTTP 400: response_format unsupported');
      return R('{"intent_summary":"i","breadth":[{"question":"q"}]}');
    },
  });
  assert.deepEqual(jsonFlags, [true, false]);
  assert.equal(p.breadth.length, 1);
});

test('buildBreadthPlan: 无 key → 明确报错（不回退）', async () => {
  await assert.rejects(
    buildBreadthPlan({ task: 't', config: readResearchConfig({}) }),
    /未配置主代理 key/
  );
});

test('buildBreadthPlan: 超上限截断到 max−minDepth', async () => {
  const plan = await buildBreadthPlan({
    task: 't',
    config: cfg(),
    chatFn: async () => R(JSON.stringify({
      intent_summary: 'i',
      breadth: Array.from({ length: 20 }, (_, i) => ({ question: `q${i}`, reason: '' })),
    })),
  });
  assert.equal(plan.breadth.length, 8); // 10 − 2
});

// ---- runBreadthSearches ----
test('runBreadthSearches: brief + evidence 双轨；部分失败记 failed', async () => {
  const plan = { intentSummary: 'i', breadth: [{ question: 'q1', reason: '' }, { question: 'q2', reason: '' }] };
  const out = await runBreadthSearches({
    plan,
    searchFn: async ({ query }) => {
      if (query === 'q2') throw new Error('boom');
      return { results: [{ title: 'T1', url: 'U1', content: 'C1', raw_content: 'RAW1' }, { title: 'T2', url: 'U2', content: 'C2' }] };
    },
  });
  assert.equal(out.briefs.length, 2);
  assert.equal(out.evidence.length, 2);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].question, 'q2');
  assert.equal(out.briefs[0].content, 'C1');
  // evidence 双轨：raw_content 进 evidence，不进 brief
  assert.equal(out.evidence[0].rawContent, 'RAW1');
  assert.equal(out.evidence[0].phase, 'breadth');
  assert.ok(!('rawContent' in out.briefs[0]), 'brief 不含 raw');
});

test('runBreadthSearches: include_raw_content=true 传入 searchFn；缺 results 记 failed', async () => {
  const plan = { intentSummary: 'i', breadth: [{ question: 'q', reason: '' }] };
  let seenParams = null;
  const out = await runBreadthSearches({
    plan,
    searchFn: async (p) => { seenParams = p; return { nope: 1 }; },
  });
  assert.deepEqual(seenParams, {
    query: 'q', max_results: RESEARCH_BREADTH_MAX_RESULTS, search_depth: 'basic', include_raw_content: true,
  });
  assert.equal(out.failed.length, 1);
  assert.equal(out.briefs.length, 0);
  assert.equal(out.evidence.length, 0);
});

test('runBreadthSearches: 空 results 数组 → 非失败、无 brief/evidence', async () => {
  const plan = { intentSummary: 'i', breadth: [{ question: 'q', reason: '' }] };
  const out = await runBreadthSearches({
    plan,
    searchFn: async () => ({ results: [] }),
  });
  assert.equal(out.failed.length, 0);
  assert.equal(out.briefs.length, 0);
  assert.equal(out.evidence.length, 0);
});
