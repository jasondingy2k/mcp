// screenshot.ts — 跨平台全屏抓屏（主屏）
// darwin：screencapture -x；win32：powershell.exe CopyFromScreen；其余平台明确暂不支持。
import { execFile } from 'child_process';
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { maxImageBytes } from './config.js';

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
    return new ScreenshotError('未找到 screencapture（应为 macOS 系统自带）。');
  }
  const timedOut =
    (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true ||
    (error as NodeJS.ErrnoException & { signal?: string }).signal === 'SIGTERM' ||
    /ETIMEDOUT|timed out/i.test(error.message ?? '');
  if (timedOut) {
    return new ScreenshotError('截屏超时（>15s）（卡在 截屏）');
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new ScreenshotError('截屏输出过大（卡在 截屏）');
  }
  return new ScreenshotError('Screenshot capture failed (screencapture).');
}

async function execDarwinScreenshot(outPath: string): Promise<void> {
  const maxBuf = maxImageBytes() + 2 * 1024 * 1024;
  return new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      'screencapture',
      ['-x', outPath],
      { timeout: SCREENSHOT_TIMEOUT_MS, maxBuffer: maxBuf },
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
    return new ScreenshotError('未找到 powershell.exe（应为 Windows 系统自带）。');
  }
  const timedOut =
    (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true ||
    (error as NodeJS.ErrnoException & { signal?: string }).signal === 'SIGTERM' ||
    /ETIMEDOUT|timed out/i.test(error.message ?? '');
  if (timedOut) {
    return new ScreenshotError('windows screenshot: 截屏超时（>15s）（卡在 截屏）');
  }
  const detail = String(stderr).trim() || (error.message ?? String(error));
  return new ScreenshotError(`windows screenshot: ${detail.slice(0, 200)}`);
}

async function execWindowsScreenshot(outPath: string): Promise<void> {
  const script = buildWindowsScreenshotScript(outPath);
  const maxBuf = maxImageBytes() + 2 * 1024 * 1024;
  return new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: SCREENSHOT_TIMEOUT_MS, maxBuffer: maxBuf },
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
  const here = fileURLToPath(import.meta.url);
  const projectTmp = join(resolve(here, '..', '..'), 'tmp');
  const candidates = [projectTmp, join(tmpdir(), 'deepseek_vision_mcp')];
  for (const d of candidates) {
    try {
      mkdirSync(d, { recursive: true });
      return join(d, `shot_${randomUUID()}.png`);
    } catch {
      continue;
    }
  }
  throw new ScreenshotError('Cannot create temp directory');
}

export async function persistScreenshot(
  platform: NodeJS.Platform,
  execDarwin: (out: string) => Promise<void>,
  execWin: (out: string) => Promise<void>,
  makeTempPath: () => string = tempPath
): Promise<string> {
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new ScreenshotError(
      `Screenshot is not supported on this platform (${platform}). Use source=path with an image file.`
    );
  }
  const out = makeTempPath();
  try {
    if (platform === 'darwin') await execDarwin(out);
    else await execWin(out);
    if (!existsSync(out) || statSync(out).size <= 0) {
      throw new ScreenshotError(
        'No valid screenshot file (empty or missing)（卡在 截屏）'
      );
    }
    try {
      chmodSync(out, 0o600);
    } catch {
      /* best effort */
    }
    return out;
  } catch (e) {
    try {
      unlinkSync(out);
    } catch {
      /* 清理失败不阻断 */
    }
    throw e;
  }
}

export function saveScreenshotImage(): Promise<string> {
  return persistScreenshot(process.platform, execDarwinScreenshot, execWindowsScreenshot);
}
