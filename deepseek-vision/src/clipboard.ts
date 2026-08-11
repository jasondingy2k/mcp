// clipboard.ts — 跨平台读取剪贴板图片（方案 A 最终形态）
// darwin：pngpaste（本机实测 pbpaste 读图恒 0 字节，2026-08-07 决策回退）；win32：powershell.exe 单次落盘；
// 其余平台明确暂不支持。临时文件仅 workspace-private tmp/（0700），不回退系统 temp。
import { execFile } from 'child_process';
import { unlinkSync } from 'fs';
import { maxImageBytes } from './config.js';
import type { PipelineBudget } from './pipeline-budget.js';
import {
  allocTempPath,
  assertNonEmptyTempFile,
  secureExistingTempFile,
  TempManagerError,
} from './temp-manager.js';

const CLIPBOARD_TIMEOUT_MS = 10_000;

export class ClipboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClipboardError';
  }
}

// ---- darwin：pngpaste 直接写 PNG 文件到 outPath ----
// 本机（macOS Darwin 24.6）实测：pbpaste -t public.png/tiff/jpeg 对图片剪贴板返回 0 字节
// （文本可读），故 darwin 维持 pngpaste（brew，原 Python 版同源），不做 pbpaste 探测。
export function parseDarwinError(error: NodeJS.ErrnoException | null): ClipboardError | null {
  if (!error) return null;
  if (error.code === 'ENOENT') {
    return new ClipboardError('pngpaste missing（卡在 剪贴板读取）');
  }
  // execFile timeout 会设 killed=true（或 signal=SIGTERM）；勿误报「无图」
  const timedOut =
    (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true ||
    (error as NodeJS.ErrnoException & { signal?: string }).signal === 'SIGTERM' ||
    /ETIMEDOUT|timed out/i.test(error.message ?? '');
  if (timedOut) {
    return new ClipboardError('clipboard read timeout (>10s)（卡在 剪贴板读取）');
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new ClipboardError('clipboard image too large（卡在 剪贴板读取）');
  }
  return new ClipboardError('No image in clipboard (pngpaste failed).');
}

async function execDarwin(outPath: string, timeoutMs: number): Promise<void> {
  const maxBuf = maxImageBytes() + 2 * 1024 * 1024;
  return new Promise<void>((resolvePromise, rejectPromise) => {
    execFile('pngpaste', [outPath], { timeout: timeoutMs, maxBuffer: maxBuf }, (error) => {
      const parsed = parseDarwinError(error as NodeJS.ErrnoException | null);
      if (parsed) rejectPromise(parsed);
      else resolvePromise();
    });
  });
}

// ---- win32：PowerShell 脚本（系统自带 powershell.exe，写死；pwsh 7+ 默认 MTA 会失败）----
// STA 前提：Windows 自带 powershell.exe（5.x）默认 STA，[Windows.Forms.Clipboard]::GetImage() 依赖 STA。
export function buildWindowsClipboardScript(outPath: string): string {
  const quoted = "'" + outPath.replace(/'/g, "''") + "'"; // PS 单引号转义：' → ''
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    'if ($img -eq $null) { [Console]::Error.WriteLine("NO_IMAGE"); exit 1 }',
    `$img.Save(${quoted}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    'exit 0',
  ].join('\n');
}

// 把 PowerShell 执行结果映射为错误（纯函数，供单测 mock）。NO_IMAGE → 无图；ENOENT → 缺 exe。
export function parseWindowsClipboardError(
  error: NodeJS.ErrnoException | null,
  stderr: string
): ClipboardError | null {
  if (!error) return null;
  if (stderr.includes('NO_IMAGE')) {
    return new ClipboardError('No image in clipboard');
  }
  if (error.code === 'ENOENT') {
    return new ClipboardError('powershell.exe missing（卡在 剪贴板读取）');
  }
  const timedOut =
    (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true ||
    (error as NodeJS.ErrnoException & { signal?: string }).signal === 'SIGTERM' ||
    /ETIMEDOUT|timed out/i.test(error.message ?? '');
  if (timedOut) {
    return new ClipboardError('windows clipboard: read timeout (>10s)（卡在 剪贴板读取）');
  }
  const detail = String(stderr).trim() || (error.message ?? String(error));
  return new ClipboardError(`windows clipboard: ${detail.slice(0, 200)}`);
}

// PowerShell 单次落盘到 outPath（不再 Buffer 二次写盘）
async function execWindowsClipboard(outPath: string, timeoutMs: number): Promise<void> {
  const script = buildWindowsClipboardScript(outPath);
  const maxBuf = maxImageBytes() + 2 * 1024 * 1024;
  return new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, maxBuffer: maxBuf },
      (error, _stdout, stderr) => {
        const parsed = parseWindowsClipboardError(
          error as NodeJS.ErrnoException | null,
          String(stderr)
        );
        if (parsed) rejectPromise(parsed);
        else resolvePromise();
      }
    );
  });
}

// ---- 生产入口：平台分流 → 落盘 PNG 临时文件，返回路径；失败清理 ----
function tempPath(): string {
  return allocTempPath('clip', '.png');
}

// 可注入版（execDarwin / execWin / makeTempPath 便于测试；生产用默认实现）。
export async function persistClipboard(
  platform: NodeJS.Platform,
  execDarwin: (out: string, timeoutMs: number) => Promise<void>,
  execWin: (out: string, timeoutMs: number) => Promise<void>,
  makeTempPath: () => string = tempPath,
  budget?: PipelineBudget
): Promise<string> {
  // 先判平台再建临时路径，避免 linux 等不支持平台空建 tmp/
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new ClipboardError(
      `Clipboard image is not supported on this platform (${platform}). Use an absolute image path or base64/data URL.`
    );
  }
  const timeoutMs = budget
    ? budget.stageTimeout('剪贴板读取', CLIPBOARD_TIMEOUT_MS, 500)
    : CLIPBOARD_TIMEOUT_MS;
  const out = makeTempPath();
  try {
    if (platform === 'darwin') await execDarwin(out, timeoutMs);
    else await execWin(out, timeoutMs);
    try {
      assertNonEmptyTempFile(
        out,
        'No valid image file from clipboard (empty or missing)（卡在 剪贴板读取）'
      );
    } catch (e) {
      throw new ClipboardError(e instanceof Error ? e.message : String(e));
    }
    secureExistingTempFile(out);
    return out;
  } catch (e) {
    try {
      unlinkSync(out); // 失败路径清理，避免残留
    } catch {
      /* 清理失败不阻断 */
    }
    if (e instanceof TempManagerError) {
      throw new ClipboardError(e.message);
    }
    throw e;
  }
}

export function saveClipboardImage(budget?: PipelineBudget): Promise<string> {
  return persistClipboard(process.platform, execDarwin, execWindowsClipboard, tempPath, budget);
}
