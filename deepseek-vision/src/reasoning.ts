// reasoning.ts — 从 chat completion message 提取 reasoning_content
// （openai v7 SDK 解析后未知字段原样保留，spike 已实测；支持字符串与数组两种形式）
export function extractReasoning(msg: any): string | null {
  const raw = msg?.reasoning_content;
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t || null;
  }
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const part of raw) {
      parts.push(
        part == null
          ? ''
          : part && typeof part === 'object'
            ? String(part.text ?? '')
            : String(part)
      );
    }
    const text = parts.join('').trim();
    return text || null;
  }
  const t = String(raw).trim();
  return t || null;
}
