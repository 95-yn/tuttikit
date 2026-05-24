/**
 * #2 todo.md + #3 failures.md 测试：
 *   A. todo_add → 文件落盘 + parse 回来
 *   B. todo_start / done / fail 改状态 + 跨调用持久
 *   C. formatForPrompt 包含 open + recent done/failed
 *   D. failure_log 写文件 + dedup（同 sessionId+task 只留最新）
 *   E. failure_log cap 200（FAILURE_LOG_MAX）
 *   F. failure_search 按 query substring 匹配
 *   G. recentFailuresForPrompt query 命中走过滤、未命中 fallback 最近
 *   H. 并发 todo_add（per-sessionId 锁）不丢条目
 */
process.env.LOG_LEVEL ??= 'warn';
process.env.LLM_PROVIDER = 'mock';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 切到隔离的临时 cwd 让 data/agents/ 不污染主 repo
const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-fail-cwd-'));
const origCwd = process.cwd();
process.chdir(tmpCwd);

// 降低 cap 测试 trim
process.env.FAILURE_LOG_MAX = '5';

const { addItems, setStatus, listAll, formatForPrompt, _resetForTest }
  = await import('../src/core/todoFile.js');
const { logFailure, recentFailuresForPrompt, searchFailures }
  = await import('../src/core/failureLog.js');

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

// ───── A. todo_add ─────
const SID = 's-test';
_resetForTest(SID);
{
  const added = await addItems(SID, ['改 useChat 超时', '写测试', '跑 build']);
  assert(added.length === 3, '[A] 加 3 条');
  assert(added.every((it) => it.id.length === 6 && it.status === 'pending'), '[A] id 6 字符 + pending');

  const items = await listAll(SID);
  assert(items.length === 3, '[A] list 回来 3 条');
  assert(items[0].text === '改 useChat 超时', '[A] 文本保留');
}

// ───── B. setStatus 跨调用持久 ─────
{
  const items = await listAll(SID);
  await setStatus(SID, items[0].id, 'in_progress');
  await setStatus(SID, items[1].id, 'done', '改了 useChat.ts:42');
  await setStatus(SID, items[2].id, 'failed', 'tsc TS2322');

  const after = await listAll(SID);
  assert(after[0].status === 'in_progress', '[B] in_progress');
  assert(after[1].status === 'done', '[B] done');
  assert(after[1].note === '改了 useChat.ts:42', '[B] done note');
  assert(after[2].status === 'failed', '[B] failed');
  assert(after[2].note === 'tsc TS2322', '[B] fail note');
}

// ───── C. formatForPrompt ─────
{
  const text = await formatForPrompt(SID);
  assert(text.includes('改 useChat 超时'), '[C] 含 in_progress 项');
  assert(text.includes('done'), '[C] 含 done 状态');
  assert(text.includes('tsc TS2322'), '[C] 含 failure note');
}

// ───── D. failure_log 写 + dedup ─────
{
  await logFailure({ sessionId: 'sx', task: '跑 tsc', reason: 'TS2322 line 42' });
  await logFailure({ sessionId: 'sy', task: '跑 pytest', reason: 'ModuleNotFoundError' });
  // 同 sessionId + 同 task → 去重，只留最新
  await logFailure({ sessionId: 'sx', task: '跑 tsc', reason: 'TS2322 line 99（新的错）', fix: '改用 number' });
  const found = await searchFailures('tsc');
  assert(found.length === 1, `[D] 同 (sessionId, task) 去重，只有 1 条（实际 ${found.length}）`);
  assert(found[0].reason.includes('99'), '[D] 留最新的');
  assert(found[0].fix === '改用 number', '[D] fix 字段');
}

// ───── E. cap = 5 ─────
{
  for (let i = 0; i < 10; i++) {
    await logFailure({ sessionId: `s-cap-${i}`, task: `task-${i}`, reason: 'r' });
  }
  const all = await searchFailures(''); // 空 query 匹配所有
  // 我们之前已经写了 2 条（sx tsc / sy pytest）+ 10 条新的 = 12 条；cap 5
  // dedup 保留最新版本：sx tsc 仍在，sy pytest 仍在，加 10 条新的 = 12 candidate，trim 到 5
  assert(all.length === 5, `[E] cap=5 trim 到 5 条（实际 ${all.length}）`);
}

// ───── F. failure_search 命中 substring ─────
{
  await logFailure({ sessionId: 'srch', task: '安装 npm 包 react', reason: 'ETIMEDOUT' });
  const r = await searchFailures('react');
  assert(r.some((e) => e.task.includes('react')), '[F] task 命中');
  const r2 = await searchFailures('TIMEDOUT');
  assert(r2.length > 0, '[F] reason 命中（不区分大小写：TIMEDOUT 命中 ETIMEDOUT）');
}

// ───── G. recentFailuresForPrompt ─────
{
  const matched = await recentFailuresForPrompt('npm');
  // 应该把 "安装 npm 包" 那条挑出来
  assert(matched.includes('npm'), '[G] query 命中走过滤');

  const unmatched = await recentFailuresForPrompt('zzz-totally-not-existing');
  assert(unmatched.length > 0, '[G] query 不命中 fallback 最近 5 条');
}

// ───── H. 并发 todo_add（per-sessionId 锁）─────
{
  const SID2 = 's-concurrent';
  _resetForTest(SID2);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => addItems(SID2, [`并发 #${i}`])),
  );
  const items = await listAll(SID2);
  assert(items.length === 20, `[H] 20 并发 add 全部到位（实际 ${items.length}）`);
  // id 都不同
  const ids = new Set(items.map((it) => it.id));
  assert(ids.size === 20, '[H] 20 个 id 互不重复');
}

// ───── I. todo tool 通过 ToolRegistry emit SSE ─────
{
  const { ToolRegistry } = await import('../src/tools/registry.js');
  const { todoAddTool, todoDoneTool } = await import('../src/tools/todo.js');
  const { MessageBus } = await import('../src/core/messageBus.js');
  const registry = new ToolRegistry();
  registry.register({ ...todoAddTool, allowedAgents: ['conductor'] });
  registry.register({ ...todoDoneTool, allowedAgents: ['conductor'] });

  const bus = new MessageBus();
  let emitted: { sessionId: string; items: unknown[] } | null = null;
  bus.on('todo:updated', (p) => { emitted = p as typeof emitted; });

  const r = await registry.invoke('todo_add', { items: ['新项 1', '新项 2'] },
    { agent: 'conductor', sessionId: 's-sse', bus }) as { added: Array<{ id: string }> };
  assert(emitted !== null, '[I] todo_add emit todo:updated');
  assert(emitted!.sessionId === 's-sse', '[I] sessionId 正确');
  assert(emitted!.items.length === 2, `[I] 发出 2 个 item（实际 ${emitted!.items.length}）`);

  emitted = null;
  await registry.invoke('todo_done', { id: r.added[0].id, note: '完事' },
    { agent: 'conductor', sessionId: 's-sse', bus });
  assert(emitted !== null, '[I] todo_done 也 emit');
}

process.chdir(origCwd);
fs.rmSync(tmpCwd, { recursive: true, force: true });
console.log('\n全部通过 ✅');
