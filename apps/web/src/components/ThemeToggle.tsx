'use client';
import { useTheme, type Theme } from '@/hooks/useTheme';

const LABEL: Record<Theme, string> = {
  dark: '🌙 暗',
  light: '☀ 亮',
  system: '⚙ 跟随系统',
};

/**
 * 顶栏右侧的主题切换按钮：循环 dark → light → system
 */
export function ThemeToggle() {
  const { theme, cycle } = useTheme();
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycle}
      title={`主题：${LABEL[theme]}（点击切换）`}
      aria-label={`切换主题，当前 ${LABEL[theme]}`}
    >
      {LABEL[theme]}
    </button>
  );
}
