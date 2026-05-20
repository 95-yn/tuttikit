# TuttiKit

类 Claude / Codex 的对话式多 Agent 系统。**Monorepo** 拆分：

```
tuttikit/
└── apps/
    ├── server/   ← Express + Vercel AI SDK 多 Agent 后端（TypeScript）
    └── web/      ← Next.js 15 (App Router + TS + Tailwind) 前端
```

> ✨ **第一次来？** 看 [`SHOWCASE.md`](./SHOWCASE.md) —— 视觉版介绍（适合分享 / 第三方平台）
>
> 🎯 **能干啥 / 凭啥用我？** 查 [`OVERVIEW.md`](./OVERVIEW.md) —— 能力清单 + 对比优势 + 适合谁 + 路线图
>
> 📍 **改哪里？** 查 [`STRUCTURE.md`](./STRUCTURE.md) —— 按「我想做 X」直指文件
>
> 🔧 **后端怎么跑的？** 查 [`apps/server/ARCHITECTURE.md`](./apps/server/ARCHITECTURE.md) —— 模块详解 / Agent 协议 / Trace 设计

## 60 秒上手

```bash
# 一次性装好所有 workspace 依赖
pnpm install

# 给后端配 .env（可选，不配自动 fallback 到 mock provider）
cp apps/server/.env.example apps/server/.env

# 一键同启两端（带端口冲突保护 + LAN URL banner）
pnpm dev
#   → 后端 http://localhost:3001
#   → 前端 http://localhost:3000  ← 浏览器进这个
#   → 局域网 http://192.168.x.x:3000  ← 手机扫码用这个

# 或单独启
pnpm dev:server
pnpm dev:web

# 终端聊天 / 测试
pnpm chat
pnpm test
```

> Next.js 通过 `next.config.ts` 的 `rewrites` 把 `/api/*` 透传到 `http://localhost:3001/*`，避免开发期 CORS。
> 手机访问看页面右下角 QR，扫码即进。

## 端口约定

| 端口 | 服务 |
| --- | --- |
| 3000 | Next.js (apps/web) —— 前端 UI |
| 3001 | Express (apps/server) —— REST + SSE，提供 `/sessions`、`/traces`、`/memory`、`/uploads`、`/events`、`/health` |

后端默认开启 CORS 放行 `http://localhost:3000`，可在 `.env` 用 `CORS_ORIGINS` 覆盖（逗号分隔）。

## 系统能力

```
用户问任意问题
   ▼
┌──────────────────────────────────────────────────────────────┐
│  ConductorAgent —— 持有完整对话历史                          │
│                                                              │
│  每一步由 LLM 决定:                                          │
│    ├─ 直接回答（闲聊、概念解释）                             │
│    ├─ 调工具（calculator / web_search / file_system_*）      │
│    └─ 委派子 Agent:                                          │
│        ├─ delegate_to_researcher  （调研型问题）             │
│        ├─ delegate_to_coder       （写文件/代码）            │
│        └─ delegate_to_reviewer    （审查产出）               │
│                                                              │
│  子 Agent 内部又是一个 ReAct 循环，调用自己的工具子集         │
└──────────────────────────────────────────────────────────────┘
```

**节点数量与内容完全由 LLM 实时决定**，不是预设的固定阶段。简单问答 1 步搞定；调研+落地+审查会自动展开 3 层嵌套。

## 主要特性

- ✅ **多 Agent 委派**：Conductor + Researcher / Coder / Reviewer，sub-agent as tool
- ✅ **流式输出**：token 逐字浮现，可中断
- ✅ **多模型可切**：anthropic / openai / deepseek / mock，一行 `.env` 切换
- ✅ **多模态附件**：图片 + PDF 上传，PDF 文本抽取（pdf-parse）+ 图片 OCR（tesseract.js）
- ✅ **多设备同步**：PC 发消息 → 手机自动看到（SSE 全局广播）
- ✅ **手机扫码即进**：页面右下角 QR，扫描即访问
- ✅ **响应式**：≤720px 自动汉堡 + 抽屉，触屏左滑关闭
- ✅ **持久化**：会话 / Trace / 长期记忆全落本地 JSON，重启不丢
- ✅ **可观测**：自建 Trace/Span，每次 turn 完整记录在 `data/traces/`
- ✅ **零配置可跑**：无 API Key 时自动 fallback 到 MockProvider，整条流水线照常演示

## 接入真实模型

编辑 `apps/server/.env`：

```bash
# Claude（Anthropic）
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-6

# OpenAI
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# DeepSeek（通过 @ai-sdk/openai-compatible，绕开 v6 默认 Responses API 的坑）
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-chat
```

也可以在 Web UI 顶部下拉切换、或单次请求 `?provider=anthropic` 覆盖。

| Provider | 文本 | 图片 | PDF |
| --- | :-: | :-: | :-: |
| anthropic Claude 3.5+ | ✓ | 原生 ✓ | 原生 ✓ |
| openai gpt-4o | ✓ | 原生 ✓ | 抽取文本 |
| deepseek-chat | ✓ | OCR 文本 | 抽取文本 |
| mock | ✓ | 抽取文本 | 抽取文本 |

不支持原生多模态的 provider 会自动用 OCR/pdf-parse 的文本结果（带 `<attachment>` 标签包裹）作为提示注入。

## 关键 API（后端）

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/health` | 当前 provider |
| POST | `/sessions` | 新建会话 |
| GET | `/sessions` | 会话列表 |
| GET | `/sessions/:id` | 会话详情 |
| PATCH | `/sessions/:id` | 重命名 |
| DELETE | `/sessions/:id` | 删除 |
| GET | `/sessions/:id/stream?message=&attachmentIds=&provider=` | SSE 流式对话 |
| POST | `/uploads` | 单文件上传（multipart） |
| GET | `/uploads/:id` | 文件回源 |
| GET | `/events` | 全局广播 SSE（多设备同步） |
| GET | `/traces` / `/traces/:id` | trace 列表 / 详情 |
| GET | `/memory` / `/memory/search?q=` | 长期记忆 |

前端走 `/api/*` 由 Next.js rewrites 代理。

## 测试

```bash
pnpm test
# 三套：
#   - AI SDK 集成（消息映射、tool-call、流式）21 断言
#   - Conductor + 多轮 + delegate                12 断言
#   - Markdown / 代码块 / Mermaid                34 断言
```

---

**下一步**：

- 想改某个具体的东西 → [`STRUCTURE.md`](./STRUCTURE.md)
- 想理解后端是怎么跑的 → [`apps/server/ARCHITECTURE.md`](./apps/server/ARCHITECTURE.md)
- 后端 README → [`apps/server/README.md`](./apps/server/README.md)
- 前端 README → [`apps/web/README.md`](./apps/web/README.md)
