// screenshot.ts — 跨平台全屏抓屏（主屏）
// darwin：screencapture -x；win32：powershell.exe CopyFromScreen；其余平台明确暂不支持。
// 临时文件仅 workspace-private tmp/（0700），不回退系统 temp。
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

const SCREENSHOT_TIMEOUT_MS = 15_000;

export class ScreenshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenshotError';
  }
}

// ---- darwin：screencapture -x 静音全屏抓屏 ----
export function parseDarwinScreenshotError(
  error: NodeJS.ErrnoException | null
): ScreenshotError | null {
  if (!error) return null;
  if (error.code === 'ENOENT') {
    return new ScreenshotError('screencapture missing（卡在 截屏）');
  }
  const timedOut =
    (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true ||
    (error as NodeJS.ErrnoException & { signal?: string }).signal === 'SIGTERM' ||
    /ETIMEDOUT|timed out/i.test(error.message ?? '');
  if (timedOut) {
    return new ScreenshotError('screenshot timeout (>15s)（卡在 截屏）');
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new ScreenshotError('screenshot output too large（卡在 截屏）');
  }
  return new ScreenshotError('Screenshot capture failed (screencapture).');
}

async function execDarwinScreenshot(outPath: string, timeoutMs: number): Promise<void> {
  const maxBuf = maxImageBytes() + 2 * 1024 * 1024;
  return new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      'screencapture',
      ['-x', outPath],
      { timeout: timeoutMs, maxBuffer: maxBuf },
      (error) => {
        const parsed = parseDarwinScreenshotError(error as NodeJS.ErrnoException | null);
        if (parsed) rejectPromise(parsed);
        else resolvePromise();
      }
    );
  });
}

// ---- win32：PowerShell 主屏 CopyFromScreen（系统自带 powershell.exe，禁止 pwsh）----
export function buildWindowsScreenshotScript(outPath: string): string {
  const quoted = "'" + outPath.replace(/'/g, "''") + "'";
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
    `$bmp.Save(${quoted}, [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
    'exit 0',
  ].join('\n');
}

export function parseWindowsScreenshotError(
  error: NodeJS.ErrnoException | null,
  stderr: string
): ScreenshotError | null {
  if (!error) return null;
  if (error.code === 'ENOENT') {
    return new ScreenshotError('powershell.exe missing（卡在 截屏）');
  }
  const timedOut =
    (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true ||
    (error as NodeJS.ErrnoException & { signal?: string }).signal === 'SIGTERM' ||
    /ETIMEDOUT|timed out/i.test(error.message ?? '');
  if (timedOut) {
    return new ScreenshotError('windows screenshot: timeout (>15s)（卡在 截屏）');
  }
  const detail = String(stderr).trim() || (error.message ?? String(error));
  return new ScreenshotError(`windows screenshot: ${detail.slice(0, 200)}`);
}

async function execWindowsScreenshot(outPath: string, timeoutMs: number): Promise<void> {
  const script = buildWindowsScreenshotScript(outPath);
  const maxBuf = maxImageBytes() + 2 * 1024 * 1024;
  return new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, maxBuffer: maxBuf },
      (error, _stdout, stderr) => {
        const parsed = parseWindowsScreenshotError(
          error as NodeJS.ErrnoException | null,
          String(stderr)
        );
        if (parsed) rejectPromise(parsed);
        else resolvePromise();
      }
    );
  });
}

function tempPath(): string {
  return allocTempPath('shot', '.png');
}

export async function persistScreenshot(
  platform: NodeJS.Platform,
  execDarwin: (out: string, timeoutMs: number) => Promise<void>,
  execWin: (out: string, timeoutMs: number) => Promise<void>,
  makeTempPath: () => string = tempPath,
  budget?: PipelineBudget
): Promise<string> {
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new ScreenshotError(
      `Screenshot is not supported on this platform (${platform}). Use an absolute image path or base64/data URL.`
    );
  }
  const timeoutMs = budget
    ? budget.stageTimeout('截屏', SCREENSHOT_TIMEOUT_MS, 500)
    : SCREENSHOT_TIMEOUT_MS;
  const out = makeTempPath();
  try {
    if (platform === 'darwin') await execDarwin(out, timeoutMs);
    else await execWin(out, timeoutMs);
    try {
      assertNonEmptyTempFile(
        out,
        'No valid screenshot file (empty or missing)（卡在 截屏）'
      );
    } catch (e) {
      throw new ScreenshotError(e instanceof Error ? e.message : String(e));
    }
    secureExistingTempFile(out);
    return out;
  } catch (e) {
    try {
      unlinkSync(out);
    } catch {
      /* 清理失败不阻断 */
    }
    if (e instanceof TempManagerError) {
      throw new ScreenshotError(e.message);
    }
    throw e;
  }
}

export function saveScreenshotImage(budget?: PipelineBudget): Promise<string> {
  return persistScreenshot(
    process.platform,
    execDarwinScreenshot,
    execWindowsScreenshot,
    tempPath,
    budget
  );
}
