// 零成本单元测试：formatResults 输出修复 + token 优化（不截断 / 无 ID / 无 Favicon）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatResults, formatCrawlResults, formatMapResults } from '../build/index.js';

test('formatResults: search 风格（content + raw_content 都显示）', () => {
  const out = formatResults({
    query: 'q',
    results: [
      { title: 'T', url: 'U', content: 'snippet', raw_content: 'full text', score: 1, id: 'x', favicon: 'https://f' },
    ],
  });
  assert.ok(out.includes('Content: snippet'));
  assert.ok(out.includes('Raw Content: full text'));
  assert.ok(!out.includes('ID:'), '不应输出 ID 行');
  assert.ok(!out.includes('Favicon:'), '不应输出 Favicon 行');
});

test('formatResults: extract 风格（content 缺省 → 用 raw_content，且不重复显示）', () => {
  const longBody = '# Page\n' + 'body text '.repeat(50); // > 300 chars
  assert.ok(longBody.length > 300);
  const out = formatResults({
    query: 'q',
    results: [
      { title: 'T', url: 'U', content: undefined, raw_content: longBody, score: 1, id: 'x' },
    ],
  });
  assert.ok(out.includes(`Content: ${longBody}`), 'extract 全长仍在，不被截成 300');
  assert.ok(!out.includes('Raw Content:'), '不应出现重复的 Raw Content 行');
  assert.ok(!out.includes('truncated'), '无 truncated hint');
  assert.ok(!out.includes('ID:'), '不应输出 ID 行');
});

test('formatResults: 两者皆无 → Content 为空串而非 undefined', () => {
  const out = formatResults({
    query: 'q',
    results: [{ title: 'T', url: 'U', score: 1, id: 'x' }],
  });
  assert.ok(out.includes('Content:'));
  assert.ok(!out.includes('undefined'), '不应出现 undefined');
});

test('formatResults: 长 content 不被截成 300，无 truncated hint', () => {
  const long = 'word '.repeat(100); // > 300 chars
  assert.ok(long.length > 300);
  const out = formatResults({
    query: 'q',
    results: [
      { title: 'T', url: 'U', content: long, score: 1, id: 'id1', favicon: 'https://f' },
    ],
  });
  assert.ok(out.includes(`Content: ${long}`), '长 content 完整输出');
  assert.ok(!out.includes('…'), '不应有截断省略号');
  assert.ok(!out.includes('truncated'), '无 truncated hint');
  assert.ok(!out.includes('[Content truncated'), '无 truncated hint 行');
  assert.ok(!out.includes('ID:'), '不应输出 ID 行');
  assert.ok(!out.includes('Favicon:'), '不应输出 Favicon 行');
});

test('formatResults: 缺 results / 空 results 不抛 TypeError', () => {
  const noResults = formatResults({ query: 'q', answer: 'only answer' });
  assert.ok(noResults.includes('Answer: only answer'));
  assert.ok(noResults.includes('Detailed Results:'));
  assert.ok(!noResults.includes('undefined'));

  const empty = formatResults({ query: 'q', results: [] });
  assert.ok(empty.includes('Detailed Results:'));
});

test('formatResults: results 含 null / 非数组对象不抛', () => {
  const mixed = formatResults({
    query: 'q',
    results: [
      { title: 'ok', url: 'u', content: 'c', score: 1, id: '1' },
      null,
      'bad',
    ],
  });
  assert.ok(mixed.includes('Title: ok'));
  assert.ok(!mixed.includes('undefined'));

  const notArray = formatResults({ query: 'q', results: { oops: true } });
  assert.ok(notArray.includes('Detailed Results:'));
});

test('formatCrawlResults: 缺 results / 空 results 不抛 TypeError', () => {
  const noResults = formatCrawlResults({ base_url: 'https://ex.ample', response_time: 0.1 });
  assert.ok(noResults.includes('Crawl Results:'));
  assert.ok(noResults.includes('Base URL: https://ex.ample'));
  assert.ok(noResults.includes('Crawled Pages:'));
  assert.ok(!noResults.includes('undefined'));

  const empty = formatCrawlResults({ base_url: 'https://ex.ample', results: [], response_time: 0.1 });
  assert.ok(empty.includes('Crawled Pages:'));
});

test('formatCrawlResults: 缺 url 不输出 undefined', () => {
  const out = formatCrawlResults({
    base_url: 'https://ex.ample',
    results: [{ url: undefined, raw_content: 'hi' }],
    response_time: 0.1,
  });
  assert.ok(out.includes('[1] URL:'));
  assert.ok(!out.includes('undefined'));
});

test('formatMapResults: 缺 results / 空 results 不抛 TypeError', () => {
  const noResults = formatMapResults({ base_url: 'https://ex.ample', response_time: 0.1 });
  assert.ok(noResults.includes('Site Map Results:'));
  assert.ok(noResults.includes('Mapped Pages:'));
  assert.ok(!noResults.includes('undefined'));

  const empty = formatMapResults({ base_url: 'https://ex.ample', results: [], response_time: 0.1 });
  assert.ok(empty.includes('Mapped Pages:'));
});
