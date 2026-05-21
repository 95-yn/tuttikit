# 项目结构 · 一键定位

按「**我想做 X**」→「**改这些文件**」组织，⌘F 搜你的需求关键词即可。

---

## 🗺️ 整体地图

```
tuttikit/
├── README.md                          # 60 秒上手
├── STRUCTURE.md                       # 你正在看的这个
├── package.json                       # monorepo 根脚本（pnpm dev / build / test）
├── pnpm-workspace.yaml                # workspaces 定义（apps/*）
├── .gitignore
│
├── scripts/
│   └── dev.mjs                        # pnpm dev 的入口：端口冲突保护 + LAN banner
│
├── apps/
│   ├── server/                        # ── 后端：Express + Vercel AI SDK ──
│   │   ├── README.md
│   │   ├── ARCHITECTURE.md            # 后端模块详解（Conductor / 工具 / Trace 等）
│   │   ├── tsconfig.json              # NodeNext + strict + noEmit (tsx 直跑)
│   │   ├── .env.example
│   │   ├── data/                      # 运行时持久化（gitignored）
│   │   │   ├── sessions/<id>.json
│   │   │   ├── traces/<id>.json
│   │   │   ├── uploads/<id>.{png|pdf} + <id>.json (元数据)
│   │   │   └── long_term_memory.json
│   │   ├── examples/                  # 测试套件（67 断言）
│   │   │   ├── test-aisdk-integration.ts
│   │   │   ├── test-conductor.ts
│   │   │   └── test-markdown.ts
│   │   └── src/
│   │       ├── server.ts              # HTTP 入口（Express + 路由）
│   │       ├── cli.ts                 # 终端聊天入口
│   │       ├── config.ts              # 环境变量集中处
│   │       ├── types.ts               # 共享 TS 类型（Message/Session/Attachment/...）
│   │       ├── agents/                # ↓ 各 Agent ↓
│   │       │   ├── base.ts            # ReAct 循环（被 sub-agent 继承）
│   │       │   ├── conductor.ts       # 主对话 Agent（持有 session）
│   │       │   ├── researcher.ts      # 子 Agent · 调研
│   │       │   ├── coder.ts           # 子 Agent · 写文件
│   │       │   ├── reviewer.ts        # 子 Agent · 审查
│   │       │   └── index.ts
│   │       ├── prompts/               # ↓ 所有 system prompt 集中 ↓
│   │       │   ├── builder.ts         # PromptBuilder 链式 API
│   │       │   ├── fragments.ts       # 原子片段 + RULE_* 复用规则
│   │       │   └── index.ts           # buildConductorPrompt() 等
│   │       ├── llm/                   # ↓ LLM Provider 抽象 ↓
│   │       │   ├── base.ts            # LLMLike 接口
│   │       │   ├── aisdk.ts           # 走 Vercel AI SDK：anthropic/openai/deepseek
│   │       │   ├── mock.ts            # 离线剧本（无 API Key 也能跑）
│   │       │   └── index.ts           # createLLM(provider)
│   │       ├── tools/                 # ↓ Conductor / 子 Agent 可用的工具 ↓
│   │       │   ├── registry.ts        # ToolRegistry + 权限隔离
│   │       │   ├── calculator.ts
│   │       │   ├── fileSystem.ts      # 项目目录内读写
│   │       │   ├── webSearch.ts       # 离线知识库（生产换 Tavily/Serper）
│   │       │   ├── delegate.ts        # makeDelegateTool() —— 把 sub-agent 包成工具
│   │       │   └── index.ts           # buildToolRegistryWithSubAgents()
│   │       ├── skills/                # ↓ 本地工作流指南（Claude Code 兼容）↓
│   │       │   ├── loader.ts          # 扫 .claude/skills/*/SKILL.md
│   │       │   ├── tools.ts           # find_skills / invoke_skill 工具
│   │       │   └── types.ts
│   │       ├── mcp/                   # ↓ Model Context Protocol 客户端 ↓
│   │       │   ├── manager.ts         # 连 .mcp.json 配置的 server，注册工具
│   │       │   └── types.ts
│   │       ├── memory/
│   │       │   ├── shortTerm.ts       # sub-agent 一次 run 的滑动窗口
│   │       │   └── longTerm.ts        # 跨会话沉淀（关键词检索 + 时间衰减）
│   │       ├── core/
│   │       │   ├── session.ts         # SessionManager: CRUD + 落盘
│   │       │   ├── messageBus.ts      # 一次 turn 内部事件中枢
│   │       │   ├── broadcaster.ts     # 全局广播 → 多设备同步（/events）
│   │       │   ├── uploads.ts         # 文件上传 + 元数据落盘
│   │       │   └── parsers.ts         # PDF / OCR 解析（pdf-parse + tesseract.js）
│   │       ├── observability/
│   │       │   ├── logger.ts          # pino + pino-pretty
│   │       │   └── tracer.ts          # 自建 Trace/Span，落 data/traces/
│   │       └── streaming/
│   │           └── sse.ts             # bus 事件 → SSE 文本流
│   │
│   └── web/                           # ── 前端：Next.js 15 + App Router ──
│       ├── README.md
│       ├── next.config.ts             # rewrites: /api/* → backend
│       ├── tsconfig.json
│       ├── tailwind.config.ts         # 设计 token 镜像
│       ├── public/
│       └── src/
│           ├── app/
│           │   ├── layout.tsx         # IconSprite + ChunkErrorReloader 全局挂载
│           │   ├── page.tsx           # ChatPage —— 顶层装配
│           │   ├── globals.css        # 设计 token + 所有样式（暗色 OLED）
│           │   └── api/
│           │       └── lan-host/
│           │           └── route.ts   # 给前端 QR 提供 LAN URL
│           ├── components/            # ↓ React 组件 ↓
│           │   ├── IconSprite.tsx     # Lucide SVG sprite（所有 <Icon name="..." />）
│           │   ├── Sidebar.tsx        # 会话列表（移动端抽屉）
│           │   ├── Topbar.tsx         # 标题 + Provider 下拉 + CtxMeter
│           │   ├── CtxMeter.tsx       # 上下文 token 进度条
│           │   ├── EmptyState.tsx
│           │   ├── MessageBubble.tsx  # 单条消息气泡
│           │   ├── Markdown.tsx       # md 渲染 + hljs + mermaid 懒载
│           │   ├── ToolBlock.tsx      # 工具调用折叠面板
│           │   ├── Composer.tsx       # 输入框 + paperclip + mic + dnd + paste
│           │   ├── AttachmentList.tsx # 图片缩略图 / PDF 卡片
│           │   ├── QrFab.tsx          # 右下角 QR 浮窗（移动端隐藏）
│           │   ├── ToastModalHost.tsx # showConfirm / showToast 全局
│           │   └── ChunkErrorReloader.tsx  # chunk 失配自动 reload
│           ├── hooks/                 # ↓ 状态机 + 副作用 ↓
│           │   ├── useChat.ts         # SSE 流消费 + bubble/tool 状态
│           │   ├── useGlobalSync.ts   # /api/events 订阅 + visibility 重连
│           │   ├── useAttachments.ts  # 上传队列 + 预览
│           │   └── useVoiceInput.ts   # Web Speech API
│           └── lib/
│               ├── api.ts             # fetch 封装（listSessions / uploadFile / streamUrl）
│               ├── types.ts           # 与后端 types.ts 对齐
│               ├── markdown.ts        # renderMarkdown（与后端 test-markdown 对齐）
│               └── tokens.ts          # CONTEXT_WINDOW 各 provider 上下文窗口
```

---

## 🎯 「我想…」一键定位

### 🤖 Agent / Prompt

| 想做 | 改哪些文件 |
| --- | --- |
| 改 Conductor 的 prompt | `apps/server/src/prompts/fragments.ts` 的 `CONDUCTOR_IDENTITY/TOOLS/RULES` |
| 改子 Agent（researcher/coder/reviewer）的 prompt | 同上 `RESEARCHER_*` / `CODER_*` / `REVIEWER_*` |
| 加一条所有 Agent 共享的规则 | `fragments.ts` 顶部加 `RULE_XXX = [title, body]`，在 `CONDUCTOR_RULES` 模板里用 `${renderRule(RULE_XXX)}` 引用 |
| 加新的子 Agent（如 Translator） | 1) 新建 `agents/translator.ts` 继承 `BaseAgent`；2) `agents/index.ts` 导出；3) `prompts/fragments.ts` + `prompts/index.ts` 加 `buildTranslatorPrompt()`；4) `tools/index.ts` 里 `makeDelegateTool({ name:'delegate_to_translator', agent:translator })` |
| 改 Agent 的 ReAct 循环（最大步数、记忆窗口等） | `apps/server/src/agents/base.ts` 的 `BaseAgent`；Conductor 是 `conductor.ts`（独立实现） |

### 🔧 工具

| 想做 | 改哪些文件 |
| --- | --- |
| 加新工具 | 1) `apps/server/src/tools/myTool.ts` 实现 `ToolSpec`；2) `tools/index.ts` 的 `buildToolRegistryWithSubAgents()` 里 `reg.register({...myTool, allowedAgents:['conductor', ...]})` |
| 改工具权限（哪个 Agent 能用） | `tools/index.ts` 里对应 `allowedAgents` 数组 |
| 让 `web_search` 接真实搜索 API | 替换 `tools/webSearch.ts` 的 `handler`（Tavily/Serper/Bing） |
| 调 `calculator` 的安全策略 | `tools/calculator.ts` 的正则白名单 |

### 📚 Skills（本地工作流指南）

| 想做 | 改哪些文件 |
| --- | --- |
| 加一个新 skill | 新建 `.claude/skills/<name>/SKILL.md`（项目级）或 `~/.claude/skills/<name>/SKILL.md`（全局），frontmatter 至少 `name` + `description`，正文 markdown |
| 改 `find_skills` / `invoke_skill` 工具描述 | `apps/server/src/skills/tools.ts` |
| 改 skill 检索打分逻辑（关键词 → 向量等） | `apps/server/src/skills/loader.ts` 的 `search()` |
| 改 skill 在 Conductor system prompt 里的呈现方式 | `apps/server/src/agents/conductor.ts` 末尾的 `skillsHint()` |
| 查当前已加载哪些 skill | `curl http://localhost:3001/skills` |
| 调试 skill 加载失败 | `apps/server/src/skills/loader.ts` 的 `parseSkill()`，warn 日志在 server 启动日志里 |

### 🔌 MCP（外部工具接入）

| 想做 | 改哪些文件 |
| --- | --- |
| 接入一个新的 MCP server | 在 `<project>/.mcp.json` 或 `~/.claude/mcp.json` 的 `mcpServers` 里加一项；范例见 `.mcp.json.example` |
| 改 MCP 工具命名规则（默认 `mcp__server__tool`） | `apps/server/src/mcp/manager.ts` 顶部 `TOOL_PREFIX` |
| 改 MCP 调用超时（默认 30s） | `apps/server/src/mcp/manager.ts` 的 `CALL_TIMEOUT_MS` |
| 改 MCP 工具的 agent 权限（默认仅 conductor） | `mcp/manager.ts` 里 spec 的 `allowedAgents` |
| 查 MCP server 连接状态 | `curl http://localhost:3001/mcp` |
| 加新传输类型（如 websocket） | `mcp/manager.ts` 的 `connectServer()` 加 `if (cfg.ws)` 分支 + `@modelcontextprotocol/sdk/client/websocket.js` |

### 🧠 LLM Provider

| 想做 | 改哪些文件 |
| --- | --- |
| 切换默认 provider | `apps/server/.env` 的 `LLM_PROVIDER`（anthropic/openai/deepseek/mock） |
| 改 API Key / Model | `apps/server/.env` 对应 `*_API_KEY` / `*_MODEL` |
| 接入新 provider（如智谱/通义） | `llm/aisdk.ts` 的 `createAISDKModel()` 加 `case`；**第三方 OpenAI 兼容厂商一律用 `@ai-sdk/openai-compatible`**，不要用 `createOpenAI({baseURL})`（v6 默认 Responses API 多数不兼容） |
| 改 provider 多模态支持矩阵（图/PDF） | `llm/aisdk.ts` 顶部 `PROVIDER_CAPS` 表 |
| 改 mock provider 的回答剧本 | `llm/mock.ts` 的各 role 分支 |
| 改流式失败 fallback 策略 | `llm/aisdk.ts` 的 `isFallbackableStreamError()` |

### 📨 SSE / 事件 / 多设备同步

| 想做 | 改哪些文件 |
| --- | --- |
| 加新的 SSE 事件类型 | 1) 后端 `streaming/sse.ts` 的 `EVENTS` 数组；2) 后端发事件的地方 `bus.emit(...)`；3) 前端 `hooks/useChat.ts` 加 `es.addEventListener(...)` |
| 加全局广播事件（CRUD 类） | `core/broadcaster.ts` 加方法，`server.ts` 对应 handler 里 emit，前端 `hooks/useGlobalSync.ts` 加 listener |
| 改广播心跳间隔 / 重连阈值 | 前端 `useGlobalSync.ts` 的 `30_000`；后端 `server.ts` `/events` 路由的 `15_000` |

### 📁 会话 / 持久化

| 想做 | 改哪些文件 |
| --- | --- |
| 改 session JSON 落盘路径 | `core/session.ts` 顶部 `SESSIONS_DIR` |
| 改 session schema（加字段） | `apps/server/src/types.ts` 的 `Session` / `Message` + 前端 `apps/web/src/lib/types.ts` 对应字段 |
| 多用户隔离 | `core/session.ts` 加 `userId` 维度，文件路径 `data/sessions/<userId>/<id>.json` |
| 改长期记忆检索（换向量库） | `memory/longTerm.ts` 的 `search()`，把关键词打分换成 embedding + cosine |

### 📎 文件上传 / 解析

| 想做 | 改哪些文件 |
| --- | --- |
| 改允许的文件类型 | `core/uploads.ts` 的 `ALLOWED_IMAGE` / `ALLOWED_PDF` 正则 |
| 改文件大小上限 | `core/uploads.ts` 的 `MAX_BYTES`（默认 25MB） |
| 改 OCR 语言 | `core/parsers.ts` 的 `createWorker(['eng', 'chi_sim'])` |
| 改 PDF/OCR 超时 | `core/parsers.ts` 的 `EXTRACT_TIMEOUT_MS` |
| 改抽取文本最大保留长度 | `core/parsers.ts` 的 `MAX_KEPT_CHARS` |
| 改前端预览样式 | `apps/web/src/components/AttachmentList.tsx` + `globals.css` 搜 `.att-*` |

### 🎨 前端 UI / 样式

| 想做 | 改哪些文件 |
| --- | --- |
| 改全局颜色 / 字体 / 间距 | `apps/web/src/app/globals.css` 顶部的 `:root` CSS 变量 |
| 改某个组件外观 | `globals.css` 里搜对应类名（`.sidebar`, `.msg`, `.composer`, `.tool-block`, `.att-*`, `.qr-fab` 等） |
| 移动端断点调整 | `globals.css` 末尾 `@media (max-width: 720px)` 与 `(max-width: 380px)` 块 |
| 加新图标 | `components/IconSprite.tsx` 加 `<symbol id="i-xxx">`，`IconName` 联合类型加一条，用 `<Icon name="i-xxx" />` |
| 改对话气泡布局 / Markdown 渲染 | `components/MessageBubble.tsx` + `components/Markdown.tsx` |
| 改输入框 / 上传 / 语音 | `components/Composer.tsx`，附件状态在 `hooks/useAttachments.ts` |
| 改 Toast / 确认弹窗 | `components/ToastModalHost.tsx`，业务代码用 `showConfirm()` / `showToast()` |
| 改 QR 浮窗 | `components/QrFab.tsx` + `globals.css` 搜 `.qr-fab` |

### 🌐 HTTP API

| 想做 | 改哪些文件 |
| --- | --- |
| 加新 REST endpoint | `apps/server/src/server.ts` 加 `app.get/post(...)`；前端 `apps/web/src/lib/api.ts` 加 fetch 函数 |
| 改前端代理规则 | `apps/web/next.config.ts` 的 `rewrites()` |
| 改 CORS 放行域 | `apps/server/.env` 的 `CORS_ORIGINS`（逗号分隔），默认仅 `http://localhost:3000` |
| 改端口 | `apps/server/.env` 的 `PORT`（默认 3001）；前端写死 3000 见 `apps/web/package.json` 与 `scripts/dev.mjs` |

### 🛠️ 启动 / 开发体验

| 想做 | 改哪些文件 |
| --- | --- |
| 改 `pnpm dev` 行为（端口检查 / banner） | `scripts/dev.mjs` |
| 加 / 改自动重启逻辑 | `apps/server/package.json` 的 `dev` 脚本（`tsx watch`） |
| 改启动 banner 内容 | `scripts/dev.mjs` 的 `printBanner()` |
| 改 dev chunk 失配处理 | `apps/web/src/components/ChunkErrorReloader.tsx`（默认 10s 内只刷一次） |

### 🔍 可观测 / Debug

| 想做 | 改哪些文件 |
| --- | --- |
| 改日志级别 | `apps/server/.env` 的 `LOG_LEVEL`（trace/debug/info/warn/error） |
| 改 Trace 持久化路径 | `observability/tracer.ts` 的 `TRACE_DIR` |
| 查看一次 turn 的 trace | 浏览器开 `http://localhost:3001/traces/<id>` 或 `/traces` 看列表 |
| 移动端调试 | URL 加 `?debug=1`（需要先 `pnpm --filter @tuttikit/web add vconsole` 并在 layout 里挂载） |

### 📦 依赖 / 工程

| 想做 | 命令 |
| --- | --- |
| 给后端加包 | `pnpm --filter @tuttikit/server add <pkg>` |
| 给前端加包 | `pnpm --filter @tuttikit/web add <pkg>` |
| 给前端加 dev 依赖 | `pnpm --filter @tuttikit/web add -D <pkg>` |
| 整 monorepo 重装 | `pnpm install` |

---

## 🚀 运行 / 测试

```bash
# 一键起前后端（含端口冲突保护 + LAN URL banner）
pnpm dev

# 单独启
pnpm dev:server                 # tsx watch（自动重启）
pnpm dev:web                    # next dev

# 生产模式（移动端测试推荐）
pnpm --filter @tuttikit/web build
pnpm -r --parallel --stream start

# 终端聊天
pnpm chat                       # 新会话
pnpm chat -- --session <id>     # 继续已有会话
pnpm chat -- --provider mock "帮我算 1+1"  # 单次问答

# 后端测试（67 断言）
pnpm test

# 后端 TS 类型检查
pnpm --filter @tuttikit/server typecheck
```

---

## 🔌 后端核心数据流

```
HTTP / SSE
  ↓
server.ts (Express)
  ├─ POST /sessions          → sessionManager.create
  ├─ GET  /sessions/:id/stream → 创建 MessageBus + Conductor → respond()
  │                                                    ↓
  │                              ┌──────────────────────────────┐
  │                              │  ConductorAgent.respond()    │
  │                              │   loop {                     │
  │                              │     LLM.stream(messages,tools)│
  │                              │     ├─ 直接回答 → break        │
  │                              │     └─ toolCalls → invoke each │
  │                              │              ├─ calculator   │
  │                              │              ├─ web_search   │
  │                              │              ├─ file_*       │
  │                              │              └─ delegate_*   │
  │                              │                  → 子 Agent  │
  │                              │   }                          │
  │                              └──────────────────────────────┘
  ├─ POST /uploads           → multer + parsers.extractByKind
  └─ GET  /events            → 全局广播 SSE（多设备同步）

bus 事件 → SSE 写回浏览器 → useChat.ts 渲染
broadcaster 事件 → /events 长连接 → useGlobalSync.ts 触发刷新
```

更深入的设计：[`apps/server/ARCHITECTURE.md`](./apps/server/ARCHITECTURE.md)

---

## 🔑 配置一览（`.env`）

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `LLM_PROVIDER` | `mock` | 默认 LLM（anthropic/openai/deepseek/mock） |
| `ANTHROPIC_API_KEY` | — | Claude key |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` |  |
| `OPENAI_API_KEY` | — |  |
| `OPENAI_MODEL` | `gpt-4o-mini` |  |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` |  |
| `DEEPSEEK_API_KEY` | — |  |
| `DEEPSEEK_MODEL` | `deepseek-chat` |  |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` |  |
| `PORT` | `3001` | 后端端口 |
| `LOG_LEVEL` | `info` | pino 日志级别 |
| `CORS_ORIGINS` | `http://localhost:3000,...` | 逗号分隔的放行 origin |
| `LONG_TERM_MEMORY_PATH` | `./data/long_term_memory.json` | 长期记忆存储 |
| `SHORT_TERM_MAX_TURNS` | `20` | 子 Agent 短期记忆窗口 |

前端的 `NEXT_PUBLIC_BACKEND_URL` 可在 `apps/web/.env.local` 设置（部署到非 localhost 后端时用），默认走 `http://localhost:3001`。

---

## ❓ 常见疑问

> **手机扫码进来「能看不能点」？**

通常是 Next dev 模式 bundle 慢。改跑生产模式：
```bash
pnpm --filter @tuttikit/web build
pnpm -r --parallel --stream start
```

> **`Loading chunk N failed`？**

`ChunkErrorReloader` 已经自动 reload。如果还是反复出现，硬刷新 (`⇧⌘R`)。详见 `apps/web/src/components/ChunkErrorReloader.tsx`。

> **流程图渲染慢 / 失败？**

懒载 + 20s 超时，可见时才下载 mermaid chunk。详见 `apps/web/src/components/Markdown.tsx` 的 `enhanceMermaidLazy()`。

> **PC 和手机不同步？**

`useGlobalSync.ts` 有 visibilitychange 重连 + 30s 心跳超时。切回前台应该 1-2 秒内同步。

> **中文文件名上传变乱码？**

`server.ts` 的 multer 配 `defParamCharset: 'utf8'`，详见上传 handler 注释。

---

## 📦 路线图 v0.2 新增模块（按主题）

> 本节随路线图 #1–#7 + 后续迭代陆续加入，与上面"按 X 找文件"互补。完整设计见 [`docs/agent-roadmap/`](./docs/agent-roadmap/)。

### 评测（Eval Harness）

```
apps/server/eval/
├── runner.ts              主入口；并发跑 task / 写 report.json / latest-<provider>.json
├── loader.ts              扫 yaml + zod schema 校验
├── score.ts               5 类客观断言 + LLM-judge async 路径
├── judge.ts               LLM-as-judge（裁判 prompt + JSON 解析容错）
├── types.ts               EvalTask / TaskRun / RunReport
├── cli.mjs                bootstrap：先设 LOG_LEVEL 再 import runner
├── README.md              使用指南
└── tasks/                 35+ yaml 任务，9 个分类：
    ├── math/  research/  file-ops/  refusal/  multi-step/
    └── boundary/  cancel/  safety-injection/  followup/
```

外部脚本 / 文档：
- `pnpm -C apps/server eval [--filter=...] [--provider=...] [--judge-provider=...] [--fail-on-regression]`
- 真 LLM 工作流：[`docs/agent-roadmap/eval-real-llm-workflow.md`](./docs/agent-roadmap/eval-real-llm-workflow.md)

### 结构化 I/O + 韧性

```
apps/server/src/
├── tools/registry.ts          Zod inputSchema 运行时校验
├── tools/errors.ts            ToolInputError（自修复 payload）/ ToolHandlerError
├── llm/retry.ts               withRetry：429/5xx/网络错指数退避 + jitter
└── llm/fallback.ts            FallbackLLM：provider 链，仅 outage 类才降级
```

### 安全

```
apps/server/src/
├── tools/fileSystem.ts        path.relative 越界 + allowlist + denylist
├── tools/calculator.ts        长度 + 数字字面量 cap + Number.isFinite 校验
├── mcp/manager.ts             trusted / allowTools 信任边界 + 命名空间冲突检测
├── core/uploads.ts            MAX_EXTRACTED_CHARS 截断
├── llm/aisdk.ts               <user-attachment> 包裹附件文本（injection 隔离）
└── server.ts                  helmet 头 + sseLimiter（单 IP 8 连接）

scripts/pre-commit.sh          git commit hook：拦小红书/草稿/.env/sk-* 等
```

### 成本 / 预算

```
apps/server/src/
├── core/budget.ts             BudgetGuard：beforeTurn/afterTurn + 80% 阈值警告
├── llm/pricing.ts             pricing 表 + priceFor()（含 cache 单价）
├── llm/cache.ts               LLMCache（开发用，LLM_CACHE=true 启用）
└── llm/aisdk.ts:_withPromptCache   Anthropic prompt cache（≥1024 token 才上）
```

### 部署 / 健康检查

```
apps/server/
├── Dockerfile                 多阶段，pnpm filter；HEALTHCHECK 内置
├── src/server.ts:/ready       env + data + MCP 多维度就绪检查
├── src/core/drain.ts          Drainer：in-flight turn 计数 + 30s 超时 graceful shutdown
├── src/config.ts:validateEnvOnBoot   Zod 校验，缺 API key 在 boot 期挂

docker-compose.yml             stop_grace_period 35s
.mcp.json.example              trusted / allowTools 示例
```

### Planning & Reflection

```
apps/server/src/
├── agents/planner.ts          planTask / revisePlan / shouldPlan 启发式 / renderPlanForConductor
├── agents/conductor.ts        _runReactSteps + _planExecuteSteps（V2 显式步骤） + re-plan 一次
└── prompts/selfCritique.ts    OK / REVISE: 输出格式
```

### RAG / 长期记忆升级

```
apps/server/src/
├── llm/embedding.ts           OpenAI / Mock embedding + cosineSim
├── memory/longTerm.ts         dedup（exact + 向量）+ evict + ensureEmbeddings + compact
├── memory/hybridSearch.ts     RRF 合并多 ranker
└── memory/vectorStore.ts      VectorStore 接口 + InMemoryVectorStore

docs/agent-roadmap/sqlite-vec-migration.md   SqliteVecStore 实现示例 + 迁移脚本
```

### Skills / MCP 翻译 + 管理页

```
apps/server/src/
├── skills/loader.ts           扫盘（含软链 + plugins/marketplaces）+ reload()
├── skills/translator.ts       单 skill 翻译 + 列表显示名批量翻译 + 落盘
├── mcp/translator.ts          tool desc + 显示名翻译 + 落盘
└── mcp/manager.ts:reconnect   单 server 重连不重启

apps/web/src/app/
├── skills/page.tsx            管理页：虚拟滚动 + 中英切换 + 列表名翻译
└── mcp/page.tsx               管理页：状态表 + reconnect + tool 翻译

apps/server/data/
├── skills-zh/<name>.zh.md     单 skill 翻译落盘
├── skills-zh/_names.zh.json   列表显示名 batch
└── mcp-zh/<server>.zh.json    MCP 翻译
```

### 前端性能

```
apps/web/src/components/
├── VirtualList.tsx            零依赖虚拟滚动（80 行）
├── SlashMenu.tsx              `/` 触发面板（skills + mcp）
└── ChatNotices.tsx            浮层通知（budget / review / critique / plan 4 类）

apps/web/src/hooks/useChat.ts  rAF batching token + 5 类新事件监听 + budget USD
```

### Trace Replay

```
apps/server/src/server.ts:/traces/:id/replay   单 / 多 provider 并发 replay
apps/web/src/app/traces/page.tsx               TraceTree + ReplayControls + ABComparePanel
```

### 路线图文档

```
docs/agent-roadmap/
├── README.md                          全景 gap 分析 + 优先级矩阵
├── 01-eval-harness.md                 设计 + 落地路径
├── 02-rag-and-memory.md
├── 03-structured-io-and-resilience.md
├── 04-planning-and-reflection.md
├── 05-cost-and-budget.md
├── 06-safety-guardrails.md
├── 07-deployment-and-debug.md
├── eval-real-llm-workflow.md          真 LLM eval 操作手册 + CI 配置
└── sqlite-vec-migration.md            VectorStore 升级路径
```

---

**有更多「想做 X」没在表里？** 在 `STRUCTURE.md` 里加一行 PR，方便下个人少踩一次坑。
