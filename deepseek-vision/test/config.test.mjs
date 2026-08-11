// 零成本单元测试：config 解析器（不发起任何网络请求）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMaxTokens,
  parseMaxImageBytes,
  retryMaxTokens,
  parseReasoningEffortCapability,
  parseOutputFormat,
  parseOutputQuality,
  validateVisionConfig,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_OUTPUT_QUALITY,
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

test('parseOutputFormat / parseOutputQuality: 默认与合法值', () => {
  assert.equal(parseOutputFormat(undefined), DEFAULT_OUTPUT_FORMAT);
  assert.equal(parseOutputFormat('JPEG'), 'jpeg');
  assert.equal(parseOutputFormat('webp'), 'webp');
  assert.equal(parseOutputFormat('bogus'), DEFAULT_OUTPUT_FORMAT);
  assert.equal(parseOutputQuality(undefined), DEFAULT_OUTPUT_QUALITY);
  assert.equal(parseOutputQuality('1'), 1);
  assert.equal(parseOutputQuality('90'), 90);
  assert.equal(parseOutputQuality('100'), 100);
  assert.equal(parseOutputQuality('85'), 85);
  assert.equal(parseOutputQuality('0'), DEFAULT_OUTPUT_QUALITY);
  assert.equal(parseOutputQuality('101'), DEFAULT_OUTPUT_QUALITY);
  assert.equal(parseOutputQuality('90x'), DEFAULT_OUTPUT_QUALITY);
  assert.equal(parseOutputQuality('90.5'), DEFAULT_OUTPUT_QUALITY);
  assert.equal(parseOutputQuality('   '), DEFAULT_OUTPUT_QUALITY);
});

test('validateVisionConfig: VISION_OUTPUT_QUALITY 严格拒绝非法值', () => {
  const keys = ['VISION_OUTPUT_QUALITY', 'OPENCODE_API_KEY', 'VISION_API_KEY', 'VISION_FALLBACK_API_KEY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];

    for (const bad of ['90x', '90.5', '   ', '0', '101', '']) {
      process.env.VISION_OUTPUT_QUALITY = bad;
      assert.ok(
        validateVisionConfig().some((e) => e.includes('VISION_OUTPUT_QUALITY')),
        `应拒绝 VISION_OUTPUT_QUALITY=${JSON.stringify(bad)}`
      );
    }

    for (const ok of ['1', '90', '100']) {
      process.env.VISION_OUTPUT_QUALITY = ok;
      assert.equal(
        validateVisionConfig().filter((e) => e.includes('VISION_OUTPUT_QUALITY')).length,
        0,
        `应接受 VISION_OUTPUT_QUALITY=${ok}`
      );
    }

    delete process.env.VISION_OUTPUT_QUALITY;
    assert.deepEqual(validateVisionConfig(), []);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('validateVisionConfig: 无效 URL / capability 报错；全空 key 不报错', () => {
  const keys = [
    'OPENCODE_API_KEY',
    'VISION_API_KEY',
    'VISION_FALLBACK_API_KEY',
    'VISION_BASE_URL',
    'VISION_REASONING_EFFORT_CAPABILITY',
    'VISION_OUTPUT_FORMAT',
    'VISION_OUTPUT_QUALITY',
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

    process.env.VISION_REASONING_EFFORT_CAPABILITY = 'auto';
    process.env.VISION_OUTPUT_FORMAT = 'tiff';
    assert.ok(validateVisionConfig().some((e) => e.includes('VISION_OUTPUT_FORMAT')));

    process.env.VISION_OUTPUT_FORMAT = 'auto';
    process.env.VISION_OUTPUT_QUALITY = '999';
    assert.ok(validateVisionConfig().some((e) => e.includes('VISION_OUTPUT_QUALITY')));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
