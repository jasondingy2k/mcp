// semaphore.ts — sharp/libvips 管线并发上限（排队，非 Promise.race 伪取消）
import { sharpConcurrency } from './config.js';

class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(slots: number) {
    this.available = slots;
  }

  async acquire(): Promise<() => void> {
    if (this.available <= 0) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.available--;
    return () => this.release();
  }

  private release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

let globalSharpSem: Semaphore | undefined;

function getSharpSemaphore(): Semaphore {
  if (!globalSharpSem) {
    globalSharpSem = new Semaphore(sharpConcurrency());
  }
  return globalSharpSem;
}

export async function withSharpConcurrency<T>(fn: () => Promise<T>): Promise<T> {
  const release = await getSharpSemaphore().acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 单测重置全局 semaphore */
export function resetSharpSemaphoreForTests(): void {
  globalSharpSem = undefined;
}
