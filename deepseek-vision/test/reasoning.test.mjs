// 零成本单元测试：reasoning_content 提取（不发起任何网络请求）。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReasoning } from '../build/reasoning.js';

test('字符串 reasoning 去空白', () => {
  assert.equal(extractReasoning({ reasoning_content: '  think step by step  ' }), 'think step by step');
});

test('空/空白/null → null', () => {
  assert.equal(extractReasoning({ reasoning_content: '   ' }), null);
  assert.equal(extractReasoning({ reasoning_content: null }), null);
  assert.equal(extractReasoning({}), null);
});

test('数组形式（{type,text} 对象）拼接', () => {
  assert.equal(
    extractReasoning({ reasoning_content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    'ab'
  );
});

test('数组含非对象元素', () => {
  assert.equal(extractReasoning({ reasoning_content: ['x', 1] }), 'x1');
});

test('数组含 null 不产出字符串 null', () => {
  assert.equal(extractReasoning({ reasoning_content: ['a', null, 'b'] }), 'ab');
});

test('非字符串标量转字符串', () => {
  assert.equal(extractReasoning({ reasoning_content: 123 }), '123');
});
