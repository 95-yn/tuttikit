/**
 * BudgetGuard —— 单进程级的 token / USD 预算守卫，防止失控任务把账户跑爆。
 *
 *   beforeTurn(sessionId)              // 进入新一轮前检查
 *   afterTurn(sessionId, usage, name)  // 一轮结束累加，超阈值时 emit 警告
 *
 * 不持久化（重启清零）。生产环境改用 Redis / KV 即可。
 */
import { config } from '../config.js';
import { priceFor, type UsageWithCache } from '../llm/pricing.js';
import { logger } from '../observability/logger.js';

export class BudgetExceededError extends Error {
  constructor(public scope: 'session' | 'day' | 'turn', public detail: string) {
    super(`budget exceeded (${scope}): ${detail}`);
    this.name = 'BudgetExceededError';
  }
}

interface SessionAcc {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalUSD: number;
  turns: number;
}

export interface BudgetWarning {
  scope: 'session' | 'day';
  sessionId?: string;
  usd: number;
  cap: number;
  ratio: number;
}

export interface BudgetCaps {
  enabled: boolean;
  perSessionMaxUSD: number;
  perSessionMaxTokens: number;
  perDayMaxUSD: number;
}

export class BudgetGuard {
  private sessions = new Map<string, SessionAcc>();
  private day = { date: today(), totalUSD: 0 };
  private warned = new Set<string>();  // 单次会话只 warn 一次
  /**
   * 可选 caps 覆盖（测试用）；不传则每次都读 config.budget（保持热更新支持）。
   */
  private capsOverride: BudgetCaps | null;

  constructor(caps?: Partial<BudgetCaps>) {
    this.capsOverride = caps
      ? { ...config.budget, ...caps }
      : null;
  }

  private _caps(): BudgetCaps {
    return this.capsOverride ?? config.budget;
  }

  /** 进入新一轮前调用，超额抛错 */
  beforeTurn(sessionId: string): void {
    this._maybeRotateDay();
    const cap = this._caps();
    if (!cap.enabled) return;

    if (this.day.totalUSD >= cap.perDayMaxUSD) {
      throw new BudgetExceededError('day', `${this.day.totalUSD.toFixed(4)} >= ${cap.perDayMaxUSD}`);
    }
    const s = this.sessions.get(sessionId);
    if (s && s.totalUSD >= cap.perSessionMaxUSD) {
      throw new BudgetExceededError('session', `${s.totalUSD.toFixed(4)} >= ${cap.perSessionMaxUSD}`);
    }
    if (s && (s.inputTokens + s.outputTokens) >= cap.perSessionMaxTokens) {
      throw new BudgetExceededError(
        'session',
        `${s.inputTokens + s.outputTokens} tokens >= ${cap.perSessionMaxTokens}`,
      );
    }
  }

  /** 一轮结束累加，返回本轮 USD 和阈值警告（若有） */
  afterTurn(
    sessionId: string,
    usage: UsageWithCache,
    providerName: string,
    modelName: string,
  ): { turnUSD: number; sessionUSD: number; dayUSD: number; warn: BudgetWarning | null } {
    this._maybeRotateDay();
    const cost = priceFor(providerName, modelName, usage);
    const s = this.sessions.get(sessionId) ?? {
      inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
      totalUSD: 0, turns: 0,
    };
    s.inputTokens             += usage.inputTokens || 0;
    s.outputTokens            += usage.outputTokens || 0;
    s.cacheReadInputTokens    += usage.cacheReadInputTokens || 0;
    s.cacheCreationInputTokens += usage.cacheCreationInputTokens || 0;
    s.totalUSD                += cost.totalUSD;
    s.turns++;
    this.sessions.set(sessionId, s);
    this.day.totalUSD += cost.totalUSD;

    const cap = this._caps();
    let warn: BudgetWarning | null = null;
    if (cap.enabled) {
      const sessionRatio = s.totalUSD / cap.perSessionMaxUSD;
      const dayRatio = this.day.totalUSD / cap.perDayMaxUSD;
      if (sessionRatio >= 0.8 && !this.warned.has(`s:${sessionId}`)) {
        warn = { scope: 'session', sessionId, usd: s.totalUSD, cap: cap.perSessionMaxUSD, ratio: sessionRatio };
        this.warned.add(`s:${sessionId}`);
        logger.warn(warn, '[budget] 会话花费接近上限');
      } else if (dayRatio >= 0.8 && !this.warned.has(`d:${this.day.date}`)) {
        warn = { scope: 'day', usd: this.day.totalUSD, cap: cap.perDayMaxUSD, ratio: dayRatio };
        this.warned.add(`d:${this.day.date}`);
        logger.warn(warn, '[budget] 当日花费接近上限');
      }
    }
    return { turnUSD: cost.totalUSD, sessionUSD: s.totalUSD, dayUSD: this.day.totalUSD, warn };
  }

  /** 测试 / 管理用 */
  getSessionStats(sessionId: string): SessionAcc | null {
    return this.sessions.get(sessionId) ?? null;
  }
  getDayStats(): { date: string; totalUSD: number } {
    return { ...this.day };
  }
  reset(): void {
    this.sessions.clear();
    this.day = { date: today(), totalUSD: 0 };
    this.warned.clear();
  }

  private _maybeRotateDay(): void {
    const t = today();
    if (this.day.date !== t) {
      this.day = { date: t, totalUSD: 0 };
      this.warned.clear();
    }
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export const budgetGuard = new BudgetGuard();
