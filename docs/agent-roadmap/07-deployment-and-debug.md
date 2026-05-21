# 07 · 部署与 Debug

> **核心论点**：项目目前只能在开发者机器跑 `pnpm dev`，没有 Dockerfile、没有 env 校验、没有 trace replay。Agent 系统最常见的 debug 场景是 "上次某个对话神奇地答对了 / 答错了，能不能复现一下" —— 当前不能。

## 现状

- 启动：`scripts/dev.mjs` 跑 `tsx watch`，靠开发者本机 Node 18+。
- 环境变量：`.env` 直接 `dotenv.config()`，缺 `OPENAI_API_KEY` 时 fail-on-first-call（不是 fail-on-boot），上线踩坑。
- 没有 Dockerfile / docker-compose。
- 没有 healthcheck 之外的 readiness probe。
- `/traces/:id` 能看树，但**无法重放**：换个 prompt / 模型重跑当时那一轮、对比新旧 trace。
- 没有 A/B：同一 user message 同时跑 anthropic + openai + deepseek 看哪个回得好。

## 设计

### A. Dockerfile + docker-compose

最小 Dockerfile（多阶段，避免把 `node_modules` 全打进去）：

```dockerfile
# apps/server/Dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
RUN corepack enable && pnpm install --frozen-lockfile --filter @tuttikit/server

FROM node:20-alpine AS run
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY apps/server ./apps/server
WORKDIR /app/apps/server
ENV NODE_ENV=production
EXPOSE 3001
CMD ["npx", "tsx", "src/server.ts"]
```

`docker-compose.yml`：

```yaml
services:
  tuttikit:
    build: { context: ., dockerfile: apps/server/Dockerfile }
    ports: ["3001:3001"]
    env_file: .env
    volumes:
      - ./data:/app/apps/server/data   # session / 上传 / trace 持久化
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3001/health"]
      interval: 30s
```

### B. 启动期 env 校验

`apps/server/src/config.ts` 用 zod：

```ts
const Env = z.object({
  PORT: z.string().default('3001'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'deepseek', 'mock']).default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // ...
});
const env = Env.parse(process.env);

// 启动时再做依赖检查：
if (env.LLM_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
  console.error('LLM_PROVIDER=anthropic 但 ANTHROPIC_API_KEY 未配置');
  process.exit(1);
}
```

提前 fail，比线上跑到第一次请求才挂好得多。

### C. Readiness probe 分离

```ts
app.get('/health', (_req, res) => res.json({ ok: true }));         // 进程活着
app.get('/ready', async (_req, res) => {
  // - 能不能 ping LLM？
  // - 数据目录可写？
  // - MCP servers 都连上了？
  const checks = await Promise.allSettled([
    pingLLM(), checkDataWritable(), mcpManager.checkAll(),
  ]);
  const failed = checks.filter((c) => c.status === 'rejected');
  if (failed.length) return res.status(503).json({ ok: false, failed });
  res.json({ ok: true });
});
```

K8s / Nomad 把 `/ready` 当 readinessProbe，挂了不接流量但不重启。

### D. Trace Replay

UI 上 `/traces/:id` 加 "↻ Replay" 按钮。点击后：

```
POST /traces/:id/replay
body: { provider?: 'openai', model?: 'gpt-4o', overrideMessages?: [...] }
```

后端：
1. 从 trace 拿出原始 user message + attachments + session 状态。
2. 用新 provider / model 跑一遍同样的 `conductor.respond`。
3. 写到 `traces/<replayId>.json`，标 `replayOf: <originalId>`。
4. 前端 split-view 对比新旧 trace：tool call 数、token 用量、最终答案、耗时。

实现关键：**完整原始上下文要冻在 trace 里**（trace 加 `replaySnapshot` 字段，记 message 数组、tools 列表、system prompt 哈希）。否则改了 system prompt 之后旧 trace 没法 replay。

### E. A/B 多 Provider 对照

CLI / 调试用：

```bash
pnpm chat --providers=anthropic,openai,deepseek --message="解释 RAG"
```

后端同时 fan-out 三个 provider，前端展示三栏对比。eval harness 也复用这个机制做 cross-provider 评分（结合 [01](./01-eval-harness.md)）。

### F. Graceful Shutdown

`apps/server/src/server.ts` 已有 SIGINT 处理但不全：

```ts
async function shutdown(signal) {
  logger.info({ signal }, '关闭中...');
  server.close();                                       // 停接新请求
  await drainInFlight({ timeout: 30_000 });             // 等当前 turn 跑完，30s 超时
  await mcpManager.close();                             // 关 MCP 子进程
  await sessionManager.flush();                         // 写盘
  process.exit(0);
}
```

`drainInFlight` 需要在 conductor 启动 / 结束时往一个 counter +1 / -1。

## 改哪些文件

新增：
- `apps/server/Dockerfile`
- `docker-compose.yml`
- `apps/server/src/core/drain.ts` —— in-flight counter
- `apps/server/src/observability/replay.ts` —— trace replay 入口

改：
- `apps/server/src/config.ts` —— zod env 校验
- `apps/server/src/server.ts` —— `/ready` 路由 + graceful shutdown
- `apps/server/src/observability/tracer.ts` —— `Trace` 加 `replaySnapshot` 字段
- `apps/web/src/app/traces/[id]/page.tsx` —— "↻ Replay" 按钮 + split-view 对比
- `.env.example` —— 列全部 env 项 + 注释

## 验收

1. `docker compose up` 起 server，`curl localhost:3001/health` ✅，`/ready` 在 mock provider 下也 ✅。
2. 删 `.env`，启动直接 panic 报 missing key（不等到第一个请求）。
3. 在 `/traces/:id` 点 Replay → 切到 OpenAI 重跑 → 新 trace 出现，对比页能看到两栏 diff。
4. `pnpm chat --providers=anthropic,openai` → 终端三栏并排。
5. `kill -TERM <pid>` 时正在跑的 turn 能完整跑完再退出，新请求被 503。

## 风险

- **Dockerfile 包大**：tsx + tesseract.js 拉的 wasm 不小。**对策**：先不 optimize，能跑就行；后续 evaluate `--filter` + 预构建 wasm。
- **Replay 不是 deterministic**：LLM 本身有随机性。对策：replay UI 上明确 "结果不会完全一致，对比仅供参考"，并 fix `temperature=0` 以缩小方差。
- **Drain 期间 SSE 长连接卡 30s**：可接受。`/events` 流不计入 drain（它是被动 push，不是 in-flight turn）。
