import type { Metadata } from 'next';
import { IconSprite } from '@/components/IconSprite';
import { ChunkErrorReloader } from '@/components/ChunkErrorReloader';
import './globals.css';

export const metadata: Metadata = {
  title: 'TuttiKit',
  description: '可切换模型的多 Agent 协作框架',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
      </head>
      <body>
        <IconSprite />
        <ChunkErrorReloader />
        {children}
      </body>
    </html>
  );
}
