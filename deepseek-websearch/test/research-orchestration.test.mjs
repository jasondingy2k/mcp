// research 总编排单测（零成本：注入 mock chatFn + searchFn，不发起任何网络请求）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runResearch,
  buildDepthPlan,
  synthesizeReport,
  buildResearchAnnotation,
  readResearchConfig,
} from '../build/index.js';

const R = (content, finishReason = 'stop', usage = null) => ({ content, finishReason, usage });

function cfg(env = {}) {
  return { ...readResearchConfig(env), apiKey: 'test-key' };
}

// chatFn mock：按 system 角色区分广度/深度/综合（英文 prompt 标识）
function makeChatFn() {
  return async (opts) => {
    const sys = opts.messages.find((m) => m.role === 'system').content;
    if (/research planner/i.test(sys)) {
      return R('{"intent_summary":"i","breadth":[{"question":"b1","reason":"r"},{"question":"b2","reason":"r"}]}');
    }
    if (/depth planner/i.test(sys)) {
      return R('{"intent_summary":"i2","depth":[{"question":"d1","reason":"r"}]}');
    }
    return R('# 调研报告\n\n正文');
  };
}

// ---- runResearch 全流程 ----
test('runResearch: 广→深→综合全流程；统计标注正确', async () => {
  const res = await runResearch({
    task: '调研 X',
    config: cfg(),
    searchFn: async ({ query }) => ({ results: [{ title: `T:${query}`, url: `https://x/${query}`, content: `C:${query}`, raw_content: `RAW:${query}` }] }),
    chatFn: makeChatFn(),
  });
  assert.ok(!res.error);
  assert.match(res.report, /# 调研报告/);
  assert.match(res.annotation, /搜索次数: 3（广度 2 \+ 深度 1；basic，1 点\/次）/);
  assert.match(res.annotation, /模型调用: 3 次/);
  assert.match(res.annotation, /搜索轮次: 2（1 波广度并行 \+ 1 波深度串行）/);
  assert.ok(!res.annotation.includes('截断'), '正常 stop 不标注截断');
});

test('runResearch: 深度失败不致命 → 继续综合，标注部分失败', async () => {
  const res = await runResearch({
    task: 't',
    config: cfg(),
    searchFn: async ({ query }) => {
      if (query === 'd1') throw new Error('boom');
      return { results: [{ title: query, url: 'u', content: 'c' }] };
    },
    chatFn: makeChatFn(),
  });
  assert.ok(!res.error);
  assert.match(res.report, /# 调研报告/);
  assert.match(res.annotation, /部分失败\(1\): d1: boom/);
});

test('runResearch: 全部无证据 → isError，不进综合', async () => {
  let synthesisCalled = false;
  const res = await runResearch({
    task: 't',
    config: cfg(),
    searchFn: async () => ({ results: [] }),
    chatFn: async (opts) => {
      const sys = opts.messages.find((m) => m.role === 'system').content;
      if (/research planner/i.test(sys)) return R('{"intent_summary":"i","breadth":[{"question":"b1"}]}');
      if (/depth planner/i.test(sys)) return R('{"intent_summary":"i","depth":[{"question":"d1"}]}');
      synthesisCalled = true;
      return R('report');
    },
  });
  assert.match(res.error, /无任何搜索结果/);
  assert.equal(synthesisCalled, false);
});

test('runResearch: 无 key → isError（不回退）', async () => {
  const res = await runResearch({
    task: 't',
    config: readResearchConfig({}),
    searchFn: async () => ({ results: [] }),
  });
  assert.match(res.error, /未配置主代理 key/);
});

test('runResearch: 广度规划失败 → isError', async () => {
  const res = await runResearch({
    task: 't',
    config: cfg(),
    searchFn: async () => ({ results: [] }),
    chatFn: async () => R('not json'),
  });
  assert.match(res.error, /广度规划失败/);
});

test('runResearch: 综合失败 → isError 且提示可自行综合', async () => {
  const res = await runResearch({
    task: 't',
    config: cfg(),
    searchFn: async () => ({ results: [{ title: 't', url: 'u', content: 'c' }] }),
    chatFn: async (opts) => {
      const sys = opts.messages.find((m) => m.role === 'system').content;
      if (/research planner/i.test(sys)) return R('{"intent_summary":"i","breadth":[{"question":"b1"}]}');
      if (/depth planner/i.test(sys)) return R('{"intent_summary":"i","depth":[]}');
      throw new Error('synthesis boom');
    },
  });
  assert.match(res.error, /综合失败/);
  assert.match(res.error, /已收集 1 条证据/);
});

test('runResearch: 综合 finish_reason=length → annotation 标注截断 + usage 用量', async () => {
  const res = await runResearch({
    task: 't',
    config: cfg(),
    searchFn: async () => ({ results: [{ title: 't', url: 'u', content: 'c' }] }),
    chatFn: async (opts) => {
      const sys = opts.messages.find((m) => m.role === 'system').content;
      if (/research planner/i.test(sys)) return R('{"intent_summary":"i","breadth":[{"question":"b1"}]}');
      if (/depth planner/i.test(sys)) return R('{"intent_summary":"i","depth":[]}');
      // 模拟「completion ≪ 12288 但仍 length」→ 总窗余量（而非纯输出写满）
      return R('# 半截报告', 'length', { promptTokens: 11000, completionTokens: 3000, totalTokens: 14000 });
    },
  });
  assert.ok(!res.error);
  assert.match(res.report, /# 半截报告/);
  assert.match(res.annotation, /finish_reason=length/);
  assert.match(res.annotation, /prompt=11000 completion=3000 total=14000/);
});

// ---- maxDepth 钳制 ----
test('buildDepthPlan: breadthUsed 超 maxSearches → maxDepth 钳 0（不 slice(-1)）', async () => {
  const plan = await buildDepthPlan({
    task: 't', config: cfg(), intentSummary: 'i', breadthUsed: 15, briefs: [],
    chatFn: async () => R('{"intent_summary":"i","depth":[{"question":"d"}]}'),
  });
  assert.equal(plan.depth.length, 0);
});

// ---- synthesizeReport ----
test('synthesizeReport: evidence 渲染含 raw 截断；failed 脱敏；输出剥 fence', async () => {
  let seenUser = '';
  const result = await synthesizeReport({
    task: 't',
    config: cfg(),
    intentSummary: 'i',
    evidence: [
      { question: 'q', phase: 'depth', title: 'T', url: 'U', content: 'C', rawContent: 'X'.repeat(3000) },
    ],
    failed: [{ question: 'q2', error: 'auth: tvly-secretkey12345678' }],
    chatFn: async (opts) => {
      seenUser = opts.messages.find((m) => m.role === 'user').content;
      return R('```markdown\n# 报告\n```');
    },
  });
  assert.equal(result.report, '# 报告'); // 剥外层 fence
  assert.equal(result.truncated, false);
  assert.equal(result.usage, null); // chatFn 未返回 usage
  assert.ok(seenUser.includes('…'), 'raw 超长截断加省略号');
  assert.ok(!seenUser.includes('tvly-secretkey12345678'), 'failed.error 已脱敏');
  assert.ok(seenUser.includes('[redacted]'));
});

test('synthesizeReport: usage 透传（截断诊断用）', async () => {
  const result = await synthesizeReport({
    task: 't',
    config: cfg(),
    intentSummary: 'i',
    evidence: [{ question: 'q', phase: 'breadth', title: 'T', url: 'U', content: 'C', rawContent: '' }],
    failed: [],
    chatFn: async () => R('# 报告', 'length', { promptTokens: 9000, completionTokens: 2000, totalTokens: 11000 }),
  });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.usage, { promptTokens: 9000, completionTokens: 2000, totalTokens: 11000 });
});

test('synthesizeReport: prompt 含篇幅纪律（逼完稿，不再用输出帽误导）', async () => {
  let seenSystem = '';
  await synthesizeReport({
    task: 't',
    config: cfg(),
    intentSummary: 'i',
    evidence: [{ question: 'q', phase: 'breadth', title: 'T', url: 'U', content: 'C', rawContent: '' }],
    failed: [],
    chatFn: async (opts) => {
      const sys = opts.messages.find((m) => m.role === 'system');
      seenSystem = sys ? sys.content : '';
      return R('# 报告');
    },
  });
  assert.match(seenSystem, /Length discipline/);
  assert.match(seenSystem, /Completeness over density/);
  assert.match(seenSystem, /never drop the tail/);
  assert.match(seenSystem, /Output the report in English/, 'MCP→agent 接口用英文，呈现由 agent 自理');
  assert.ok(!seenSystem.includes('within ~12288'), '不再用输出帽数字误导模型');
});

// ---- buildResearchAnnotation ----
test('buildResearchAnnotation: 无失败不带部分失败行', () => {
  const ann = buildResearchAnnotation({ breadth: 3, depth: 2, searches: 5, llmCalls: 3, searchRounds: 3 }, []);
  assert.match(ann, /搜索次数: 5/);
  assert.match(ann, /模型调用: 3 次/);
  assert.ok(!ann.includes('部分失败'));
});

test('buildResearchAnnotation: 部分失败带脱敏 error', () => {
  const ann = buildResearchAnnotation(
    { breadth: 3, depth: 0, searches: 3, llmCalls: 2, searchRounds: 1 },
    [{ question: '（深度规划）', error: 'depth failed: key tvly-secretkey12345678' }],
  );
  assert.match(ann, /部分失败\(1\): （深度规划）:/);
  assert.match(ann, /depth failed/);
  assert.ok(!ann.includes('tvly-secretkey12345678'), 'annotation 中 error 已脱敏');
});
