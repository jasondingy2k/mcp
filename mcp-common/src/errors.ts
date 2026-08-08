// errors.ts — 错误前缀（工作区约定：`[<server> 内部错误] <类型>: <信息>`）
// 2026-08-07：错误信息直接进工具返回文本（agent 可转述给用户），不落日志文件。
export function makeToolError(
  serverName: string
): (type: string, message: string) => string {
  const prefix = `[${serverName} 内部错误]`;
  return (type, message) => `${prefix} ${type}: ${message}`;
}
