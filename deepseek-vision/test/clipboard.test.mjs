// 零成本单元测试：剪贴板方案 A 最终形态 —— darwin pngpaste / win32 PowerShell / 平台分流 / 失败清理。
// 全部依赖注入 mock，不触真实剪贴板、不触网。运行：npm run build && node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseDarwinError,
  buildWindowsClipboardScript,
  parseWindowsClipboardError,
  persistClipboard,
  ClipboardError,
} from '../build/clipboard.js';

const FAKE_OUT = join(process.cwd(), 'test', 'clip-out-test.png');
const PNG_BUF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

// ---- darwin：pngpaste 错误映射 ----
test('parseDarwinError: 无 error → null（成功）', () => {
  assert.equal(parseDarwinError(null), null);
});
test('parseDarwinError: ENOENT → 安装指引', () => {
  const err = new Error('spawn pngpaste ENOENT');
  err.code = 'ENOENT';
  const e = parseDarwinError(err);
  assert.ok(e instanceof ClipboardError);
  assert.match(e.message, /pngpaste/);
});
test('parseDarwinError: 其他失败 → No image in clipboard', () => {
  const e = parseDarwinError(new Error('boom'));
  assert.ok(e instanceof ClipboardError);
  assert.match(e.message, /No image in clipboard/);
});

test('parseDarwinError: killed/超时 → 卡在 剪贴板读取（非无图）', () => {
  const err = new Error('spawn pngpaste ETIMEDOUT');
  err.killed = true;
  err.signal = 'SIGTERM';
  const e = parseDarwinError(err);
  assert.ok(e instanceof ClipboardError);
  assert.match(e.message, /超时/);
  assert.match(e.message, /卡在 剪贴板读取/);
  assert.ok(!/No image in clipboard/.test(e.message));
});

test('parseWindowsClipboardError: 超时 → 卡在 剪贴板读取', () => {
  const err = new Error('timeout');
  err.killed = true;
  const e = parseWindowsClipboardError(err, '');
  assert.ok(e instanceof ClipboardError);
  assert.match(e.message, /超时/);
  assert.match(e.message, /卡在 剪贴板读取/);
});

// ---- win32：PowerShell 脚本构建 ----
test('buildWindowsClipboardScript: 含 WinForms/Drawing/GetImage/NO_IMAGE/Png', () => {
  const s = buildWindowsClipboardScript('C:\\tmp\\clip_1.png');
  assert.ok(s.includes('System.Windows.Forms'));
  assert.ok(s.includes('System.Drawing'));
  assert.ok(s.includes('[System.Windows.Forms.Clipboard]::GetImage()'));
  assert.ok(s.includes('NO_IMAGE'));
  assert.ok(s.includes('exit 1'));
  assert.ok(s.includes('C:\\tmp\\clip_1.png'));
  assert.ok(s.includes('[System.Drawing.Imaging.ImageFormat]::Png'));
});
test('buildWindowsClipboardScript: outPath 单引号转义（\' → \'\'）', () => {
  const s = buildWindowsClipboardScript("C:\\tmp\\it's.png");
  assert.ok(s.includes("'C:\\tmp\\it''s.png'"), 'PS 单引号应被转义为双引号');
});

// ---- win32：执行结果 → 错误映射 ----
test('parseWindowsClipboardError: 无 error → null（成功）', () => {
  assert.equal(parseWindowsClipboardError(null, ''), null);
});
test('parseWindowsClipboardError: stderr 含 NO_IMAGE → No image in clipboard', () => {
  const e = parseWindowsClipboardError(new Error('failed'), 'NO_IMAGE');
  assert.ok(e instanceof ClipboardError);
  assert.match(e.message, /No image in clipboard/);
});
test('parseWindowsClipboardError: ENOENT → 缺 powershell.exe 文案', () => {
  const err = new Error('spawn powershell.exe ENOENT');
  err.code = 'ENOENT';
  const e = parseWindowsClipboardError(err, '');
  assert.ok(e instanceof ClipboardError);
  assert.match(e.message, /powershell\.exe/);
});
test('parseWindowsClipboardError: 其他失败 → windows clipboard 前缀 + 截断', () => {
  const e = parseWindowsClipboardError(new Error('boom'), 'x'.repeat(500));
  assert.ok(e instanceof ClipboardError);
  assert.match(e.message, /^windows clipboard: /);
  assert.ok(e.message.length < 300, '错误信息应被截断');
});

// ---- persistClipboard：平台分流 + 落盘 + 失败清理 ----
test('persistClipboard: darwin 成功 → 返回路径且文件已写', async () => {
  try {
    unlinkSync(FAKE_OUT);
  } catch {}
  const p = await persistClipboard(
    'darwin',
    async (out) => writeFileSync(out, PNG_BUF),
    async () => {},
    () => FAKE_OUT
  );
  assert.equal(p, FAKE_OUT);
  assert.ok(existsSync(FAKE_OUT), 'pngpaste 落盘文件应存在');
  unlinkSync(FAKE_OUT);
});

test('persistClipboard: darwin 写盘后失败 → 清理', async () => {
  try {
    unlinkSync(FAKE_OUT);
  } catch {}
  await assert.rejects(
    persistClipboard(
      'darwin',
      async (out) => {
        writeFileSync(out, PNG_BUF); // 模拟 pngpaste 已写盘后仍失败
        throw new ClipboardError('boom');
      },
      async () => {},
      () => FAKE_OUT
    ),
    ClipboardError
  );
  assert.equal(existsSync(FAKE_OUT), false, '失败后临时文件应被清理');
});

test('persistClipboard: win32 写盘后失败 → 清理', async () => {
  try {
    unlinkSync(FAKE_OUT);
  } catch {}
  await assert.rejects(
    persistClipboard(
      'win32',
      async () => {},
      async (out) => {
        writeFileSync(out, 'x'); // 模拟 PS 已写盘后仍失败
        throw new ClipboardError('boom');
      },
      () => FAKE_OUT
    ),
    ClipboardError
  );
  assert.equal(existsSync(FAKE_OUT), false, 'win32 失败后落盘文件应被清理');
});

test('persistClipboard: linux 明确暂不支持且不建临时路径', async () => {
  let tempCalls = 0;
  await assert.rejects(
    persistClipboard(
      'linux',
      async () => {},
      async () => {},
      () => {
        tempCalls++;
        return FAKE_OUT;
      }
    ),
    (e) => e instanceof ClipboardError && /not supported/.test(e.message)
  );
  assert.equal(tempCalls, 0, '不支持平台不得先建 tmp');
});

test('persistClipboard: 其他平台(freebsd)拒绝', async () => {
  await assert.rejects(
    persistClipboard('freebsd', async () => {}, async () => {}, () => FAKE_OUT),
    ClipboardError
  );
});
