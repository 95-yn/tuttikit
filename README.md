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
| 3001 | Express (apps/server) —— REST + SSE |

后端默认开启 CORS 放行 `http://localhost:3000`，可在 `.env` 用 `CORS_ORIGINS` 覆盖（逗号分隔）。

## Web 管理页

| 路由 | 功能 |
| --- | --- |
| `/` | 对话主界面（含 `/` slash 命令面板） |
| `/skills` | Skills 列表 + 详情；按需翻译成中文 + 落盘；虚拟滚动 |
| `/mcp` | MCP server 列表 + tool 列表 + 重连；翻译同上 |
| `/traces` | Trace 列表 + 详情树 + Replay（单 / A/B 多 provider） |

进入路径：右上角 🧩 / 🔌 / 📊 三个图标。

## CLI

```bash
pnpm -C apps/server chat                    # 交互
pnpm -C apps/server chat -- "算 1+2"        # 一次性
pnpm -C apps/server chat -- --session=<id>  # 续会话
```

CLI 与 web 共享 sessions、skills、MCP（启动期 init 同套 loader）。

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

**Agent 编排**
- 多 Agent 委派：Conductor + Researcher / Coder / Reviewer，sub-agent as tool
- Plan-and-Execute：复杂任务先规划再分步执行（V2 显式逐步 + 失败 re-plan）
- Self-Critique：终答前内省审校，REVISE 触发再跑一轮（默认关）
- Skills：兼容 Claude Code 的 `.claude/skills/` + `~/.claude/plugins/marketplaces/`，扫到 50+ 个开箱即用
- MCP：标准协议接外部工具（stdio + HTTP），`trusted` / `allowTools` 信任边界

**对话体验**
- 流式输出 + rAF 批处理（避免 setState 风暴）
- **`/` 直接调 skill/MCP**：输入框打 `/` 弹面板，键盘选完自动 inject prompt
- 多模态：图片 + PDF + OCR（tesseract.js）
- 多设备同步（SSE 全局广播） + 扫码即进
- 响应式 + 暗色 / 亮色 / 跟随系统主题
- 管理页：`/skills` `/mcp` `/traces` 三页全部虚拟滚动，上千条目无压力

**多模型 / 韧性 / 成本**
- 4 个 provider（anthropic / openai / deepseek / mock）一行 `.env` 切
- Provider fallback chain：主限流自动切备
- Retry + backoff（429 / 5xx 指数退避）
- AbortController 全链路（关页面 / Stop 立即中断 tool）
- Budget guard：会话 / 当日 USD 上限 + 80% 预警
- Anthropic prompt cache（输入价 -90%）+ LLM 响应缓存（开发用）

**记忆 / 检索**
- RAG（轻量）：long-term memory 自带 embedding + 关键词 / 向量 RRF 混合检索
- Memory compact：超阈值聚类 → LLM 合并摘要；exact + 向量 dedup；LRU evict
- VectorStore 接口预留（sqlite-vec 迁移文档已就绪）

**i18n（中文）**
- Skills 详情按需翻译，落盘 `data/skills-zh/<name>.zh.md` 可直接打开
- Skills 列表名批量翻译，落 `data/skills-zh/_names.zh.json`
- MCP tool descriptions + 中文显示名，落 `data/mcp-zh/<server>.zh.json`

**安全**
- Helmet 头 + SSE 单 IP 限 8 连接
- fileSystem 写入 allowlist（`data/ tmp/ output/`）+ denylist（`.env / .git / package.json`）
- Prompt injection：`<user-attachment>` 隔离 + system 加防护
- pre-commit hook 拦小红书 / 草稿 / API key 提交

**可观测 / 评测**
- 自建 Trace/Span 嵌套树，`/traces` UI
- Trace Replay：单 + A/B 多 provider 并发对比
- Eval Harness：35+ golden tasks + LLM-as-judge + regression diff（`--fail-on-regression` CI 门禁）

**部署**
- Dockerfile + docker-compose（多阶段 + pnpm filter）
- `/ready` 健康检查（env / 数据目录 / MCP 连接）
- Graceful drain（SIGTERM 等 in-flight turn 完成，30s 超时）
- Zod env 校验，缺 key 在 boot 期挂

**始终保留**
- 持久化：会话 / Trace / 记忆全落本地 JSON
- 零配置可跑：无 API Key → MockProvider 演示

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

**对话 / 会话**

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/health` / `/ready` | 活探针 / 就绪探针（含 env / data / MCP 多重检查） |
| GET / POST / PATCH / DELETE | `/sessions(/:id)` | 会话 CRUD |
| GET | `/sessions/:id/stream?message=&attachmentIds=&provider=` | SSE 流式对话 |
| GET | `/sessions/:id/budget` | 会话累计 token / USD |
| POST / GET | `/uploads` | 单文件上传 + 回源 |
| GET | `/events` | 全局广播 SSE（多设备同步） |

**Trace + Replay**

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/traces` / `/traces/:id` | trace 列表 / 详情 |
| POST | `/traces/:id/replay` | body `{provider}` 单 replay，`{providers:[]}` A/B 并发 |

**Skills / MCP（含翻译）**

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/skills` / `/skills/:name` | list / 详情含 body |
| POST | `/skills/reload` | 重扫盘热更新 |
| GET / POST | `/skills/:name/translation` / `/skills/:name/translate` | 单 skill 中文翻译（落盘） |
| GET / POST | `/skills/translated-names` / `/skills/translate-names` | 列表显示名批量翻译 |
| GET | `/mcp` / `/mcp/:name` | server 列表 / 详情含 tools |
| POST | `/mcp/:name/reconnect` | 重连单 server |
| GET / POST | `/mcp/:name/translation` / `/mcp/:name/translate` | server 翻译（tool desc + 显示名） |

**记忆**

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/memory` / `/memory/search?q=` | 长期记忆 list / 搜索（关键词 + 向量 RRF） |

前端走 `/api/*` 由 Next.js rewrites 代理。

## 测试

```bash
pnpm -C apps/server test    # 10 套测试，~200 断言
# aisdk · conductor · markdown · skills · mcp · resilience · safety · budget · rag · planner

pnpm -C apps/server eval    # 35+ golden tasks 端到端（mock provider）
pnpm -C apps/server eval --provider=anthropic --judge-provider=anthropic --fail-on-regression
```

详细见 [`apps/server/eval/README.md`](./apps/server/eval/README.md) +
[`docs/agent-roadmap/eval-real-llm-workflow.md`](./docs/agent-roadmap/eval-real-llm-workflow.md)。

## 安全（pre-commit）

防止误提交 `小红书*` / `公众号*` / `草稿*` / `.private/` / `.env` / API key 等：

```bash
ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit
```

之后 `git commit` 会先跑 `scripts/pre-commit.sh`：检测到敏感文件名 / API key 字面量 → 阻止 commit。
紧急绕过：`git commit --no-verify`。

---

**下一步**：

- 想改某个具体的东西 → [`STRUCTURE.md`](./STRUCTURE.md)
- 想理解后端是怎么跑的 → [`apps/server/ARCHITECTURE.md`](./apps/server/ARCHITECTURE.md)
- 后端 README → [`apps/server/README.md`](./apps/server/README.md)
- 前端 README → [`apps/web/README.md`](./apps/web/README.md)
