# @tuttikit/server

多 Agent 协作后端：Express + Vercel AI SDK，**TypeScript**（通过 `tsx` 直跑，无编译步骤）。对外暴露 REST + SSE，前端在 [`../web/`](../web/)。

> 想找文件位置 → 项目根 [`STRUCTURE.md`](../../STRUCTURE.md) 「我想做 X」一键定位
>
> 想理解模块设计 → [`ARCHITECTURE.md`](./ARCHITECTURE.md)
>
> 想看 monorepo 总览 → 根目录 [`README.md`](../../README.md)

## 启动

```bash
# 从 monorepo 根
pnpm dev:server                                    # tsx watch（保存自动重启）
pnpm --filter @tuttikit/server start     # tsx 单次
pnpm chat                                          # CLI 多轮聊天
pnpm --filter @tuttikit/server test
pnpm --filter @tuttikit/server typecheck # tsc --noEmit

# 也可以本目录直跑
npx tsx src/server.ts
npx tsx src/cli.ts "帮我算 (128 * 37 + 256) / 8"
```

监听端口默认 3001（`.env` 的 `PORT` 覆盖）。CORS 默认放行 `http://localhost:3000`，多源在 `CORS_ORIGINS` 逗号分隔。

## 结构

```
src/
├── server.ts   cli.ts   config.ts   types.ts
├── agents/         base / conductor / researcher / coder / reviewer
├── prompts/        builder / fragments / index（所有 system prompt）
├── tools/          calculator / fileSystem / webSearch / delegate / registry
├── llm/            base / aisdk / mock / index（createLLM 工厂）
├── memory/         shortTerm（子 Agent 用）+ longTerm（跨会话沉淀）
├── core/           session / messageBus / broadcaster / uploads / parsers
├── observability/  logger + tracer
└── streaming/      sse

examples/       test-aisdk-integration / test-conductor / test-markdown
data/           sessions / traces / uploads / long_term_memory
```

完整文件清单 + 「想改 X 找哪里」见 [`STRUCTURE.md`](../../STRUCTURE.md)。

## REST + SSE

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/health` | 当前 provider |
| POST | `/sessions` | 新建会话 |
| GET | `/sessions` | 会话列表 |
| GET | `/sessions/:id` | 会话详情 |
| PATCH | `/sessions/:id` | 重命名 |
| DELETE | `/sessions/:id` | 删除 |
| GET | `/sessions/:id/stream?message=&attachmentIds=&provider=` | **SSE 流式对话** |
| POST | `/uploads` | 单文件上传（multipart, image/* 或 application/pdf） |
| GET | `/uploads/:id` | 文件回源 |
| GET | `/events` | 全局广播 SSE（多设备同步） |
| GET | `/traces` / `/traces/:id` | trace 列表 / 详情 |
| GET | `/memory` / `/memory/search?q=` | 长期记忆 |

SSE 事件协议见 [`ARCHITECTURE.md` §4.6](./ARCHITECTURE.md#46-事件协议srcstreamingssejs)。

## 测试

```bash
pnpm --filter @tuttikit/server test
# - AI SDK 集成 21 断言
# - Conductor 多轮 + delegate 12 断言
# - Markdown / 代码块 / Mermaid 34 断言
```

完整模块设计、Agent 协议、可观测、扩展点：[`ARCHITECTURE.md`](./ARCHITECTURE.md)。
