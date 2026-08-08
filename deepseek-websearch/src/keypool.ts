// 多 key 加权轮询（多 key 加权负载均衡方案 2026-08-08 §5）。
// 纯逻辑：parse + WRR 状态机，零网络、零 axios 依赖，供 index.ts 与单测共用。

export type KeyProvider = 'tavily' | 'exa';

export interface KeyCandidate {
  provider: KeyProvider;
  key: string;
  weight: number;
}

/** 逗号分隔多 key 解析：split → trim → 丢空串。'' / ',' → [];'a,b' → ['a','b']。 */
export function parseApiKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 正整数权重解析：缺省/非法（非数字、≤0、小数、NaN）→ fallback。不崩溃。 */
export function parseKeyWeight(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const t = raw.trim();
  if (!/^[1-9]\d*$/.test(t)) return fallback; // 正整数（不含 0、不含小数/负数/科学计数）
  return Number(t);
}

/**
 * 加权轮询（平滑 WRR）：每轮所有 key 的 current += weight，选 current 最大者，再 current -= totalWeight。
 * 长期频率趋近权重比。进程内状态即可（不追求跨并发完美公平，方案 §5.2）。
 */
export class WeightedRoundRobin {
  private candidates: KeyCandidate[];
  private current: number[];
  private totalWeight: number;

  constructor(candidates: KeyCandidate[]) {
    this.candidates = [...candidates];
    this.current = this.candidates.map(() => 0);
    this.totalWeight = this.candidates.reduce((s, c) => s + c.weight, 0);
  }

  get size(): number {
    return this.candidates.length;
  }

  /** 选下一个 key（advance 状态）。空池抛错。 */
  next(): KeyCandidate {
    if (this.candidates.length === 0) {
      throw new Error('keypool empty');
    }
    let best = 0;
    for (let i = 0; i < this.candidates.length; i++) {
      this.current[i] += this.candidates[i].weight;
      if (this.current[i] > this.current[best]) best = i;
    }
    this.current[best] -= this.totalWeight;
    return this.candidates[best];
  }

  /**
   * 从指定 key 起的本轮尝试顺序（单次请求内失败重试用，方案 §5.3）：
   * 以 start 为首，其余按权重降序（同权重保原序）。不 advance 状态。
   */
  orderFrom(start: KeyCandidate): KeyCandidate[] {
    const rest = this.candidates
      .filter((c) => c !== start)
      .sort((a, b) => b.weight - a.weight || this.candidates.indexOf(a) - this.candidates.indexOf(b));
    return [start, ...rest];
  }
}

/** 失败后是否试下一个 key：auth/quota/rate/error 均换 key（多账号场景，§5.4）。 */
export function shouldRetryNextKey(kind: string): boolean {
  return kind === 'auth' || kind === 'quota' || kind === 'rate' || kind === 'error';
}

/**
 * 池化重试：WRR 选起始 key，失败按权重顺序换下一 key，每 key 至多一次（§5.3）。
 * 返回 { value, attempts }：attempts 为每次失败的 message（供 answer 标注 / 聚合错误）。
 * 全部失败抛错（消息聚合，调用方负责脱敏）。
 */
export async function retryOverPool<T>(
  pool: WeightedRoundRobin,
  call: (c: KeyCandidate) => Promise<T>,
): Promise<{ value: T; attempts: string[] }> {
  const first = pool.next();
  const attempts: string[] = [];
  for (const cand of pool.orderFrom(first)) {
    try {
      return { value: await call(cand), attempts };
    } catch (err: any) {
      attempts.push(String(err?.message ?? err));
    }
  }
  throw new Error(`All keys failed:\n- ${attempts.join('\n- ')}`);
}
