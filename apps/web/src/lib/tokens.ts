/**
 * 各 provider × model 的 context window 上限（tokens）。
 * 查找顺序：精确匹配 → provider:<model前缀> → provider 兜底 → DEFAULT_CTX_WINDOW。
 * 半年校准一次，文档仅供参考，以官方为准。
 */
export const CONTEXT_WINDOW: Record<string, number> = {
  // ── Anthropic（Claude 4 系列均 200k）──
  'anthropic:claude-opus-4':    200_000,
  'anthropic:claude-sonnet-4':  200_000,
  'anthropic:claude-haiku-4':   200_000,
  // 旧的也兼容
  'anthropic:claude-3-5-sonnet': 200_000,
  'anthropic:claude-3-5-haiku':  200_000,

  // ── OpenAI ──
  'openai:gpt-4o':              128_000,
  'openai:gpt-4o-mini':         128_000,
  'openai:gpt-4.1':           1_047_576,
  'openai:gpt-4.1-mini':      1_047_576,
  'openai:o1':                  200_000,
  'openai:o3-mini':             200_000,

  // ── DeepSeek（V3 系列 128k；R1 64k）──
  'deepseek:deepseek-chat':     128_000,
  'deepseek:deepseek-reasoner':  64_000,

  // ── Mock ──
  'mock:mock':                    8_000,
  mock:                           8_000,

  // ── Provider 兜底（不知道 model 时用）──
  anthropic: 200_000,
  openai:    128_000,
  deepseek:  128_000,
};

export const DEFAULT_CTX_WINDOW = 32_000;

/**
 * 查 context window：先按 `provider:model` 精确；不中就按 `provider:<前缀>` 取最长匹配；
 * 还不中走 `provider` 兜底；最后到 DEFAULT_CTX_WINDOW。
 * 例：getContextWindow('anthropic','claude-sonnet-4-6') → 命中 'anthropic:claude-sonnet-4' 前缀，返 200000
 */
export function getContextWindow(provider: string, model?: string): number {
  if (model) {
    const exact = CONTEXT_WINDOW[`${provider}:${model}`];
    if (exact) return exact;
    let bestKey: string | null = null;
    const prefix = `${provider}:`;
    for (const k of Object.keys(CONTEXT_WINDOW)) {
      if (!k.startsWith(prefix)) continue;
      const tail = k.slice(prefix.length);
      if (model.startsWith(tail) && (!bestKey || tail.length > bestKey.length)) {
        bestKey = tail;
      }
    }
    if (bestKey) return CONTEXT_WINDOW[`${provider}:${bestKey}`];
  }
  return CONTEXT_WINDOW[provider] ?? DEFAULT_CTX_WINDOW;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}
