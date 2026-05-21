'use client';
import { useEffect } from 'react';

/**
 * 软键盘弹出时让 #app 跟随 visualViewport 收缩，避免 iOS Safari 把 composer 推出可视区。
 *
 * 实现：在 :root 上挂一个 CSS 变量 `--kb-offset`，等于 (window.innerHeight - visualViewport.height)
 * = 键盘高度。CSS 里关键容器（#app）的 `height` 用 `calc(100dvh - var(--kb-offset))`，
 * 这样键盘弹出 → app 高度收缩 → composer 自然停在键盘上方。
 *
 * 桌面 / 非 iOS 浏览器无 visualViewport.resize 事件，--kb-offset 始终 0，不影响 PC。
 */
export function useKeyboardAware(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb-offset', `${offset}px`);
    };
    update();

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.documentElement.style.removeProperty('--kb-offset');
    };
  }, []);
}
