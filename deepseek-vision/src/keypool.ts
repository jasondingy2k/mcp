// 多 key 等权轮询（平均 RR）。纯逻辑，零网络依赖。

/** 逗号分隔多 key：split → trim → 去重（稳定顺序）→ 丢空串。 */
export function parseApiKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const key = part.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * 等权轮询：每次 next() 推进下标。进程内状态即可。
 * orderFrom(start)：以 start 为首的本轮尝试顺序（失败换 key 用，不推进下标）。
 */
export class RoundRobin {
  private keys: string[];
  private index = 0;

  constructor(keys: string[]) {
    this.keys = [...keys];
  }

  get size(): number {
    return this.keys.length;
  }

  next(): string {
    if (this.keys.length === 0) {
      throw new Error('keypool empty');
    }
    const key = this.keys[this.index]!;
    this.index = (this.index + 1) % this.keys.length;
    return key;
  }

  /** 以 start 为首，其余按池内原序接续；不 advance。 */
  orderFrom(start: string): string[] {
    if (this.keys.length === 0) return [];
    const idx = this.keys.indexOf(start);
    if (idx < 0) return [...this.keys];
    return [...this.keys.slice(idx), ...this.keys.slice(0, idx)];
  }
}

/**
 * 网络阻断 / 连不上 / 超时：后面同池 key 多半同样到不了（无 VPN 打 Google）。
 * 有 fallback 时应整组跳过本池，不要逐个轮询。
 */
export function isNetworkOrBlockError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  const name = String((err as { name?: string })?.name ?? '');
  const code = String((err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? '').toLowerCase();
  const blob = `${msg} ${name} ${code}`;
  if (name.includes('Timeout')) return true;
  return (
    /timeout|etimedout|timed out|aborted|abort/.test(blob) ||
    /enotfound|econnrefused|econnreset|eai_again|enetunreach|ehostunreach|epipe/.test(blob) ||
    /socket hang up|fetch failed|network|unreachable|connect(?:ion)? (?:refused|reset|error)/.test(blob) ||
    /certificate|ssl|tls|cert/.test(blob)
  );
}

/**
 * 从 OpenAI SDK `APIError` 及兼容形状提取 HTTP status。
 * 路径：err.status → err.statusCode → err.error.status（嵌套 body）。
 */
export function httpStatusFromError(err: unknown): number {
  if (err == null || typeof err !== 'object') return 0;
  const o = err as Record<string, unknown>;
  for (const candidate of [o.status, o.statusCode, (o.error as Record<string, unknown> | undefined)?.status]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === 'string') {
      const n = Number.parseInt(candidate, 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

/**
 * 业务/额度类失败 → 试同池下一个 key（再进下一层级）。
 * 网络阻断另走 isNetworkOrBlockError（整组 skip）。
 */
export type FailureScope = 'key' | 'provider' | 'request' | 'unknown';

/**
 * 决定失败应在哪一层恢复：
 * - key：仅换同池 key（鉴权/限流/额度）；
 * - provider：跳过同池其余 key，进入下级 provider；
 * - request：请求本身无效，直接返回；
 * - unknown：保守返回原错误。
 */
export function classifyFailure(err: unknown): FailureScope {
  if (isNetworkOrBlockError(err)) return 'provider';
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  const status = httpStatusFromError(err);

  const keyScoped =
    /invalid.?api.?key|incorrect.?api.?key|authentication|unauthorized/.test(msg) ||
    /rate.?limit|too many requests|quota|insufficient|billing|payment.?required/.test(msg);
  if (keyScoped || status === 401 || status === 402 || status === 403 || status === 429) {
    return 'key';
  }
  if (status === 404 || status === 408 || status >= 500) return 'provider';
  if (/not found|unknown model|model .* unavailable/.test(msg)) return 'provider';
  if (status >= 400 && status < 500) return 'request';
  return 'unknown';
}

/** 兼容旧调用方；新逻辑优先使用 classifyFailure。 */
export function shouldRetryNextKey(err: unknown): boolean {
  return classifyFailure(err) === 'key';
}

/** provider 明确不认识 reasoning_effort 时，只允许同 key 窄降级一次。 */
export function isUnsupportedReasoningEffortError(err: unknown): boolean {
  const status = httpStatusFromError(err);
  if (status !== 400 && status !== 422) return false;
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return /reasoning[_ -]?effort/.test(msg) && /unknown|unsupported|unrecognized|extra|invalid/.test(msg);
}

/** 错误信息脱敏：不把完整 key 打进工具返回。 */
export function redactKeys(text: string, keys: string[]): string {
  let out = text;
  for (const key of keys) {
    if (key.length < 8) continue;
    const visible = `${key.slice(0, 4)}…${key.slice(-4)}`;
    out = out.split(key).join(visible);
  }
  return out;
}
