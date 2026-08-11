// temp-manager.ts — workspace-private 0700 临时目录；文件 0600；登记清理；不回退工作区外
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from 'fs';
import { open, unlink } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const registered = new Set<string>();
let exitHookInstalled = false;

export class TempManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TempManagerError';
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const cleanup = (): void => {
    for (const p of registered) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    registered.clear();
  };
  process.once('exit', cleanup);
}

/** deepseek-vision/tmp（与 src 同级） */
export function workspaceTmpDir(): string {
  const here = fileURLToPath(import.meta.url);
  return join(resolve(here, '..', '..'), 'tmp');
}

/** 确保 workspace tmp 存在且为 0700；不可写则抛错，不回退系统 temp */
export function ensureWorkspaceTmpDir(): string {
  const dir = workspaceTmpDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = join(dir, `.probe_${randomBytes(4).toString('hex')}`);
    const fd = openSync(probe, 'wx', 0o600);
    closeSync(fd);
    unlinkSync(probe);
    chmodSync(dir, 0o700);
  } catch {
    throw new TempManagerError(`workspace temp 目录不可写: ${dir}（卡在 临时文件）`);
  }
  return dir;
}

/** 分配尚未创建的临时文件路径（调用方或外部工具落盘） */
export function allocTempPath(prefix: string, suffix: string): string {
  const dir = ensureWorkspaceTmpDir();
  const id = randomBytes(8).toString('hex');
  return join(dir, `${prefix}_${id}${suffix}`);
}

export function registerTempFile(path: string): void {
  registered.add(path);
  installExitHook();
}

export function unregisterTempFile(path: string): void {
  registered.delete(path);
}

/** 进程内写入私有临时文件（wx + 0600） */
export async function writePrivateTempFile(path: string, data: Buffer): Promise<void> {
  registerTempFile(path);
  const fh = await open(path, 'wx', 0o600);
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

export async function removeTempFile(path: string): Promise<void> {
  unregisterTempFile(path);
  try {
    await unlink(path);
  } catch {
    /* ignore */
  }
}

/** 外部工具落盘后：登记 + chmod 0600 */
export function secureExistingTempFile(path: string): void {
  registerTempFile(path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
}

/** 校验落盘文件存在且非空（clipboard/screenshot 共用） */
export function assertNonEmptyTempFile(
  path: string,
  emptyMessage: string
): void {
  if (!existsSync(path)) {
    throw new Error(emptyMessage);
  }
  if (statSync(path).size <= 0) {
    throw new Error(emptyMessage);
  }
}
