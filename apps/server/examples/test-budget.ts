/**
 * #5 Cost & Budget 测试：
 *   - priceFor 表查：exact + 前缀匹配 + 未知 provider
 *   - BudgetGuard：afterTurn 累加 / beforeTurn 超额抛 / 阈值 warn
 *   - LLMCache：enabled 才命中；key 同输入命中、改输入不命中
 */
process.env.LOG_LEVEL ??= 'warn';

import { priceFor } from '../src/llm/pricing.js';
import { BudgetGuard, BudgetExceededError } from '../src/core/budget.js';
import { LLMCache } from '../src/llm/cache.js';

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

// ───── A. priceFor ─────
{
  // exact
  const a = priceFor('anthropic', 'claude-sonnet-4', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert(a.inputUSD === 3.0, `claude-sonnet-4 1M input = $3.0（实际 $${a.inputUSD}）`);
  assert(a.outputUSD === 15.0, `claude-sonnet-4 1M output = $15.0`);
  assert(a.totalUSD === 18.0, `total = $18`);

  // 前缀匹配：claude-sonnet-4-6 命中 claude-sonnet-4
  const b = priceFor('anthropic', 'claude-sonnet-4-6', { inputTokens: 1000, outputTokens: 500 });
  assert(b.pricing?.input === 3.0, '前缀匹配：claude-sonnet-4-6 → claude-sonnet-4 单价');

  // cacheRead 单价更低
  const c = priceFor('anthropic', 'claude-sonnet-4', {
    inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000,
  });
  assert(c.cacheReadUSD === 0.3, `cacheRead 1M = $0.30（10% 价）`);

  // 未知 provider 不抛错，返回空 cost
  const d = priceFor('unknown', 'whatever', { inputTokens: 100 });
  assert(d.totalUSD === 0 && d.pricing === null, '未知 provider 返回 0 + pricing=null');

  // mock 免费
  const e = priceFor('mock', 'mock', { inputTokens: 10_000_000, outputTokens: 10_000_000 });
  assert(e.totalUSD === 0, 'mock provider 总价 0');
}

// ───── B. BudgetGuard ─────
{
  // 用构造参数覆盖默认阈值，避免依赖 env 加载顺序
  const g = new BudgetGuard({
    enabled: true,
    perSessionMaxUSD: 0.010,
    perSessionMaxTokens: 10_000_000_000,
    perDayMaxUSD: 100,
  });
  // 第一轮：claude-sonnet-4 1k input + 200 output = $0.006（输入贵 $0.003 + 输出 $0.003）
  g.beforeTurn('s1');
  const r1 = g.afterTurn('s1', { inputTokens: 1000, outputTokens: 200 }, 'anthropic', 'claude-sonnet-4');
  assert(r1.turnUSD > 0 && r1.turnUSD < 0.01, `第一轮 USD = $${r1.turnUSD.toFixed(5)}`);
  // 第一轮 USD = 0.006, ratio = 0.6, 不触发 0.8 阈值
  assert(r1.warn === null, '第一轮未触发 warn（< 0.8 阈值）');

  // 第二轮：累计 $0.012 > $0.010 → warn
  g.beforeTurn('s1');
  const r2 = g.afterTurn('s1', { inputTokens: 1000, outputTokens: 200 }, 'anthropic', 'claude-sonnet-4');
  assert(r2.warn?.scope === 'session', '第二轮触发 session warn');
  assert(r2.sessionUSD > 0.010, `session USD = $${r2.sessionUSD.toFixed(5)} 应超 cap`);

  // 第三轮：beforeTurn 直接抛
  let caught: unknown;
  try { g.beforeTurn('s1'); } catch (err) { caught = err; }
  assert(caught instanceof BudgetExceededError, '超额第三轮：beforeTurn 抛 BudgetExceededError');
  assert((caught as BudgetExceededError).scope === 'session', 'scope = session');

  // mock 永远免费 → 不会触发
  const g2 = new BudgetGuard({ enabled: true, perSessionMaxUSD: 0.001, perSessionMaxTokens: 10_000_000_000, perDayMaxUSD: 1 });
  for (let i = 0; i < 100; i++) {
    g2.beforeTurn('s2');
    g2.afterTurn('s2', { inputTokens: 10_000_000, outputTokens: 10_000_000 }, 'mock', 'mock');
  }
  const stats = g2.getSessionStats('s2');
  assert(stats !== null && stats.totalUSD === 0, 'mock × 100 轮 USD = 0');
}

// ───── C. LLMCache ─────
{
  const c = new LLMCache();
  c.enabled = true;
  const args1 = { messages: [{ role: 'user' as const, content: 'hi' }] };
  const args2 = { messages: [{ role: 'user' as const, content: 'hello' }] };
  const k1 = c.key('mock', 'mock', args1);
  const k1b = c.key('mock', 'mock', args1);
  const k2 = c.key('mock', 'mock', args2);
  assert(k1 === k1b, '相同输入 → 相同 key');
  assert(k1 !== k2, '不同输入 → 不同 key');

  assert(c.get(k1) === null, 'miss');
  c.set(k1, { role: 'assistant', content: 'hi back', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } });
  const hit = c.get(k1);
  assert(hit?.content === 'hi back', 'set 后能 get');
  assert(c.stats.hits === 1 && c.stats.misses === 1, 'stats 计数正确');

  // enabled=false 时不命中
  c.enabled = false;
  assert(c.get(k1) === null, 'enabled=false 不命中');
}

console.log('\n全部通过 ✅');
