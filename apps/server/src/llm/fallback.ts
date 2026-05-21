/**
 * Provider Fallback Chain：主 provider 出现限流 / 服务不可用 / 鉴权失败时，
 * 依次降级到 chain 上的下一个 provider。每个 provider 只在「真错误」时被跳过——
 * 内容质量问题不应在这里降级（那是 eval 的事）。
 */
import { isProviderOutage } from './retry.js';
import { logger } from '../observability/logger.js';
import type { LLMCallArgs, LLMLike, LLMOnDelta, LLMResponse } from '../types.js';

export interface FallbackOpts {
  /** 第一个尝试的 provider 名（已实例化的 LLMLike） */
  primary: LLMLike;
  /** 备选 provider 链；按顺序尝试 */
  alternates: LLMLike[];
}

export class FallbackLLM implements LLMLike {
  readonly name: string;
  private chain: LLMLike[];

  constructor({ primary, alternates }: FallbackOpts) {
    this.chain = [primary, ...alternates];
    this.name = `fallback(${this.chain.map((p) => p.name).join('→')})`;
  }

  async chat(args: LLMCallArgs): Promise<LLMResponse> {
    return this._try((p) => p.chat(args), 'chat');
  }

  async stream(args: LLMCallArgs, onDelta?: LLMOnDelta): Promise<LLMResponse> {
    return this._try((p) => p.stream(args, onDelta), 'stream');
  }

  private async _try(call: (p: LLMLike) => Promise<LLMResponse>, op: string): Promise<LLMResponse> {
    let lastErr: unknown;
    for (let i = 0; i < this.chain.length; i++) {
      const p = this.chain[i];
      try {
        return await call(p);
      } catch (err) {
        const failover = isProviderOutage(err) && i < this.chain.length - 1;
        logger.warn(
          { provider: p.name, op, attempt: i, willFailover: failover, err: (err as Error)?.message },
          '[llm-fallback] provider 失败',
        );
        if (!failover) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }
}
