'use client';
import { useEffect } from 'react';

/**
 * 捕获 Next.js dev 模式下 chunk hash 失配导致的 "Loading chunk N failed"
 * → 自动一次 reload 拉新 HTML，避免用户卡在白屏/坏功能上。
 *
 * 防抖：用 sessionStorage 标志，10s 内只重试一次，避免无限刷新。
 */
export function ChunkErrorReloader() {
  useEffect(() => {
    const SHOULD_RELOAD_RE = /Loading chunk \d+ failed|ChunkLoadError|Failed to fetch dynamically imported module/i;
    const RECENT_KEY = 'mas:chunk-reload-at';
    const COOLDOWN_MS = 10_000;

    const maybeReload = (msg: string) => {
      if (!SHOULD_RELOAD_RE.test(msg)) return;
      const last = Number(sessionStorage.getItem(RECENT_KEY) || 0);
      if (Date.now() - last < COOLDOWN_MS) return;  // 冷却内不重复刷
      sessionStorage.setItem(RECENT_KEY, String(Date.now()));
      console.warn('[chunk-reload] 检测到 chunk 失配，自动 reload');
      location.reload();
    };

    const onError = (e: ErrorEvent) => maybeReload(e.message || '');
    const onUnhandled = (e: PromiseRejectionEvent) => {
      const reason = e.reason as { message?: string; name?: string } | string | undefined;
      const msg = typeof reason === 'string'
        ? reason
        : (reason?.message || reason?.name || '');
      maybeReload(String(msg));
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandled);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandled);
    };
  }, []);
  return null;
}
