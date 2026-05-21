/**
 * #3 Structured I/O + Resilience 的端到端测试。
 *   - ToolRegistry zod 校验：好参数 ok，坏参数抛 ToolInputError 且带 payload
 *   - ToolInputError.toLLMPayload() 包含 hint / issues / receivedInput
 *   - FallbackLLM：第一家抛 429 时切到第二家
 *   - FallbackLLM：非 outage 类错误（如 4xx 业务错）不切，直接抛
 */
process.env.LOG_LEVEL ??= 'warn';

import { ToolRegistry } from '../src/tools/registry.js';
import { calculatorTool } from '../src/tools/calculator.js';
import { ToolInputError } from '../src/tools/errors.js';
import { FallbackLLM } from '../src/llm/fallback.js';
import type { LLMLike, LLMCallArgs, LLMResponse } from '../src/types.js';

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

// ───── A. Registry + Zod ─────
{
  const reg = new ToolRegistry();
  reg.register(calculatorTool);

  const ok = await reg.invoke('calculator', { expression: '1+2' }) as { value: number };
  assert(ok.value === 3, '好参数：calculator 返回 3');

  let caught: unknown;
  try {
    await reg.invoke('calculator', { expression: 123 });   // 数字而不是字符串
  } catch (err) { caught = err; }
  assert(caught instanceof ToolInputError, '坏参数（数字）→ ToolInputError');
  assert((caught as ToolInputError).toolName === 'calculator', 'ToolInputError.toolName 正确');

  const payload = (caught as ToolInputError).toLLMPayload();
  assert(payload.error === 'input_validation_failed', 'payload.error == input_validation_failed');
  assert(payload.tool === 'calculator', 'payload.tool == calculator');
  assert(!!payload.hint && /string/i.test(payload.hint) || payload.hint.length > 0, 'payload.hint 非空');
  assert(JSON.stringify(payload.receivedInput).includes('123'), 'payload.receivedInput 保留原始输入');

  // 缺字段
  let caught2: unknown;
  try {
    await reg.invoke('calculator', {} as never);
  } catch (err) { caught2 = err; }
  assert(caught2 instanceof ToolInputError, '缺 expression 字段 → ToolInputError');

  // null 也走 schema
  let caught3: unknown;
  try {
    await reg.invoke('calculator', null);
  } catch (err) { caught3 = err; }
  assert(caught3 instanceof ToolInputError, 'null 参数 → ToolInputError');
}

// ───── B. FallbackLLM ─────
{
  // 模拟一个 429 的 provider
  class OverloadedLLM implements LLMLike {
    name = 'overloaded';
    callCount = 0;
    async chat(_args: LLMCallArgs): Promise<LLMResponse> {
      this.callCount++;
      const e = new Error('rate limit exceeded') as Error & { status: number };
      e.status = 429;
      throw e;
    }
    async stream(args: LLMCallArgs): Promise<LLMResponse> { return this.chat(args); }
  }
  class HealthyLLM implements LLMLike {
    name = 'healthy';
    callCount = 0;
    async chat(_args: LLMCallArgs): Promise<LLMResponse> {
      this.callCount++;
      return { role: 'assistant', content: 'hi from healthy', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    }
    async stream(args: LLMCallArgs): Promise<LLMResponse> { return this.chat(args); }
  }
  class BadRequestLLM implements LLMLike {
    name = 'badreq';
    callCount = 0;
    async chat(_args: LLMCallArgs): Promise<LLMResponse> {
      this.callCount++;
      const e = new Error('invalid api key') as Error & { status: number };
      e.status = 401;
      throw e;
    }
    async stream(args: LLMCallArgs): Promise<LLMResponse> { return this.chat(args); }
  }

  const primary = new OverloadedLLM();
  const backup  = new HealthyLLM();
  const llm = new FallbackLLM({ primary, alternates: [backup] });
  const r = await llm.chat({ messages: [] });
  assert(r.content === 'hi from healthy', 'overloaded 切到 healthy');
  assert(primary.callCount === 1, 'primary 被调过 1 次');
  assert(backup.callCount === 1, 'backup 被调过 1 次');

  // 非 outage 类错误（401）→ 不切，直接抛
  const p2 = new BadRequestLLM();
  const b2 = new HealthyLLM();
  const llm2 = new FallbackLLM({ primary: p2, alternates: [b2] });
  let caught: unknown;
  try { await llm2.chat({ messages: [] }); } catch (err) { caught = err; }
  assert(caught instanceof Error && /invalid api key/.test((caught as Error).message), '401 直接抛，不降级');
  assert(p2.callCount === 1, '401: primary 调过 1 次');
  assert(b2.callCount === 0, '401: backup 未被调用');

  // 链上多个 provider 都挂 → 抛最后一个错
  const p3 = new OverloadedLLM();
  const m3 = new OverloadedLLM();
  const m3b = new HealthyLLM();
  const llm3 = new FallbackLLM({ primary: p3, alternates: [m3, m3b] });
  const r3 = await llm3.chat({ messages: [] });
  assert(r3.content === 'hi from healthy', '链：两个 outage 后切到第三家');
  assert(p3.callCount === 1 && m3.callCount === 1 && m3b.callCount === 1, '前两家各调一次后切到第三家');
}

// ───── C. AbortSignal 通过 ToolCtx 传给 tool handler ─────
{
  const reg = new ToolRegistry();
  // 注册一个"长跑"工具：会监听 signal
  reg.register({
    name: 'slow_tool',
    description: 'sleeps until aborted or 1s',
    parameters: { type: 'object', properties: {} },
    allowedAgents: [],
    handler: async (_input, ctx) => {
      return new Promise((resolve, reject) => {
        const to = setTimeout(() => resolve('finished'), 1000);
        ctx.signal?.addEventListener('abort', () => {
          clearTimeout(to);
          reject(new Error('aborted by signal'));
        });
      });
    },
  });

  // 未 abort：1s 内完成
  const t0 = Date.now();
  const ok = await reg.invoke('slow_tool', {}, {});
  assert(ok === 'finished', '未 abort：返回 finished');
  assert(Date.now() - t0 >= 900, '确实等了 ~1s');

  // 立刻 abort：tool 快速失败
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  let caught: unknown;
  const t1 = Date.now();
  try {
    await reg.invoke('slow_tool', {}, { signal: ac.signal });
  } catch (err) { caught = err; }
  const elapsed = Date.now() - t1;
  assert(caught instanceof Error && /aborted/.test((caught as Error).message), 'abort → 抛 aborted by signal');
  assert(elapsed < 300, `abort 后 < 300ms 拒绝（实际 ${elapsed}ms）`);
}

console.log('\n全部通过 ✅');
