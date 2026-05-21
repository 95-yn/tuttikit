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
| `GET /api/sessions/...` | session CRUD |
| `GET /api/sessions/:id/stream?...` | SSE 流式对话 |
| `GET /api/events` | 全局广播 SSE |
| `POST /api/uploads` 等 | 文件 |
| `GET /api/traces` 等 | trace + replay |
| `GET /api/skills` 等 | skills 列表 / 详情 / 翻译 |
| `GET /api/mcp` 等 | MCP server / tools / reconnect / 翻译 |
| `GET /api/memory` 等 | 长期记忆 |

部署时把 `NEXT_PUBLIC_BACKEND_URL` 指到后端实际域名即可。

## 结构

```
src/
├── app/
│   ├── layout.tsx              IconSprite + ChunkErrorReloader 全局挂载
│   ├── page.tsx                ChatPage —— 顶层装配
│   ├── globals.css             设计 token + 所有样式（暗色 + 亮色 + 系统）
│   ├── api/lan-host/route.ts   给前端 QR 提供 LAN URL
│   ├── skills/page.tsx         /skills 管理页（虚拟滚动 + 按需翻译 + 列表名翻译）
│   ├── mcp/page.tsx            /mcp 管理页（servers + tools + reconnect + 翻译）
│   └── traces/page.tsx         /traces 列表 + 详情 + Replay（A/B 多 provider）
├── components/
│   ├── IconSprite.tsx          Lucide SVG sprite + <Icon />
│   ├── Sidebar.tsx             会话列表（移动端抽屉）
│   ├── Topbar.tsx              标题 + Provider 切换 + Theme + 管理页入口 🧩🔌📊
│   ├── CtxMeter.tsx            上下文 / USD 显示 + 预算预警颜色
│   ├── EmptyState.tsx
│   ├── MessageBubble.tsx
│   ├── Markdown.tsx            markdown + hljs + mermaid 懒载
│   ├── ToolBlock.tsx           工具调用折叠面板
│   ├── Composer.tsx            输入 + 附件 + dnd + paste + voice + **`/` slash 命令**
│   ├── SlashMenu.tsx           `/` 触发面板：skills + mcp tools + 分组 + 键盘
│   ├── VirtualList.tsx         零依赖虚拟滚动（固定行高 + overscan + RAF 节流）
│   ├── AttachmentList.tsx      图片缩略图 / PDF 卡片
│   ├── QrFab.tsx               右下角 QR（移动端隐藏）
│   ├── ChatNotices.tsx         顶部浮层：budget / review / critique / plan 4 类通知
│   ├── ThemeToggle.tsx         dark / light / system 三态循环
│   ├── CommandPalette.tsx      Cmd+K 命令面板（fuzzy 搜会话 + provider + 操作）
│   ├── DebugPanel.tsx          ?debug=1 右下角浮窗调试
│   ├── ErrorBoundary.tsx
│   ├── ToastModalHost.tsx      showConfirm / showToast 全局
│   └── ChunkErrorReloader.tsx  chunk 失配自动 reload
├── hooks/
│   ├── useChat.ts              SSE 流消费 + bubbles + notices + budget 状态
│   ├── useGlobalSync.ts        /api/events 订阅 + visibility 重连 + 30s 心跳超时
│   ├── useAttachments.ts       上传队列 + 预览
│   ├── useVoiceInput.ts        Web Speech API
│   ├── useTheme.ts             dark / light / system 持久化
│   └── useKeyboardAware.ts     iOS VisualViewport API 软键盘
└── lib/
    ├── api.ts                  fetch 封装（含 getSessionBudget）
    ├── types.ts                与后端 types.ts 对齐
    ├── markdown.ts             renderMarkdown / escapeHtml / nextMermaidId
    ├── exportSession.ts        会话导出为 markdown / 复制
    └── tokens.ts               CONTEXT_WINDOW 各 provider 上下文窗口
```

完整文件清单 + 「想改 X 找哪里」见 [`STRUCTURE.md`](../../STRUCTURE.md)。

## 三个管理页

| 路径 | 干啥 | 关键交互 |
| --- | --- | --- |
| `/skills` | 看 / 翻译 50+ 个 skill | 列表虚拟滚动；`🌐 翻译成中文` 单 skill；`🏷 翻译列表名称` 批量；中英切换；`↻ Reload` 不重启进程 |
| `/mcp`    | MCP server + tools 管理 | servers 状态圆点；`↻ Reconnect` 单 server 重连不重启；翻译 tool descriptions |
| `/traces` | Trace 列表 + 详情树 | `↻ Replay` 单 provider；`↻ A/B Replay (N)` 多 provider 并发对比 `ABComparePanel` |

## 对话窗口里直接调 skill / MCP

输入框打 `/`：

- 弹下拉面板，列出全部 skills + MCP tools，分组
- 顶部 tab 切「全部 / Skills / MCP」缩小范围
- 实时过滤、`↑↓ Enter Esc` 键盘全套
- 选中 → 自动 inject `请使用 skill \`<name>\` 完成：|` 或 `请使用工具 \`<full-name>\` |`，光标停在 `|`

## 移动端相关设计

- **响应式**：≤720px 自动转汉堡 + 抽屉，触屏左滑关；触摸目标全部 ≥40×40
- **首屏优化**：删 Google Fonts CDN，走系统字体；mermaid IntersectionObserver 懒载
- **断流恢复**：`useGlobalSync` 监听 `visibilitychange`，iOS 切回前台主动重连；30s 心跳超时主动重连
- **Chunk 失配**：`ChunkErrorReloader` 自动 reload，杜绝 dev 模式白屏
- **QR 浮窗**：桌面端右下角浮窗显示 LAN URL 二维码，手机扫即进
- **CJK 文件名**：上传走 multer `defParamCharset: 'utf8'` + 客户端 latin1→utf8 兜底
- **虚拟滚动**：`VirtualList` 组件零依赖，固定行高 + overscan 5 + RAF 节流，scroll 60fps
- **rAF token 批处理**：`useChat` 把同帧到达的 SSE token 合并成一次 `setBubbles`，避免长回答 setState 风暴
- **过滤不阻塞**：`useDeferredValue` + `useTransition`，输入框打字时立即更新，过滤推到非紧急
