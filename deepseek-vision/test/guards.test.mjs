// 护栏单元测试：总预算 / sharp 并发 / 安全读盘 / workspace temp
// 运行：npm run build && node --test test/guards.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PipelineBudget } from '../build/pipeline-budget.js';
import {
  withSharpConcurrency,
  resetSharpSemaphoreForTests,
} from '../build/semaphore.js';
import {
  workspaceTmpDir,
  ensureWorkspaceTmpDir,
  allocTempPath,
  writePrivateTempFile,
  removeTempFile,
  TempManagerError,
} from '../build/temp-manager.js';
import { readImageFile, ImageValidationError } from '../build/image.js';
import { sharpConcurrency } from '../build/config.js';
import { readFileSync } from 'node:fs';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

test('PipelineBudget: stageTimeout 受总预算约束', () => {
  const start = Date.now();
  const budget = new PipelineBudget(10_000, start);
  const t = budget.stageTimeout('测试', 5_000, 0);
  assert.ok(t <= 10_000);
  assert.ok(t >= 1);
});

test('PipelineBudget: 耗尽后 assertRemaining 抛错并标注阶段', () => {
  const budget = new PipelineBudget(1, Date.now() - 5);
  assert.throws(
    () => budget.assertRemaining('图片解码'),
    (e) => e instanceof Error && /视觉任务总超时/.test(e.message) && /图片解码/.test(e.message)
  );
});

test('sharpConcurrency: 默认 2 路', () => {
  assert.equal(sharpConcurrency(), 2);
});

test('withSharpConcurrency: 并发槽位排队', async () => {
  resetSharpSemaphoreForTests();
  process.env.VISION_SHARP_CONCURRENCY = '1';
  resetSharpSemaphoreForTests();
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    await withSharpConcurrency(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
    });
  };
  await Promise.all([task(), task(), task()]);
  assert.equal(maxActive, 1, '并发上限 1 时应串行');
  delete process.env.VISION_SHARP_CONCURRENCY;
  resetSharpSemaphoreForTests();
});

test('workspace temp: 目录在 deepseek-vision/tmp 且可分配路径', () => {
  const dir = ensureWorkspaceTmpDir();
  assert.equal(dir, workspaceTmpDir());
  const mode = statSync(dir).mode & 0o777;
  assert.equal(mode, 0o700);
  const p = allocTempPath('guard', '.bin');
  assert.ok(p.startsWith(dir));
});

test('writePrivateTempFile: 创建 0600 文件', async () => {
  const p = allocTempPath('guard-write', '.bin');
  await writePrivateTempFile(p, Buffer.from('x'));
  try {
    const mode = statSync(p).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await removeTempFile(p);
  }
});

test('readImageFile: 完整读取 tiny PNG', async () => {
  const f = join(process.cwd(), 'test', `guard-read-${Date.now()}.png`);
  writeFileSync(f, TINY_PNG);
  try {
    const buf = await readImageFile(f);
    assert.ok(buf.equals(TINY_PNG));
  } finally {
    unlinkSync(f);
  }
});

test('readImageFile: 空文件拒绝', async () => {
  const f = join(process.cwd(), 'test', `guard-empty-${Date.now()}.png`);
  writeFileSync(f, '');
  try {
    await assert.rejects(readImageFile(f), ImageValidationError);
  } finally {
    unlinkSync(f);
  }
});

test('ensureWorkspaceTmpDir: tmp 不可写时抛 TempManagerError', () => {
  const dir = ensureWorkspaceTmpDir();
  try {
    chmodSync(dir, 0o500);
    assert.throws(() => ensureWorkspaceTmpDir(), TempManagerError);
  } finally {
    chmodSync(dir, 0o700);
  }
});

/** 复现 withTimedSharpStage 超时+drain 语义（不依赖 sharp 速度） */
async function simulateTimedSharpStage(timeoutMs, workMs) {
  return withSharpConcurrency(async () => {
    const work = new Promise((resolve) => setTimeout(resolve, workMs));
    let timedOut = false;
    try {
      await Promise.race([
        work,
        new Promise((_, reject) => {
          setTimeout(() => {
            timedOut = true;
            reject(new Error('stage timeout'));
          }, timeoutMs);
        }),
      ]);
    } catch (e) {
      if (timedOut) {
        try {
          await work;
        } catch {
          /* drain */
        }
      }
      throw e;
    }
  });
}

test('timed sharp stage: 超时 drain 后 semaphore 槽位可恢复', async () => {
  resetSharpSemaphoreForTests();
  process.env.VISION_SHARP_CONCURRENCY = '1';
  resetSharpSemaphoreForTests();

  await assert.rejects(simulateTimedSharpStage(15, 120), /stage timeout/);

  let acquired = false;
  await withSharpConcurrency(async () => {
    acquired = true;
  });
  assert.equal(acquired, true);
});

test('runCompare 源码：A load+prepare 在 B load 之前', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'server.ts'), 'utf8');
  const start = src.indexOf('async function runCompare');
  assert.ok(start >= 0);
  const block = src.slice(start, start + 1200);
  const idxLoadA = block.indexOf('loadResolvedBuffer(image1');
  const idxPrepA = block.indexOf('prepareVisionPayload(dataA');
  const idxLoadB = block.indexOf('loadResolvedBuffer(image2');
  const idxPrepB = block.indexOf('prepareVisionPayload(dataB');
  assert.ok(idxLoadA >= 0 && idxPrepA > idxLoadA);
  assert.ok(idxPrepA < idxLoadB && idxLoadB < idxPrepB);
});
