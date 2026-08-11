// pipeline-budget.ts — 覆盖 读取→转码→校验→裁切→缩放→推理 的总墙钟预算
import { ANALYZE_TOTAL_TIMEOUT_MS } from './config.js';

export class PipelineBudget {
  private readonly deadline: number;
  readonly totalMs: number;

  constructor(totalMs: number = ANALYZE_TOTAL_TIMEOUT_MS, startMs: number = Date.now()) {
    this.totalMs = totalMs;
    this.deadline = startMs + totalMs;
  }

  remaining(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  assertRemaining(stage: string, reserveMs = 0): void {
    if (this.remaining() <= reserveMs) {
      throw new Error(`视觉任务总超时（>${this.totalMs}ms）（卡在 ${stage}）`);
    }
  }

  /** 当前阶段可用超时（不超过 desiredMs，且为总预算剩余减去 reserve） */
  stageTimeout(stage: string, desiredMs: number, reserveMs = 0): number {
    this.assertRemaining(stage, reserveMs);
    const available = this.remaining() - reserveMs;
    return Math.max(1, Math.min(desiredMs, available));
  }
}
