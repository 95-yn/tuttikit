import type { Config } from 'tailwindcss';

const config: Config = {
  // 关掉 preflight，避免覆盖现有 globals.css 的极简重置
  corePlugins: { preflight: false },
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0a0a0c',
          1: '#131316',
          2: '#1a1a1f',
          3: '#22232a',
        },
        border: {
          DEFAULT: '#26272f',
          strong: '#32343d',
        },
        text: {
          DEFAULT: '#ECEDEE',
          dim: '#B6BAC5',
        },
        muted: {
          DEFAULT: '#8A8E99',
          2: '#5C606C',
        },
        accent: {
          DEFAULT: '#7C9CFF',
          soft: 'rgba(124,156,255,.14)',
          2: '#5EEAD4',
        },
        user: {
          tint: 'rgba(124,156,255,.10)',
        },
        ok: '#22C55E',
        warn: '#F5A524',
        error: '#EF4444',
      },
      fontFamily: {
        sans: [
          'Plus Jakarta Sans',
          '-apple-system',
          'BlinkMacSystemFont',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          '"Segoe UI"',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          '"SFMono-Regular"',
          'Menlo',
          'monospace',
        ],
      },
      borderRadius: {
        sm: '6px',
        md: '10px',
        lg: '14px',
        xl: '18px',
        '2xl': '22px',
      },
      boxShadow: {
        sm: '0 1px 2px rgba(0,0,0,.4)',
        md: '0 4px 12px rgba(0,0,0,.45)',
      },
    },
  },
  plugins: [],
};

export default config;
