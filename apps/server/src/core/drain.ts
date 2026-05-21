/**
 * In-flight turn 计数器，供 graceful shutdown 使用。
 * Conductor.respond 进出时各 +/- 1；shutdown 等到 count===0 或超时再退出。
 */
import { logger } from '../observability/logger.js';

class Drainer {
  private inFlight = 0;
  private draining = false;

  enter(): void { this.inFlight++; }
  exit():  void { this.inFlight = Math.max(0, this.inFlight - 1); }

  /** 是否已开始 drain（外层据此返回 503） */
  isDraining(): boolean { return this.draining; }
  count(): number { return this.inFlight; }

  /**
   * 启动 drain：等所有 in-flight turn 完成 / 或超时退出。
   *   timeoutMs: 30s 默认
   */
  async drain(timeoutMs = 30_000): Promise<void> {
    this.draining = true;
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      logger.info({ inFlight: this.inFlight }, '[drain] 等待 in-flight turn 完成');
      await sleep(500);
    }
    if (this.inFlight > 0) {
      logger.warn({ remaining: this.inFlight, timeoutMs }, '[drain] 超时，强制退出');
    } else {
      logger.info('[drain] 所有 in-flight turn 已完成');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const drainer = new Drainer();
