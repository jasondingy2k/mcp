// 零成本单元测试：config 解析器（不发起任何网络请求）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMaxTokens,
  parseMaxImageBytes,
  retryMaxTokens,
  parseReasoningEffortCapability,
  validateVisionConfig,
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

test('parseReasoningEffortCapability: auto/supported/unsupported', () => {
  assert.equal(parseReasoningEffortCapability(undefined), 'auto');
  assert.equal(parseReasoningEffortCapability('supported'), 'supported');
  assert.equal(parseReasoningEffortCapability('UNSUPPORTED'), 'unsupported');
  assert.equal(parseReasoningEffortCapability('bogus', 'supported'), 'supported');
});

test('validateVisionConfig: 无效 URL / capability 报错；全空 key 不报错', () => {
  const keys = [
    'OPENCODE_API_KEY',
    'VISION_API_KEY',
    'VISION_FALLBACK_API_KEY',
    'VISION_BASE_URL',
    'VISION_REASONING_EFFORT_CAPABILITY',
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.deepEqual(validateVisionConfig(), []);

    process.env.OPENCODE_API_KEY = 'k1';
    process.env.VISION_BASE_URL = 'not-a-url';
    assert.ok(validateVisionConfig().some((e) => e.includes('VISION_BASE_URL')));

    process.env.VISION_BASE_URL = 'https://api.example.com/v1';
    process.env.VISION_REASONING_EFFORT_CAPABILITY = 'bogus';
    assert.ok(validateVisionConfig().some((e) => e.includes('REASONING_EFFORT_CAPABILITY')));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
