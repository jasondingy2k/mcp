// 零成本单元测试：.env 加载器 / 错误前缀 / 日志工厂。
// 运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile, parseEnvValue } from '../build/env.js';
import { makeToolError } from '../build/errors.js';
import { makeLogger } from '../build/logging.js';

test('parseEnvValue: 引号内 # 保留；引号外注释剥离', () => {
  assert.equal(parseEnvValue('"a # b"'), 'a # b');
  assert.equal(parseEnvValue("'a # b'"), 'a # b');
  assert.equal(parseEnvValue('"a # b" # trailing'), 'a # b');
  assert.equal(parseEnvValue('plain # comment'), 'plain');
  assert.equal(parseEnvValue('1'), '1');
});

test('loadEnvFile: export 前缀 / # 注释 / NUL 跳过 / 已有 env 优先', () => {
  const dir = join(process.cwd(), 'test', 'env-fixture');
  mkdirSync(dir, { recursive: true });
  const env = join(dir, '.env');
  writeFileSync(
    env,
    'export A=1 # comment\nB=two words\nC=bad\u0000value\nD=keep\nE="a # b"\nF="x # y" # tail\n'
  );
  try {
    delete process.env.A;
    delete process.env.B;
    delete process.env.C;
    delete process.env.D;
    delete process.env.E;
    delete process.env.F;
    process.env.D = 'existing';
    loadEnvFile(env);
    assert.equal(process.env.A, '1');
    assert.equal(process.env.B, 'two words');
    assert.equal(process.env.C, undefined);
    assert.equal(process.env.D, 'existing');
    assert.equal(process.env.E, 'a # b');
    assert.equal(process.env.F, 'x # y');
  } finally {
    delete process.env.A;
    delete process.env.B;
    delete process.env.C;
    delete process.env.D;
    delete process.env.E;
    delete process.env.F;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('makeToolError: 前缀格式', () => {
  const err = makeToolError('test-server');
  assert.equal(err('TypeX', 'msg'), '[test-server 内部错误] TypeX: msg');
});

test('makeLogger: 未设置 env 时静默（函数可调用）', () => {
  delete process.env.TEST_LOG_LEVEL;
  const log = makeLogger('test-server', 'TEST_LOG_LEVEL');
  assert.equal(typeof log, 'function');
  log('warn', 'should be silent');
});
