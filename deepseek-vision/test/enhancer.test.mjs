// enhancer 单元测试（零网络）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { enhancePrompt, enhanceComparePrompt } from '../build/tools.js';

const ERROR_TEMPLATE = /Analyze this error screenshot/;

function assertErrorEnhancement(task) {
  const out = enhancePrompt(task);
  assert.match(out, ERROR_TEMPLATE);
  assert.match(out, /User task:/);
  assert.match(out, new RegExp(task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(out, /Analyze this UI screenshot/);
}

test('enhancePrompt: OCR 关键词套模板且保留原 task', () => {
  const task = '提取截图里的文字';
  const out = enhancePrompt(task);
  assert.match(out, /Extract all text from this image/);
  assert.match(out, /<<<OCR_TEXT>>>/);
  assert.match(out, /<<<END_OCR_TEXT>>>/);
  assert.match(out, /User task:/);
  assert.match(out, new RegExp(task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('enhancePrompt: 无关键词则 prompt≈task', () => {
  const task = 'What is the dominant color in this photo?';
  const out = enhancePrompt(task);
  assert.equal(out, task);
});

test('enhancePrompt: error 关键词套 diagnose_error 模板', () => {
  assertErrorEnhancement('看这个截图哪里报错');
});

test('enhancePrompt: 界面+报错 → error 模板（非 UI）', () => {
  assertErrorEnhancement('分析这个界面报错');
  assertErrorEnhancement('看这个截图界面哪里错了');
  assertErrorEnhancement('这个 UI 报错了');
});

test('enhanceComparePrompt: 对比关键词套 compare 模板', () => {
  const task = '比较两个界面变化';
  const out = enhanceComparePrompt(task);
  assert.match(out, /Compare image A/);
  assert.match(out, /比较两个界面变化/);
});

test('enhanceComparePrompt: 无对比关键词则原样 task', () => {
  const task = 'Are these the same brand logo?';
  const out = enhanceComparePrompt(task);
  assert.equal(out, task);
});
