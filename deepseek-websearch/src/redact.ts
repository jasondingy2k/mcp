// redact.ts — 敏感信息脱敏。
// 顺序关键：先吃掉完整 `Authorization: Bearer <token>` / `Bearer <token>`，
// 再处理 api_key=…；切勿用 authorization[=:] 只吃到 "Bearer" 而留下 tvly-… 真值。
export function redactSensitive(text: string): string {
  return text
    .replace(/("(?:api[_-]?key|authorization)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
    .replace(/(Authorization\s*:\s*Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key)\s*[=:]\s*)([^\s&,"'}]+)/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[redacted]')
    .replace(/\b(tvly-[A-Za-z0-9_-]{8,})\b/gi, '[redacted]');
}
