// 零成本单元测试：全屏抓屏 —— darwin screencapture / win32 PowerShell / 平台分流 / 失败清理。
// 全部依赖注入 mock，不触真实抓屏、不触网。运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseDarwinScreenshotError,
  buildWindowsScreenshotScript,
  parseWindowsScreenshotError,
  persistScreenshot,
  ScreenshotError,
} from '../build/screenshot.js';

const FAKE_OUT = join(process.cwd(), 'test', 'shot-out-test.png');
const PNG_BUF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

// ---- darwin：screencapture 错误映射 ----
test('parseDarwinScreenshotError: 无 error → null（成功）', () => {
  assert.equal(parseDarwinScreenshotError(null), null);
});
test('parseDarwinScreenshotError: ENOENT → 缺 screencapture 文案', () => {
  const err = new Error('spawn screencapture ENOENT');
  err.code = 'ENOENT';
  const e = parseDarwinScreenshotError(err);
  assert.ok(e instanceof ScreenshotError);
  assert.match(e.message, /screencapture/);
});
test('parseDarwinScreenshotError: killed/超时 → 卡在 截屏', () => {
  const err = new Error('spawn screencapture ETIMEDOUT');
  err.killed = true;
  err.signal = 'SIGTERM';
  const e = parseDarwinScreenshotError(err);
  assert.ok(e instanceof ScreenshotError);
  assert.match(e.message, /timeout/i);
  assert.match(e.message, /卡在 截屏/);
});

// ---- win32：PowerShell 脚本构建 ----
test('buildWindowsScreenshotScript: 含 CopyFromScreen / Png / PrimaryScreen', () => {
  const s = buildWindowsScreenshotScript('C:\\tmp\\shot_1.png');
  assert.ok(s.includes('CopyFromScreen'));
  assert.ok(s.includes('[System.Drawing.Imaging.ImageFormat]::Png'));
  assert.ok(s.includes('PrimaryScreen'));
  assert.ok(s.includes('C:\\tmp\\shot_1.png'));
});
test('buildWindowsScreenshotScript: outPath 单引号转义（\' → \'\'）', () => {
  const s = buildWindowsScreenshotScript("C:\\tmp\\it's.png");
  assert.ok(s.includes("'C:\\tmp\\it''s.png'"), 'PS 单引号应被转义为双引号');
});

// ---- win32：执行结果 → 错误映射 ----
test('parseWindowsScreenshotError: 超时 → 卡在 截屏', () => {
  const err = new Error('timeout');
  err.killed = true;
  const e = parseWindowsScreenshotError(err, '');
  assert.ok(e instanceof ScreenshotError);
  assert.match(e.message, /timeout/i);
  assert.match(e.message, /卡在 截屏/);
});
test('parseWindowsScreenshotError: ENOENT → 缺 powershell.exe 文案', () => {
  const err = new Error('spawn powershell.exe ENOENT');
  err.code = 'ENOENT';
  const e = parseWindowsScreenshotError(err, '');
  assert.ok(e instanceof ScreenshotError);
  assert.match(e.message, /powershell\.exe/);
});

// ---- persistScreenshot：平台分流 + 落盘 + 失败清理 ----
test('persistScreenshot: darwin 成功 → 返回路径且文件已写', async () => {
  try {
    unlinkSync(FAKE_OUT);
  } catch {}
  const p = await persistScreenshot(
    'darwin',
    async (out) => writeFileSync(out, PNG_BUF),
    async () => {},
    () => FAKE_OUT
  );
  assert.equal(p, FAKE_OUT);
  assert.ok(existsSync(FAKE_OUT), 'screencapture 落盘文件应存在');
  unlinkSync(FAKE_OUT);
});

test('persistScreenshot: darwin exec 成功但未写文件 → ScreenshotError 且无残留', async () => {
  try {
    unlinkSync(FAKE_OUT);
  } catch {}
  await assert.rejects(
    persistScreenshot(
      'darwin',
      async () => {},
      async () => {},
      () => FAKE_OUT
    ),
    (e) =>
      e instanceof ScreenshotError &&
      /valid screenshot file/i.test(e.message) &&
      /卡在 截屏/.test(e.message)
  );
  assert.equal(existsSync(FAKE_OUT), false, '空落盘失败后临时文件应被清理');
});

test('persistScreenshot: win32 exec 成功但 0 字节 → ScreenshotError 且无残留', async () => {
  try {
    unlinkSync(FAKE_OUT);
  } catch {}
  await assert.rejects(
    persistScreenshot(
      'win32',
      async () => {},
      async (out) => writeFileSync(out, ''),
      () => FAKE_OUT
    ),
    (e) =>
      e instanceof ScreenshotError &&
      /valid screenshot file/i.test(e.message) &&
      /卡在 截屏/.test(e.message)
  );
  assert.equal(existsSync(FAKE_OUT), false, '0 字节落盘后临时文件应被清理');
});

test('persistScreenshot: linux 明确暂不支持且不建临时路径', async () => {
  let tempCalls = 0;
  let message = '';
  await assert.rejects(
    persistScreenshot(
      'linux',
      async () => {},
      async () => {},
      () => {
        tempCalls++;
        return FAKE_OUT;
      }
    ),
    (e) => {
      if (!(e instanceof ScreenshotError && /not supported/.test(e.message))) return false;
      message = e.message;
      return true;
    }
  );
  assert.equal(tempCalls, 0, '不支持平台不得先建 tmp');
  assert.match(message, /absolute image path or base64\/data URL/);
  assert.doesNotMatch(message, /source=/);
});
