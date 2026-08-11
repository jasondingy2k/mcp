// keypool 纯逻辑单测：parseApiKeys / RoundRobin / classifyFailure / redactKeys
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseApiKeys,
  RoundRobin,
  classifyFailure,
  httpStatusFromError,
  isNetworkOrBlockError,
  shouldRetryNextKey,
  isUnsupportedReasoningEffortError,
  redactKeys,
} from '../build/keypool.js';

test('parseApiKeys: 空/逗号/trim/去重', () => {
  assert.deepEqual(parseApiKeys(undefined), []);
  assert.deepEqual(parseApiKeys(''), []);
  assert.deepEqual(parseApiKeys(','), []);
  assert.deepEqual(parseApiKeys(' a , b , a '), ['a', 'b']);
});

test('RoundRobin: 等权轮询与 orderFrom 不推进下标', () => {
  const rr = new RoundRobin(['k1', 'k2', 'k3']);
  assert.equal(rr.size, 3);
  assert.equal(rr.next(), 'k1');
  assert.equal(rr.next(), 'k2');
  assert.deepEqual(rr.orderFrom('k2'), ['k2', 'k3', 'k1']);
  assert.equal(rr.next(), 'k3');
  assert.equal(rr.next(), 'k1');
});

test('RoundRobin: 空池 next 抛错', () => {
  const rr = new RoundRobin([]);
  assert.throws(() => rr.next(), /keypool empty/);
});

test('classifyFailure: 鉴权/429 → key；网络 → provider', () => {
  assert.equal(classifyFailure({ status: 401, message: 'unauthorized' }), 'key');
  assert.equal(classifyFailure({ status: 429, message: 'rate limit' }), 'key');
  assert.equal(classifyFailure({ status: 402, message: 'payment required' }), 'key');
  assert.equal(classifyFailure({ name: 'TimeoutError', message: 'timed out' }), 'provider');
  assert.equal(isNetworkOrBlockError({ code: 'ECONNREFUSED' }), true);
  assert.equal(shouldRetryNextKey({ status: 403 }), true);
});

test('classifyFailure: 400 无 reasoning → request；500 → provider', () => {
  assert.equal(classifyFailure({ status: 400, message: 'bad request' }), 'request');
  assert.equal(classifyFailure({ status: 500, message: 'server error' }), 'provider');
  assert.equal(shouldRetryNextKey({ status: 400, message: 'bad request' }), false);
});

test('classifyFailure: 404 / unknown model → provider', () => {
  assert.equal(classifyFailure({ status: 404, message: 'model not found' }), 'provider');
  assert.equal(classifyFailure({ status: 400, message: 'unknown model foo' }), 'provider');
  assert.equal(shouldRetryNextKey({ status: 404 }), false);
});

test('httpStatusFromError: status / statusCode / 嵌套 error.status', () => {
  assert.equal(httpStatusFromError({ status: 401 }), 401);
  assert.equal(httpStatusFromError({ statusCode: 429 }), 429);
  assert.equal(httpStatusFromError({ error: { status: 404 } }), 404);
  assert.equal(httpStatusFromError({ message: 'no status' }), 0);
});

test('isUnsupportedReasoningEffortError: 400 + reasoning_effort 字段', () => {
  assert.equal(
    isUnsupportedReasoningEffortError({
      status: 400,
      message: 'unknown field reasoning_effort',
    }),
    true
  );
  assert.equal(isUnsupportedReasoningEffortError({ status: 400, message: 'bad json' }), false);
});

test('redactKeys: 长 key 脱敏', () => {
  const key = 'sk-abcdefghijklmnop';
  const out = redactKeys(`failed with ${key}`, [key]);
  assert.ok(!out.includes(key));
  assert.match(out, /sk-a…mnop/);
});
