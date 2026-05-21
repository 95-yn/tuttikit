/**
 * 各 provider × model 的单价表（USD per 1M tokens）。
 * 半年校准一次，文档仅供参考，以官方账单为准。
 *
 * 来源（撰写时）：
 *   - Anthropic: https://www.anthropic.com/pricing#api （2025 Q4）
 *   - OpenAI:    https://openai.com/api/pricing
 *   - DeepSeek:  https://platform.deepseek.com/api-docs/pricing
 *
 * 注意：cacheReadInputTokens 通常按 10% 价计费（Anthropic），单独算。
 */

export interface ModelPricing {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cached input tokens（Anthropic 等支持 prompt cache 的 provider 用） */
  cacheRead?: number;
  /** USD per 1M cache-creation input tokens（写入缓存比常规略贵 25%） */
  cacheWrite?: number;
}

// key = `${provider}:${model}`；model 前缀匹配（claude-sonnet-4 适配 claude-sonnet-4-* 子版本）
export const PRICING_TABLE: Record<string, ModelPricing> = {
  // ── Anthropic ──
  'anthropic:claude-sonnet-4': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'anthropic:claude-opus-4':   { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'anthropic:claude-haiku-4':  { input: 0.80, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },

  // ── OpenAI ──
  'openai:gpt-4o':         { input: 2.5, output: 10.0 },
  'openai:gpt-4o-mini':    { input: 0.15, output: 0.60 },
  'openai:gpt-4.1':        { input: 2.0, output: 8.0 },
  'openai:gpt-4.1-mini':   { input: 0.40, output: 1.60 },

  // ── DeepSeek ──
  'deepseek:deepseek-chat':     { input: 0.27, output: 1.10 },
  'deepseek:deepseek-reasoner': { input: 0.55, output: 2.19 },

  // ── Mock：免费 ──
  'mock:mock': { input: 0, output: 0 },
};

export interface CostBreakdown {
  inputUSD: number;
  outputUSD: number;
  cacheReadUSD: number;
  cacheWriteUSD: number;
  totalUSD: number;
  pricing: ModelPricing | null;
}

export interface UsageWithCache {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export function priceFor(provider: string, model: string, usage: UsageWithCache): CostBreakdown {
  const pricing = lookup(provider, model);
  const empty: CostBreakdown = {
    inputUSD: 0, outputUSD: 0, cacheReadUSD: 0, cacheWriteUSD: 0, totalUSD: 0, pricing,
  };
  if (!pricing) return empty;
  const inUSD  = ((usage.inputTokens || 0) / 1_000_000) * pricing.input;
  const outUSD = ((usage.outputTokens || 0) / 1_000_000) * pricing.output;
  const crUSD  = ((usage.cacheReadInputTokens || 0) / 1_000_000) * (pricing.cacheRead ?? pricing.input);
  const cwUSD  = ((usage.cacheCreationInputTokens || 0) / 1_000_000) * (pricing.cacheWrite ?? pricing.input);
  return {
    inputUSD: inUSD,
    outputUSD: outUSD,
    cacheReadUSD: crUSD,
    cacheWriteUSD: cwUSD,
    totalUSD: inUSD + outUSD + crUSD + cwUSD,
    pricing,
  };
}

/** 容错查表：精确匹配优先；找不到则按 model 前缀（claude-sonnet-4-6 → claude-sonnet-4） */
function lookup(provider: string, model: string): ModelPricing | null {
  const exact = PRICING_TABLE[`${provider}:${model}`];
  if (exact) return exact;
  // 前缀匹配，最长前缀优先
  let bestKey: string | null = null;
  for (const k of Object.keys(PRICING_TABLE)) {
    const prefix = `${provider}:`;
    if (!k.startsWith(prefix)) continue;
    const tail = k.slice(prefix.length);
    if (model.startsWith(tail) && (!bestKey || tail.length > bestKey.length)) {
      bestKey = tail;
    }
  }
  return bestKey ? PRICING_TABLE[`${provider}:${bestKey}`] : null;
}
