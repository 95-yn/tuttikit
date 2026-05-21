# @tuttikit/server

多 Agent 协作后端：Express + Vercel AI SDK，**TypeScript**（通过 `tsx` 直跑，无编译步骤）。对外暴露 REST + SSE，前端在 [`../web/`](../web/)。

> 想找文件位置 → 项目根 [`STRUCTURE.md`](../../STRUCTURE.md) 「我想做 X」一键定位
>
> 想理解模块设计 → [`ARCHITECTURE.md`](./ARCHITECTURE.md)
>
> 路线图 & 设计文档 → [`../../docs/agent-roadmap/`](../../docs/agent-roadmap/)

## 启动

```bash
# 从 monorepo 根
pnpm dev:server                              # tsx watch（保存自动重启）
pnpm --filter @tuttikit/server start         # tsx 单次
pnpm --filter @tuttikit/server typecheck     # tsc --noEmit
pnpm chat                                    # CLI 多轮聊天

# 也可以本目录直跑
npx tsx src/server.ts
npx tsx src/cli.ts "帮我算 (128 * 37 + 256) / 8"
npx tsx src/cli.ts --provider=mock --session=<id>
```

监听端口默认 3001（`.env` 的 `PORT` 覆盖）。CORS 默认放行 `http://localhost:3000`，多源在 `CORS_ORIGINS` 逗号分隔。

**Docker**：

```bash
docker compose up     # 起 server，3001 暴露；data/ 挂卷
```

## 结构

```
src/
├── server.ts       cli.ts       config.ts       types.ts
├── agents/
│   ├── base.ts                    ReAct 基类（被 sub-agent 继承）
│   ├── conductor.ts               主对话 Agent + plan-execute V1/V2 + self-critique + drain + budget
│   ├── researcher.ts coder.ts reviewer.ts
│   ├── planner.ts                 Planner + revisePlan（plan-and-execute 用）
│   └── index.ts
├── prompts/                       所有 system prompt 集中
│   ├── builder.ts  fragments.ts  selfCritique.ts  index.ts
├── tools/
│   ├── registry.ts                Zod 入参校验 + 错误转 LLM payload 自修复
│   ├── errors.ts                  ToolInputError / ToolHandlerError
│   ├── calculator.ts  fileSystem.ts  webSearch.ts  delegate.ts
│   └── index.ts
├── llm/
│   ├── base.ts  aisdk.ts  mock.ts                    Provider 实现
│   ├── index.ts                                      createLLM 工厂（含 fallback chain）
│   ├── retry.ts  fallback.ts                         429/5xx 重试 + provider 链
│   ├── cache.ts                                      响应缓存（开发用）
│   ├── pricing.ts                                    单价表 + priceFor()
│   └── embedding.ts                                  OpenAI / Mock embedding
├── memory/
│   ├── shortTerm.ts                                  子 Agent 用
│   ├── longTerm.ts                                   嵌入式 RAG：embedding + dedup + compact + evict
│   ├── hybridSearch.ts                               关键词 + 向量 RRF 合并
│   └── vectorStore.ts                                VectorStore 接口 + InMemory 实现
├── core/
│   ├── session.ts  messageBus.ts  broadcaster.ts
│   ├── uploads.ts                                    multer + LRU 缓存
│   ├── parsers.ts                                    pdf-parse v2 + tesseract.js
│   ├── budget.ts                                     BudgetGuard（USD / token 上限）
│   └── drain.ts                                      Graceful shutdown 计数器
├── observability/  logger.ts  tracer.ts              自建 trace/span
├── streaming/      sse.ts                            SSE 事件总线
├── skills/
│   ├── loader.ts                                     扫 .claude/skills + plugins/marketplaces（含软链）
│   ├── translator.ts                                 单 skill / 批量列表名翻译落盘
│   ├── tools.ts  types.ts  index.ts
└── mcp/
    ├── manager.ts                                    .mcp.json 加载 + 信任边界 + reconnect
    └── translator.ts                                 tool desc + 显示名翻译落盘

examples/                                             10 套测试
├── test-aisdk-integration  test-conductor  test-markdown
├── test-skills  test-mcp
├── test-resilience  test-safety  test-budget  test-rag  test-planner

eval/                                                 端到端 golden task 评测
├── runner.ts  loader.ts  score.ts  judge.ts  types.ts  cli.mjs
└── tasks/{math,research,file-ops,refusal,multi-step,boundary,cancel,safety-injection,followup}/*.yaml

data/                                                 运行时持久化（gitignored）
├── sessions/  traces/  uploads/  long_term_memory.json
├── eval-runs/                                        eval 报表 + baseline-<provider>.json
├── skills-zh/                                        Skills 中文翻译
└── mcp-zh/                                           MCP 中文翻译
```

完整文件清单 + 「想改 X 找哪里」见 [`STRUCTURE.md`](../../STRUCTURE.md)。

## REST + SSE

详见根 [README.md](../../README.md) 的 API 总表。这里只列分类入口：

| 类别 | 路由前缀 |
| --- | --- |
| 会话 / SSE 流 | `/sessions/...`、`/sessions/:id/stream`、`/events` |
| 上传 | `/uploads/...` |
| Trace + Replay | `/traces/...`、`POST /traces/:id/replay` |
| Skills（含翻译） | `/skills/...`、`POST /skills/:name/translate`、`POST /skills/translate-names` |
| MCP（含翻译） | `/mcp/...`、`POST /mcp/:name/reconnect`、`POST /mcp/:name/translate` |
| 长期记忆 | `/memory`、`/memory/search?q=` |
| 健康 | `/health`、`/ready` |
| 预算 | `/sessions/:id/budget` |

SSE 事件协议见 [`ARCHITECTURE.md` §4.6](./ARCHITECTURE.md#46-事件协议srcstreamingssejs)；本版新增事件：`critique:revise` / `critique:ok` / `budget:warn` / `review:needed` / `plan:created` / `plan:step:start` / `plan:step:end` / `plan:revised`。

## 环境变量

```bash
# LLM
LLM_PROVIDER=anthropic|openai|deepseek|mock
LLM_FALLBACK_CHAIN=openai,deepseek,mock          # 主限流时按链降级（可选）
ANTHROPIC_API_KEY=... ANTHROPIC_MODEL=claude-sonnet-4-6
OPENAI_API_KEY=...    OPENAI_MODEL=gpt-4o-mini
DEEPSEEK_API_KEY=...  DEEPSEEK_MODEL=deepseek-chat

# Server
PORT=3001  LOG_LEVEL=info  CORS_ORIGINS=http://localhost:3000

# Budget
BUDGET_ENABLED=true
BUDGET_SESSION_MAX_USD=2.0
BUDGET_SESSION_MAX_TOKENS=1000000
BUDGET_DAY_MAX_USD=20.0

# LLM 响应缓存（开发 / eval 用）
LLM_CACHE=true                LLM_CACHE_TTL_MS=3600000

# 翻译（skills / mcp）用的 provider（不配走 LLM_PROVIDER）
TRANSLATOR_PROVIDER=deepseek

# Embedding（RAG）
EMBEDDING_PROVIDER=openai|mock|auto
EMBEDDING_MODEL=text-embedding-3-small

# Eval-as-judge
LLM_JUDGE_PROVIDER=anthropic

# Agent 行为开关（默认全关）
AGENT_SELF_CRITIQUE=true
AGENT_AUTO_REVIEW_CODE=true
AGENT_PLAN_AND_EXECUTE=true
AGENT_PLAN_EXPLICIT_STEPS=true        # V2 显式步骤 + plan:step:start/end 事件

# fileSystem 写入允许目录
FS_WRITE_ALLOWLIST=data,tmp,output
```

## 测试 + Eval

```bash
pnpm --filter @tuttikit/server test
# 10 套测试（~200 断言）：
#   aisdk        AI SDK 集成（消息映射、tool-call、流式）
#   conductor    Conductor 多轮 + delegate
#   markdown     Markdown / 代码块 / Mermaid
#   skills       SKILL.md 扫盘 + project 覆盖 user + plugin 来源
#   mcp          stdio in-memory transport + ToolSpec
#   resilience   ToolInputError 自修复 + Provider Fallback + AbortSignal
#   safety       fileSystem allowlist + denylist + 路径越界 + 入参校验
#   budget       pricing 表 + BudgetGuard + LLMCache
#   rag          MockEmbedding + 混合检索 + dedup + compact + VectorStore
#   planner      shouldPlan + planTask + revisePlan + renderPlan

pnpm --filter @tuttikit/server eval                  # mock provider，35+ 任务
pnpm --filter @tuttikit/server eval --filter=math
pnpm --filter @tuttikit/server eval --provider=anthropic --judge-provider=anthropic
pnpm --filter @tuttikit/server eval --fail-on-regression       # CI 门禁
```

详见 [`eval/README.md`](./eval/README.md) + [`docs/agent-roadmap/eval-real-llm-workflow.md`](../../docs/agent-roadmap/eval-real-llm-workflow.md)。

完整模块设计、Agent 协议、可观测、扩展点：[`ARCHITECTURE.md`](./ARCHITECTURE.md)。
