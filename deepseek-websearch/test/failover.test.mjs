// 零成本单元测试：纯函数逻辑（不发起任何网络请求）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyNonSuccess,
  shouldFallbackToExa,
  validateSearchPayload,
  buildExaPayload,
  mapExaResultsToTavily,
  toolError,
  redactSensitive,
  SearchProviderFailure,
} from '../build/index.js';

// ---- classifyNonSuccess ----
test('classifyNonSuccess: 5xx → error', () => {
  assert.equal(classifyNonSuccess(500, 'boom'), 'error');
  assert.equal(classifyNonSuccess(503, 'unavailable'), 'error');
});

test('classifyNonSuccess: 401/403 → auth（不回退）', () => {
  assert.equal(classifyNonSuccess(401, 'unauthorized'), 'auth');
  assert.equal(classifyNonSuccess(403, 'forbidden'), 'auth');
});

test('classifyNonSuccess: 402 → quota', () => {
  assert.equal(classifyNonSuccess(402, 'payment required'), 'quota');
});

test('classifyNonSuccess: 429 quota 关键词 vs 纯限流', () => {
  assert.equal(classifyNonSuccess(429, 'insufficient credits'), 'quota');
  assert.equal(classifyNonSuccess(429, 'too many requests'), 'rate');
});

test('classifyNonSuccess: 4xx 关键词扫描', () => {
  assert.equal(classifyNonSuccess(400, 'usage limit exceeded'), 'quota');
  assert.equal(classifyNonSuccess(400, 'rate limit exceeded'), 'rate');
  assert.equal(classifyNonSuccess(400, 'bad request'), 'error');
});

test('shouldFallbackToExa: 仅 error 可切；auth/quota/rate 不切', () => {
  assert.equal(shouldFallbackToExa('error'), true);
  assert.equal(shouldFallbackToExa('auth'), false);
  assert.equal(shouldFallbackToExa('quota'), false);
  assert.equal(shouldFallbackToExa('rate'), false);
});

test('redactSensitive: JSON api_key / Bearer / sk- / tvly-；原 token 必须消失', () => {
  const json = '{"api_key":"tvly-secretkey12345678"}';
  const jsonOut = redactSensitive(json);
  assert.match(jsonOut, /\[redacted\]/);
  assert.ok(!jsonOut.includes('tvly-secretkey12345678'), 'JSON 内 tvly key 不得存活');

  const bearerTvly = 'Authorization: Bearer tvly-abcdef1234567890xyz';
  const bearerTvlyOut = redactSensitive(bearerTvly);
  assert.match(bearerTvlyOut, /Authorization:\s*Bearer\s+\[redacted\]/i);
  assert.ok(!bearerTvlyOut.includes('tvly-abcdef1234567890xyz'), 'Bearer tvly- 真值不得存活');

  const bearerSk = 'Authorization: Bearer sk-abcdefghijklmnop';
  const bearerSkOut = redactSensitive(bearerSk);
  assert.ok(!bearerSkOut.includes('sk-abcdefghijklmnop'), 'Bearer sk- 真值不得存活');

  const bareTvly = 'your key tvly-abcdef1234567890xyz is invalid';
  const bareOut = redactSensitive(bareTvly);
  assert.match(bareOut, /\[redacted\]/);
  assert.ok(!bareOut.includes('tvly-abcdef1234567890xyz'), '裸 tvly- 串不得存活');

  const form = 'api_key=tvly-formvalue12345678&q=1';
  const formOut = redactSensitive(form);
  assert.ok(!formOut.includes('tvly-formvalue12345678'), '表单 api_key=tvly- 不得存活');
});
// ---- validateSearchPayload ----
test('validateSearchPayload: 非对象 body → error', () => {
  assert.throws(() => validateSearchPayload('nope', 'Tavily'), SearchProviderFailure);
  assert.throws(() => validateSearchPayload(null, 'Tavily'), SearchProviderFailure);
});

test('validateSearchPayload: results 非数组 → error', () => {
  assert.throws(() => validateSearchPayload({ results: 'nope' }, 'Tavily'), SearchProviderFailure);
});

test('validateSearchPayload: 全部条目非法 → error（触发回退）', () => {
  assert.throws(() => validateSearchPayload({ results: [1, 2] }, 'Tavily'), SearchProviderFailure);
});

test('validateSearchPayload: 缺 results 容忍；合法列表通过；空 2xx 通过', () => {
  assert.doesNotThrow(() => validateSearchPayload({ query: 'q' }, 'Tavily'));
  assert.doesNotThrow(() => validateSearchPayload({ results: [] }, 'Tavily'));
  assert.doesNotThrow(() => validateSearchPayload(
    { results: [{ title: 'a', url: 'u', content: 'c' }] }, 'Tavily'));
});

// ---- buildExaPayload ----
test('buildExaPayload: 映射兼容参数', () => {
  const p = buildExaPayload({
    query: 'q', max_results: 10,
    include_domains: ['a.com'], exclude_domains: ['b.com'],
    start_date: '2026-01-01', end_date: '2026-02-01',
  });
  assert.equal(p.query, 'q');
  assert.equal(p.numResults, 10);
  assert.deepEqual(p.includeDomains, ['a.com']);
  assert.deepEqual(p.excludeDomains, ['b.com']);
  assert.equal(p.startPublishedDate, '2026-01-01');
  assert.equal(p.endPublishedDate, '2026-02-01');
});

test('buildExaPayload: 缺省值', () => {
  const p = buildExaPayload({ query: 'q' });
  assert.equal(p.numResults, 5);
  assert.equal(p.includeDomains, undefined);
  assert.equal(p.contents.text.maxCharacters, 1200);
});

// ---- mapExaResultsToTavily ----
test('mapExaResultsToTavily: text/highlights/score/id 映射', () => {
  const r = mapExaResultsToTavily({
    query: 'q',
    results: [
      { title: 'T', url: 'U', text: 'body', score: 0.9, id: 'x1' },
      { title: 'T2', url: 'U2', highlights: ['h1', 'h2'] },
    ],
  });
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].content, 'body');
  assert.equal(r.results[1].content, 'h1 [...] h2');
  assert.equal(r.results[0].score, 0.9);
  assert.equal(r.results[0].id, 'x1');
});

// ---- toolError ----
test('toolError: 前缀格式', () => {
  assert.equal(
    toolError('TavilyAPIError', 'x'),
    '[deepseek-websearch 内部错误] TavilyAPIError: x'
  );
});
