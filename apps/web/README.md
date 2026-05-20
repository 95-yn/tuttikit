# @tuttikit/web

Multi-Agent 对话的 Web UI —— Next.js 15（App Router）+ TypeScript + Tailwind。

> 想找文件位置 → 项目根 [`STRUCTURE.md`](../../STRUCTURE.md) 「我想做 X」一键定位
>
> 想看 monorepo 总览 → 根目录 [`README.md`](../../README.md)

## 启动

```bash
# 从 monorepo 根
pnpm dev:web                                  # next dev -p 3000
pnpm --filter @tuttikit/web build
pnpm --filter @tuttikit/web start

# 生产模式（移动端测试推荐：bundle 小 4-5x，首屏快 5-10x）
pnpm --filter @tuttikit/web build
pnpm -r --parallel --stream start
```

监听 `http://localhost:3000`。需要后端在 `http://localhost:3001` 上跑（用 `pnpm dev` 一起启）。

## 与后端的桥

`next.config.ts` 把 `/api/*` rewrite 到 `process.env.NEXT_PUBLIC_BACKEND_URL || http://localhost:3001`：

| 前端调用 | 后端接收 |
| --- | --- |
| `GET /api/health` | `GET /health` |
| `GET /api/sessions` 等 | `GET /sessions` 等 |
| `GET /api/sessions/:id/stream?...` | SSE 透传 |
| `GET /api/events` | 全局广播 SSE |
| `POST /api/uploads` | 文件上传 |
| `GET /api/uploads/:id` | 文件回源 |

部署时把 `NEXT_PUBLIC_BACKEND_URL` 指到后端实际域名即可。

## 结构

```
src/
├── app/
│   ├── layout.tsx          # IconSprite + ChunkErrorReloader 全局挂载
│   ├── page.tsx            # ChatPage —— 顶层装配
│   ├── globals.css         # 设计 token + 所有样式（暗色 OLED）
│   └── api/lan-host/route.ts  # 给前端 QR 提供 LAN URL
├── components/
│   ├── IconSprite.tsx      # Lucide SVG sprite + <Icon /> helper
│   ├── Sidebar.tsx         # 会话列表（移动端抽屉）
│   ├── Topbar.tsx          # 标题 + Provider 切换 + CtxMeter
│   ├── CtxMeter.tsx
│   ├── EmptyState.tsx
│   ├── MessageBubble.tsx
│   ├── Markdown.tsx        # markdown + hljs + mermaid 懒载（IntersectionObserver）
│   ├── ToolBlock.tsx       # 工具调用折叠面板
│   ├── Composer.tsx        # 输入框 + paperclip + mic + dnd + paste
│   ├── AttachmentList.tsx  # 图片缩略图 / PDF 卡片
│   ├── QrFab.tsx           # 右下角 QR（移动端隐藏）
│   ├── ToastModalHost.tsx  # showConfirm / showToast 全局
│   └── ChunkErrorReloader.tsx  # chunk 失配自动 reload
├── hooks/
│   ├── useChat.ts          # SSE 流消费 + bubble/tool 状态
│   ├── useGlobalSync.ts    # /api/events 订阅 + visibility 重连
│   ├── useAttachments.ts   # 上传队列 + 预览
│   └── useVoiceInput.ts    # Web Speech API
└── lib/
    ├── api.ts              # fetch 封装
    ├── types.ts            # 与后端 types.ts 对齐
    ├── markdown.ts         # renderMarkdown / escapeHtml / nextMermaidId
    └── tokens.ts           # CONTEXT_WINDOW 各 provider 上下文窗口
```

完整文件清单 + 「想改 X 找哪里」见 [`STRUCTURE.md`](../../STRUCTURE.md)。

## 移动端相关设计

- **响应式**：≤720px 自动转汉堡 + 抽屉，触屏左滑关；触摸目标全部 ≥40×40
- **首屏优化**：删 Google Fonts CDN，走系统字体；mermaid IntersectionObserver 懒载
- **断流恢复**：`useGlobalSync` 监听 `visibilitychange`，iOS 切回前台主动重连；30s 心跳超时主动重连
- **Chunk 失配**：`ChunkErrorReloader` 自动 reload，杜绝 dev 模式白屏
- **QR 浮窗**：桌面端右下角浮窗显示 LAN URL 二维码，手机扫即进
- **CJK 文件名**：上传走 multer `defParamCharset: 'utf8'` + 客户端 latin1→utf8 兜底
