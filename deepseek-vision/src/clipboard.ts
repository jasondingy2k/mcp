// clipboard.ts — 跨平台读取剪贴板图片（方案 A 最终形态）
// darwin：pngpaste（本机实测 pbpaste 读图恒 0 字节，2026-08-07 决策回退）；win32：powershell.exe 单次落盘；
// 其余平台明确暂不支持。临时文件优先项目 tmp/，回退系统临时目录。
import { execFile } from 'child_process';
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { maxImageBytes } from './config.js';

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
    return new ClipboardError('未安装 pngpaste，可执行 brew install pngpaste 后重试。');
  }
  // execFile timeout 会设 killed=true（或 signal=SIGTERM）；勿误报「无图」
  const timedOut =
    (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true ||
    (error as NodeJS.ErrnoException & { signal?: string }).signal === 'SIGTERM' ||
    /ETIMEDOUT|timed out/i.test(error.message ?? '');
  if (timedOut) {
    return new ClipboardError('剪贴板读取超时（>10s）（卡在 剪贴板读取）');
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new ClipboardError('剪贴板图片过大（卡在 剪贴板读取）');
  }
  return new ClipboardError('No image in clipboard (pngpaste failed).');
}

async function execDarwin(outPath: string): Promise<void> {
  const maxBuf = maxImageBytes() + 2 * 1024 * 1024;
  return new Promise<void>((resolvePromise, rejectPromise) => {
    execFile('pngpaste', [outPath], { timeout: 10000, maxBuffer: maxBuf }, (error) => {
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
    return new ClipboardError('未找到 powershell.exe（应为 Windows 系统自带）。');
  }
  const timedOut =
    (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true ||
    (error as NodeJS.ErrnoException & { signal?: string }).signal === 'SIGTERM' ||
    /ETIMEDOUT|timed out/i.test(error.message ?? '');
  if (timedOut) {
    return new ClipboardError('windows clipboard: 读取超时（>10s）（卡在 剪贴板读取）');
  }
  const detail = String(stderr).trim() || (error.message ?? String(error));
  return new ClipboardError(`windows clipboard: ${detail.slice(0, 200)}`);
}

// PowerShell 单次落盘到 outPath（不再 Buffer 二次写盘）
async function execWindowsClipboard(outPath: string): Promise<void> {
  const script = buildWindowsClipboardScript(outPath);
  const maxBuf = maxImageBytes() + 2 * 1024 * 1024;
  return new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 10000, maxBuffer: maxBuf },
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
  const here = fileURLToPath(import.meta.url);
  const projectTmp = join(resolve(here, '..', '..'), 'tmp');
  const candidates = [projectTmp, join(tmpdir(), 'deepseek_vision_mcp')];
  for (const d of candidates) {
    try {
      mkdirSync(d, { recursive: true });
      return join(d, `clip_${randomUUID()}.png`);
    } catch {
      continue;
    }
  }
  throw new ClipboardError('Cannot create temp directory');
}

// 可注入版（execDarwin / execWin / makeTempPath 便于测试；生产用默认实现）。
export async function persistClipboard(
  platform: NodeJS.Platform,
  execDarwin: (out: string) => Promise<void>,
  execWin: (out: string) => Promise<void>,
  makeTempPath: () => string = tempPath
): Promise<string> {
  // 先判平台再建临时路径，避免 linux 等不支持平台空建 tmp/
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new ClipboardError(
      `Clipboard image is not supported on this platform (${platform}). Use source=path with an image file.`
    );
  }
  const out = makeTempPath();
  try {
    if (platform === 'darwin') await execDarwin(out); // pngpaste 单次落盘
    else await execWin(out); // PowerShell 单次落盘
    if (!existsSync(out) || statSync(out).size <= 0) {
      throw new ClipboardError(
        'No valid image file from clipboard (empty or missing)（卡在 剪贴板读取）'
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
      unlinkSync(out); // 失败路径清理，避免残留
    } catch {
      /* 清理失败不阻断 */
    }
    throw e;
  }
}

export function saveClipboardImage(): Promise<string> {
  return persistClipboard(process.platform, execDarwin, execWindowsClipboard);
}
