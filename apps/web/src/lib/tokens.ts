export const CONTEXT_WINDOW: Record<string, number> = {
  mock: 8_000,
  anthropic: 200_000,
  openai: 128_000,
  deepseek: 65_536,
};
export const DEFAULT_CTX_WINDOW = 32_000;

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + 'k';
  return Math.round(n / 1000) + 'k';
}
