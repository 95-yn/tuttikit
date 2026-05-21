import type { Metadata } from 'next';
import { IconSprite } from '@/components/IconSprite';
import { ChunkErrorReloader } from '@/components/ChunkErrorReloader';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import './globals.css';

export const metadata: Metadata = {
  title: 'TuttiKit',
  description: '可切换模型的多 Agent 协作框架',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        {/* viewport-fit=cover 启用 env(safe-area-inset-*) ：iPhone 刘海 + 底部 home bar 不再压住内容 */}
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
        <meta name="theme-color" content="#0a0a0c" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body>
        <IconSprite />
        <ChunkErrorReloader />
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
    </html>
  );
}
