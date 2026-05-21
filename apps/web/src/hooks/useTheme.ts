'use client';
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light' | 'system';

const KEY = 'mas:theme';

function resolve(t: Theme): 'dark' | 'light' {
  if (t === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return t;
}

/**
 * 主题持久化 + 应用到 document：
 *   - 'dark' / 'light' / 'system'（跟随系统）
 *   - 写到 localStorage 持久；reload 不闪
 *   - 应用到 <html data-theme="...">，CSS [data-theme="light"] 覆盖 :root
 */
export function useTheme(): {
  theme: Theme;
  resolved: 'dark' | 'light';
  setTheme: (t: Theme) => void;
  cycle: () => void;          // 三态循环：dark → light → system → dark
} {
  const [theme, setThemeState] = useState<Theme>('dark');
  const [resolved, setResolved] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const saved = (localStorage.getItem(KEY) as Theme | null) || 'system';
    setThemeState(saved);
  }, []);

  useEffect(() => {
    const r = resolve(theme);
    setResolved(r);
    if (r === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', r === 'light' ? '#FAFAFB' : '#0a0a0c');
  }, [theme]);

  // theme === 'system' 时跟随系统切换
  useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handle = () => setResolved(mq.matches ? 'light' : 'dark');
    mq.addEventListener?.('change', handle);
    return () => mq.removeEventListener?.('change', handle);
  }, [theme]);

  // resolved 改了重新应用到 DOM（system 切换时）
  useEffect(() => {
    if (resolved === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }, [resolved]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    localStorage.setItem(KEY, t);
  }, []);

  const cycle = useCallback(() => {
    const order: Theme[] = ['dark', 'light', 'system'];
    const i = order.indexOf(theme);
    setTheme(order[(i + 1) % order.length]);
  }, [theme, setTheme]);

  return { theme, resolved, setTheme, cycle };
}
