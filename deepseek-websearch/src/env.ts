// env.ts — .env 加载
// 支持：`export ` 前缀、` #` 行内注释、非法值（null 字节）跳过；
// 已有环境变量优先，不被 .env 覆盖；只在启动时调用一次。
// 注释剥离：引号内的 ` #` 保留；先匹配闭合引号再忽略尾部注释。
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/** 解析 = 右侧：支持 "a # b" / 'a # b' / a # comment */
export function parseEnvValue(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0];
    let i = 1;
    while (i < v.length) {
      if (v[i] === '\\' && i + 1 < v.length) {
        i += 2;
        continue;
      }
      if (v[i] === q) {
        return v.slice(1, i); // 引号内原样；闭合后的 ` # comment` 丢弃
      }
      i++;
    }
    // 未闭合引号：退回无引号路径
  }
  const hash = v.search(/\s#/);
  return (hash !== -1 ? v.slice(0, hash) : v).trim();
}

export function loadEnvFile(envPath?: string): void {
  const path = envPath ?? resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return; // 不可读的 .env 不阻断启动
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.replace(/^export\s+/, '');
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;
    const value = parseEnvValue(withoutExport.slice(eq + 1));
    if (value.includes('\u0000')) continue; // 非法值（null 字节）跳过
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
