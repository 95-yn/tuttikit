# 03 · 结构化 I/O + 韧性（Resilience）

> **核心论点**：LLM 返回的 tool args 不可信任，外部 API 一定会抖。当前两处都靠 `try { ... } catch {}` 兜底，错误信息丢失、无重试、无降级。

## 现状

### A. 工具输入校验缺失

`apps/server/src/tools/registry.ts:invoke()`：

```ts
async invoke(name, input, ctx = {}) {
  const tool = this.tools.get(name);
  if (!tool) throw new Error(`未知工具：${name}`);
  return tool.handler(input ?? {}, ctx);   // ← input 完全没校验
}
```

`tool.parameters` 里写的是 JSON Schema，但**只用来给 LLM 看，没在运行时校验**。LLM 偶尔返回的 `{"expression": 123}`（数字而不是字符串）直接进到 handler，能跑到 `Function(\`return (${expression})\`)` 抛 TypeError，trace 里只看到一个 "expression.includes is not a function"。

### B. 外部调用无 retry / backoff

LLM provider 抖一下（429 / 5xx / network reset）→ 整个 `conductor.respond` 直接挂，前端只收到 `turn:error`。Vercel AI SDK 自带一点重试，但没暴露配置，且 tool handler 里的 fetch（webSearch 等）完全裸调。

### C. 无 fallback model

`anthropic` 限流 → 没自动降到 `openai` 或 `mock`。

## 设计

### A. Zod 校验 + 自修复

#### A.1 ToolSpec 加 `inputSchema`

```ts
// apps/server/src/types.ts
import { z } from 'zod';
export interface ToolSpec<I = unknown, O = unknown> {
  name: string;
  description: string;
  parameters: JSONSchema;            // 给 LLM
  inputSchema?: z.ZodType<I>;        // 给 runtime
  handler: (input: I, ctx: ToolCtx) => Promise<O>;
  allowedAgents?: string[];
}
```

#### A.2 Registry.invoke 改造

```ts
async invoke(name, input, ctx = {}) {
  const tool = this.tools.get(name);
  if (!tool) throw new Error(`未知工具：${name}`);
  if (tool.inputSchema) {
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      const err = parsed.error.format();
      // 关键：把校验错误返回给 LLM，让它自己改！
      throw new ToolInputError(name, err, input);
    }
    input = parsed.data;
  }
  return tool.handler(input, ctx);
}
```

#### A.3 Conductor 处理 ToolInputError → 自修复

`ConductorAgent.respond` 的 tool-use 循环里：

```ts
if (err instanceof ToolInputError) {
  // 不抛出，把错误塞回 tool_result，让 LLM 自己重试
  toolResult = JSON.stringify({
    error: 'input_validation_failed',
    issues: err.issues,
    receivedInput: err.input,
    hint: '请按 parameters schema 重新生成 input',
  });
}
```

绝大多数情况 LLM 看到这个错误立刻就改对了，类似 "self-healing tool call"。

### B. 重试 + Backoff

新增 `apps/server/src/llm/retry.ts`：

```ts
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; minDelay?: number; maxDelay?: number; on?: (err, attempt) => boolean } = {}
): Promise<T> {
  const { retries = 3, minDelay = 400, maxDelay = 8000, on = isRetryable } = opts;
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (err) {
      if (attempt >= retries || !on(err, attempt)) throw err;
      const delay = Math.min(maxDelay, minDelay * 2 ** attempt) + Math.random() * 200;
      await sleep(delay);
      attempt++;
    }
  }
}

function isRetryable(err) {
  // 429 / 5xx / ECONNRESET / fetch timeout
  return /429|5\d\d|ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(err));
}
```

包到：
- `apps/server/src/llm/aisdk.ts` 的 `streamChat()` —— 包外层（注意 stream 已经开始就别重试，只重试 connection 阶段）
- `apps/server/src/tools/webSearch/*.ts` —— fetch 调用
- MCP 工具调用

### C. Provider Fallback Chain

`config.llm.fallback = ['anthropic', 'openai', 'mock']`：

```ts
// apps/server/src/llm/index.ts
export function createLLMWithFallback(primary?: string): LLMLike {
  const chain = primary
    ? [primary, ...config.llm.fallback.filter((p) => p !== primary)]
    : config.llm.fallback;
  return {
    async streamChat(args) {
      let lastErr;
      for (const p of chain) {
        try {
          const llm = createLLM(p);
          return await llm.streamChat(args);
        } catch (err) {
          if (!isRateLimitOrOutage(err)) throw err;  // 真错误不降级
          logger.warn({ from: p, err }, '[llm] fallback');
          lastErr = err;
        }
      }
      throw lastErr;
    },
  };
}
```

**关键约束**：fallback 只在 429 / 5xx / 网络层错误时触发，**不对内容质量问题降级**（那是 eval 的事）。

## 改哪些文件

新增：
- `apps/server/src/llm/retry.ts`
- `apps/server/src/llm/fallback.ts`
- `apps/server/src/tools/errors.ts` —— `ToolInputError`、`ToolHandlerError` 自定义类

改：
- `apps/server/src/types.ts` —— `ToolSpec` 加 `inputSchema`
- `apps/server/src/tools/calculator.ts` / `fileSystem.ts` / `webSearch.ts` —— 各自定义 `inputSchema = z.object(...)`
- `apps/server/src/tools/registry.ts` —— `invoke()` 加 zod 校验
- `apps/server/src/agents/conductor.ts` —— 处理 `ToolInputError`
- `apps/server/src/llm/aisdk.ts` —— 包 `withRetry`
- `apps/server/src/llm/index.ts` —— `createLLMWithFallback`
- `apps/server/src/config.ts` —— 加 `llm.fallback` 配置

## 验收

1. LLM 故意返回 `{expression: 123}` → conductor 一次自修复，最终算出结果（trace 里能看到两次 tool call，第一次 error、第二次 ok）。
2. mock 一个 429 错误 → withRetry 重试 3 次后成功（trace 里看到 attempt=0/1/2）。
3. mock 一个持续 429 → fallback 切到 openai → 切到 mock，三个都挂才抛错。
4. eval harness 加一类 `resilience-*.yaml` 任务（用 fault-injection provider 模拟错误），跑通。

## 风险

- **stream 中途断开**：retry 不适用，得在 conductor 层判断是否要重发整轮。**初版不处理**，stream 断了就让用户重发。
- **fallback 期间 token 计费混乱**：trace 里要明确记录每段用了哪个 provider 多少 token。
