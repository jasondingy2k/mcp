// logging.ts — 默认静默日志：仅当 envVar 设置合法级别时输出到 stderr。
// 诊断信息应进工具返回文本，不累积日志文件。非法级别（如 verbose）视为未配置 → 静默。
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function makeLogger(
  serverName: string,
  envVar: string
): (level: LogLevel, message: string) => void {
  const raw = (process.env[envVar] ?? '').toLowerCase();
  const configured: LogLevel | '' = (LOG_LEVELS as string[]).includes(raw)
    ? (raw as LogLevel)
    : '';
  const tag = `[${serverName}]`;
  return (level, message) => {
    if (!configured) return;
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(configured)) return;
    console.error(`${tag} ${level}: ${message}`);
  };
}
