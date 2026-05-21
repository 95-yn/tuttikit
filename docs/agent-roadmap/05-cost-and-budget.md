# 05 · 成本与预算（含 Prompt Cache）

> **核心论点**：当前前端 ctx-meter 只是「看」，没有「拦」。一个失控任务能把 Claude 账户跑爆，没有任何熔断。Anthropic prompt cache 又是白送的省钱手段，没用就是亏。

## 现状

- 前端 `ctx-meter` 显示当前轮 input tokens 和 session 累计，纯展示。
- 后端**没有任何 token / cost 上限**。Conductor 跑 maxSteps=10 步、每步可能塞几万 token 进 prompt，理论上限就是 model 的 context window。
- **没有 prompt cache**：每次都发完整 system prompt（约 2-3k tokens）+ 完整 history，烧钱。
- **没有 LLM 响应缓存**：同样的 user message 在调试时跑 10 次，跑 10 次。

## 设计

### A. 单会话 Token 预算

`apps/server/src/config.ts`：

```ts
budget: {
  perTurnMaxTokens: 100_000,         // 单轮发出去 + 收回来上限
  perSessionMaxTokens: 1_000_000,    // 一个会话累计上限
  perTurnMaxUSD: 0.50,               // 单轮金额上限（按 provider 单价表算）
  perDayMaxUSD: 20,                  // 全局日上限
  onExceed: 'warn' | 'block',        // 软警告 / 硬拦截
},
```

实现：

#### A.1 Token 计数器中间件

`apps/server/src/core/budget.ts`：

```ts
export class BudgetGuard {
  private sessionTotals = new Map<string, { in: number; out: number; usd: number }>();
  private dayUSD = { date: '2026-05-20', total: 0 };

  beforeTurn(sessionId): void {
    const s = this.sessionTotals.get(sessionId);
    if (s && s.in + s.out > config.budget.perSessionMaxTokens) {
      throw new BudgetExceededError('session', sessionId);
    }
    if (this.dayUSD.total > config.budget.perDayMaxUSD) {
      throw new BudgetExceededError('day', this.dayUSD.date);
    }
  }

  afterTurn(sessionId, usage: Usage, provider: string): void {
    const usd = priceFor(provider, usage);
    const s = this.sessionTotals.get(sessionId) ?? { in:0, out:0, usd:0 };
    s.in += usage.inputTokens; s.out += usage.outputTokens; s.usd += usd;
    this.sessionTotals.set(sessionId, s);
    this._maybeRotateDay();
    this.dayUSD.total += usd;
    if (s.usd > config.budget.perTurnMaxUSD * 0.8) {
      bus.emit('budget:warn', { sessionId, ratio: s.usd / config.budget.perTurnMaxUSD });
    }
  }
}
```

挂在 `ConductorAgent.respond` 头尾。

#### A.2 价格表

`apps/server/src/llm/pricing.ts` —— 写死单价（per 1K input / output tokens），按 provider + model 索引：

```ts
export const PRICING: Record<string, { input: number; output: number }> = {
  'anthropic:claude-3-5-sonnet':  { input: 0.003,  output: 0.015 },
  'anthropic:claude-3-5-haiku':   { input: 0.0008, output: 0.004 },
  'openai:gpt-4o':                { input: 0.005,  output: 0.015 },
  'openai:gpt-4o-mini':           { input: 0.00015, output: 0.0006 },
  'deepseek:deepseek-chat':       { input: 0.00014, output: 0.00028 },
};
```

定期手动校准（半年一次），文档里写清楚价格表不是 SLA。

### B. Anthropic Prompt Cache

Vercel AI SDK 5.x 透传 Anthropic 的 `cache_control`，在 `aisdk.ts` 里给 system prompt 加：

```ts
messages: [
  {
    role: 'system',
    content: systemPrompt,
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  },
  // ... user / assistant messages
],
```

Claude 会自动把超 1024 token 的 system prompt 缓存 5 分钟，**输入价格降 90%**。

约束：
- 只对 `anthropic` provider 开启。
- system prompt 必须**稳定**（不能含动态时间戳等），否则 cache 命中率为零。把 `Today is YYYY-MM-DD` 改成 user message 注入。
- trace 里读 `usage.cacheReadInputTokens` / `usage.cacheCreationInputTokens`，展示命中率。

### C. LLM 响应缓存（开发/eval 用）

新增 `apps/server/src/llm/cache.ts`：

```ts
export class LLMCache {
  // key: hash(provider + model + messages + tools)
  // value: { content, toolCalls, usage }
  // TTL: 由 env 控制；prod 默认关
  get(key): CachedResponse | null;
  set(key, val): void;
}
```

接在 `aisdk.streamChat` 外层。**只对 non-streaming 调用启用**（avoid破坏 SSE UX）；或者 stream 时把整段写完后再补缓存。

用途：
- 开发时反复调试同一个 prompt，不烧钱。
- eval harness 跑回归，省 50% 调用费。
- prod 默认关闭（用户对 "同样的话每次答得一样" 通常感到诡异）。

### D. 前端预算提示

`apps/web/src/components/Topbar.tsx` 的 ctx-meter 加：

- 颜色：< 50% 灰 / 50-80% 黄 / > 80% 红
- 悬浮显示：`本会话累计 $0.34 / 上限 $5.00`
- 触发 `budget:warn` 事件时 toast 一次

## 改哪些文件

新增：
- `apps/server/src/core/budget.ts`
- `apps/server/src/llm/pricing.ts`
- `apps/server/src/llm/cache.ts`

改：
- `apps/server/src/agents/conductor.ts` —— `beforeTurn/afterTurn`
- `apps/server/src/llm/aisdk.ts` —— prompt cache `cacheControl` + 响应缓存包装
- `apps/server/src/config.ts` —— `budget` 节
- `apps/server/src/types.ts` —— `Usage` 加 `cacheReadInputTokens` / `cacheCreationInputTokens`
- `apps/web/src/components/Topbar.tsx` —— ctx-meter 增强 + toast

## 验收

1. 单轮硬拦截：把 `perTurnMaxUSD` 设成 `0.001`，发个长任务 → 收到 `turn:error` `budget exceeded`。
2. Anthropic prompt cache：连发两次相同问题，第二次 `cacheReadInputTokens > 0`，trace 上能看到命中率。
3. LLM cache（dev mode）：重复 `pnpm eval` 不调用真 API（trace 显示 `cached:true`）。
4. 前端 ctx-meter 红色态触发时给出 toast。

## 风险

- **价格表过时**：每次 provider 调价我们都不知道，文档里写 "仅供参考，以官方账单为准"。
- **缓存击穿**：system prompt 里如果不小心带了动态内容，cache 永不命中。加单元测试断言 system prompt 是常量。
