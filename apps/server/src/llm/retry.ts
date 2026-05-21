/**
 * 通用 retry + 指数退避 + jitter，给 LLM API / 外部 fetch 用。
 *
 *   await withRetry(() => provider.chat(args), { retries: 3 });
 *
 * 默认只对 429 / 5xx / 网络层错误重试；超出 `retries` 抛原错。
 */

export interface RetryOpts {
  retries?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  /** 返回 true 表示可重试；默认走 isRetryable */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** 调试用：每次重试调一次 */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const {
    retries = 3,
    minDelayMs = 400,
    maxDelayMs = 8000,
    shouldRetry = isRetryable,
    onRetry,
  } = opts;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err, attempt)) throw err;
      const delay = Math.min(maxDelayMs, minDelayMs * 2 ** attempt) + Math.random() * 200;
      onRetry?.(err, attempt, delay);
      await sleep(delay);
      attempt++;
    }
  }
}

/** 429 / 5xx / 网络层 / fetch failed 视为可重试 */
export function isRetryable(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; status?: number; statusCode?: number; code?: string; message?: string };
  if (e.status && e.status === 429) return true;
  if (e.status && e.status >= 500 && e.status < 600) return true;
  if (e.statusCode && e.statusCode === 429) return true;
  if (e.statusCode && e.statusCode >= 500 && e.statusCode < 600) return true;
  if (e.code && /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED)$/.test(e.code)) return true;
  const msg = String(e.message || err);
  if (/\b(429|5\d{2})\b/.test(msg)) return true;
  if (/fetch failed|network|timeout|socket hang up/i.test(msg)) return true;
  return false;
}

/** 是否是限流 / 容量 / 临时不可用——值得换 provider 而不是死磕重试 */
export function isProviderOutage(err: unknown): boolean {
  if (!err) return false;
  const e = err as { status?: number; statusCode?: number; message?: string };
  const status = e.status || e.statusCode;
  if (status === 429) return true;
  if (status && status >= 500 && status < 600) return true;
  const msg = String(e.message || err);
  return /rate.?limit|overloaded|capacity|unavailable|quota/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
