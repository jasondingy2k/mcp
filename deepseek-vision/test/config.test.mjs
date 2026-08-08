// 零成本单元测试：config 解析器（不发起任何网络请求）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMaxTokens,
  parseMaxImageBytes,
  retryMaxTokens,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_IMAGE_BYTES,
  RETRY_MAX_TOKENS_CAP,
} from '../build/config.js';

test('parseMaxTokens: 默认/下限/非法回退', () => {
  assert.equal(parseMaxTokens(undefined), DEFAULT_MAX_TOKENS);
  assert.equal(parseMaxTokens('100'), 512); // 下限 512
  assert.equal(parseMaxTokens('8192'), 8192);
  assert.equal(parseMaxTokens('abc'), DEFAULT_MAX_TOKENS);
});

test('parseMaxImageBytes: 默认/合法/非法/负数回退', () => {
  assert.equal(parseMaxImageBytes(undefined), DEFAULT_MAX_IMAGE_BYTES);
  assert.equal(parseMaxImageBytes('1048576'), 1048576);
  assert.equal(parseMaxImageBytes('abc'), DEFAULT_MAX_IMAGE_BYTES);
  assert.equal(parseMaxImageBytes('-5'), DEFAULT_MAX_IMAGE_BYTES);
});

test('retryMaxTokens: base<cap 钳到 cap；base≥cap 只翻倍不向下钳', () => {
  assert.equal(retryMaxTokens(4096), 8192);
  assert.equal(retryMaxTokens(5000), RETRY_MAX_TOKENS_CAP);
  assert.equal(retryMaxTokens(8192), 16384);
  assert.equal(retryMaxTokens(10000), 20000);
});
