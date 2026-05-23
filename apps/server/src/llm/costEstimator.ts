/**
 * Token / 成本预估（E）：turn 开始前估这个任务大概要花多少钱。
 *
 * 思路：
 *   - 用 quickClassify 复杂度（low/medium/high）+ 历史平均（per provider 的 token/step）
 *   - 不调 LLM（避免双重成本）；纯启发式
 *   - 真跑完后对比 actual / estimated，写 logs 供调优
 */
import { quickClassify, type Complexity } from './router.js';
import { logger } from '../observability/logger.js';

export interface CostEstimate {
  complexity: Complexity | 'unknown';
  /** 估算 input + output tokens 总量 */
  estimatedTokens: number;
  /** 估算 USD（按当前 provider 定价） */
  estimatedUSD: number;
  /** 估算需要多少 step（ReAct 轮数） */
  estimatedSteps: number;
}

/** 各复杂度的经验值（基于实测中位数；可后续根据 actual 调） */
const PROFILE: Record<Complexity, { steps: number; tokensPerStep: number }> = {
  low:    { steps: 1, tokensPerStep: 800 },
  medium: { steps: 3, tokensPerStep: 1500 },
  high:   { steps: 8, tokensPerStep: 2500 },
};

/** 各 provider / model 的简化 input+output 混合价格（USD per 1M tokens；2026-05 估算） */
const PROVIDER_PRICE_PER_MTOKEN: Record<string, number> = {
  'mock':       0,
  'anthropic':  8.0,   // sonnet-4.6 input $3 + output $15 混合 ~$8
  'openai':     5.0,   // gpt-5-5 估算
  'deepseek':   1.0,
  'qwen':       2.0,
  'doubao':     1.5,
  'hunyuan':    2.0,
  'glm':        1.0,
  'kimi':       2.5,
};

export function estimateTaskCost(message: string, providerName: string): CostEstimate {
  const complexity = quickClassify(message) ?? 'medium';
  const profile = PROFILE[complexity];
  const tokens = profile.steps * profile.tokensPerStep;
  const pricePerMToken = PROVIDER_PRICE_PER_MTOKEN[providerName] ?? 3.0;
  const usd = (tokens / 1_000_000) * pricePerMToken;
  return {
    complexity,
    estimatedTokens: tokens,
    estimatedSteps: profile.steps,
    estimatedUSD: Math.round(usd * 100_000) / 100_000,    // 5 位小数
  };
}

/** turn 跑完后对比；超出 estimate 50% 时 warn */
export function compareActualVsEstimate(
  estimate: CostEstimate,
  actual: { tokens: number; usd: number; steps: number },
  context: { sessionId: string; provider: string },
): void {
  const ratio = estimate.estimatedTokens > 0 ? actual.tokens / estimate.estimatedTokens : 1;
  const level = ratio > 1.5 || ratio < 0.5 ? 'warn' : 'info';
  logger[level](
    { ...context, estimate, actual, ratio: Math.round(ratio * 100) / 100 },
    '[cost-estimator] actual vs estimate',
  );
}
