// research 主代理 config 单测（零成本：纯函数，不发起任何网络请求）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readResearchConfig,
  parseResearchInt,
  RESEARCH_TOTAL_TIMEOUT_MS,
  RESEARCH_PLAN_TIMEOUT_MS,
  RESEARCH_PLAN_MAX_ATTEMPTS,
  RESEARCH_SYNTHESIS_TIMEOUT_MS,
} from '../build/index.js';

// ---- parseResearchInt ----
test('parseResearchInt: 空/非法/负数 → fallback', () => {
  assert.equal(parseResearchInt(undefined, 5), 5);
  assert.equal(parseResearchInt('', 5), 5);
  assert.equal(parseResearchInt('abc', 5), 5);
  assert.equal(parseResearchInt('-3', 5), 5);
  assert.equal(parseResearchInt('0', 5), 5);
  assert.equal(parseResearchInt('7', 5), 7);
  assert.equal(parseResearchInt('  8  ', 5), 8);
});

// ---- readResearchConfig 默认值 ----
test('readResearchConfig: 空 env → 全部默认值', () => {
  const c = readResearchConfig({});
  assert.equal(c.model, 'deepseek-v4-flash');
  assert.equal(c.baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(c.minSearches, 5);
  assert.equal(c.maxSearches, 10);
  assert.equal(c.minBreadth, 3);
  assert.equal(c.minDepth, 2);
  assert.equal(c.totalTimeoutMs, 480000);
  assert.equal(c.apiKey, undefined);
});

// ---- apiKey：仅 RESEARCH_API_KEY（与 vision 的 OPENCODE_* 独立）----
test('readResearchConfig: 仅认 RESEARCH_API_KEY；OPENCODE_API_KEY 不生效', () => {
  assert.equal(readResearchConfig({}).apiKey, undefined);
  assert.equal(readResearchConfig({ OPENCODE_API_KEY: 'opencode' }).apiKey, undefined);
  assert.equal(readResearchConfig({ RESEARCH_API_KEY: 'research' }).apiKey, 'research');
  assert.equal(
    readResearchConfig({ RESEARCH_API_KEY: 'research', OPENCODE_API_KEY: 'opencode' }).apiKey,
    'research'
  );
});

// ---- baseUrl：RESEARCH_BASE_URL → 默认；去尾斜杠 ----
test('readResearchConfig: baseUrl 仅 RESEARCH_BASE_URL → 默认；去尾斜杠', () => {
  assert.equal(readResearchConfig({}).baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(readResearchConfig({ VISION_BASE_URL: 'https://x.example/v1/' }).baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(readResearchConfig({ RESEARCH_BASE_URL: 'https://r.example' }).baseUrl, 'https://r.example');
  assert.equal(
    readResearchConfig({ RESEARCH_BASE_URL: 'https://r.example/', VISION_BASE_URL: 'https://v.example' }).baseUrl,
    'https://r.example'
  );
});

// ---- 一致性钳制 ----
test('readResearchConfig: min > max → min 钳到 max', () => {
  const c = readResearchConfig({ RESEARCH_MIN_SEARCHES: '12', RESEARCH_MAX_SEARCHES: '6' });
  assert.equal(c.minSearches, 6);
  assert.equal(c.maxSearches, 6);
});

test('readResearchConfig: minBreadth+minDepth > max → 收紧 minDepth', () => {
  const c = readResearchConfig({ RESEARCH_MAX_SEARCHES: '5', RESEARCH_MIN_BREADTH: '4', RESEARCH_MIN_DEPTH: '3' });
  assert.ok(c.minBreadth + c.minDepth <= c.maxSearches, 'minBreadth+minDepth 不得超 max');
  assert.equal(c.minBreadth, 4);
  assert.equal(c.minDepth, 1);
});

test('readResearchConfig: minBreadth 单独超 max → breadth 也收紧', () => {
  const c = readResearchConfig({ RESEARCH_MAX_SEARCHES: '5', RESEARCH_MIN_BREADTH: '6', RESEARCH_MIN_DEPTH: '3' });
  assert.ok(c.minBreadth + c.minDepth <= c.maxSearches, 'minBreadth+minDepth 不得超 max');
  assert.equal(c.minBreadth, 4); // 5 - 1
  assert.equal(c.minDepth, 1);
});

// ---- 自定义值生效 ----
test('readResearchConfig: 自定义 model / 次数生效', () => {
  const c = readResearchConfig({
    RESEARCH_MODEL: 'custom-model',
    RESEARCH_MIN_SEARCHES: '4',
    RESEARCH_MAX_SEARCHES: '9',
  });
  assert.equal(c.model, 'custom-model');
  assert.equal(c.minSearches, 4);
  assert.equal(c.maxSearches, 9);
});

// ---- 护栏常量 ----
test('research 护栏常量：480s 总墙钟 / 60s 规划 / 重试1次 / 120s 综合', () => {
  assert.equal(RESEARCH_TOTAL_TIMEOUT_MS, 480000);
  assert.equal(RESEARCH_PLAN_TIMEOUT_MS, 60000);
  assert.equal(RESEARCH_PLAN_MAX_ATTEMPTS, 2);
  assert.equal(RESEARCH_SYNTHESIS_TIMEOUT_MS, 120000);
});
