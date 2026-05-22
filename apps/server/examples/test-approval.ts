/**
 * 动态审批测试：
 *   A. requestApproval Pending → resolveApproval 让 Promise 兑现
 *   B. 超时自动 deny
 *   C. abort signal 立即 deny
 *   D. 同 session 并发 pending → 第二个直接 deny
 *   E. installApprovalHook 命中 → 等待审批；用户点 Approve / Deny → 走对应分支
 *   F. session 删除（cancelAllForSession）→ 所有 pending 兜底 deny
 */
process.env.LOG_LEVEL ??= 'warn';

import { MessageBus } from '../src/core/messageBus.js';
import { clearHooks, runHooks } from '../src/core/hooks.js';
import {
  requestApproval, resolveApproval, listPending, cancelAllForSession,
  installApprovalHook, DEFAULT_APPROVAL_RULES,
} from '../src/core/approval.js';

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// ───── A. resolveApproval 路径 ─────
{
  const bus = new MessageBus();
  let requested: { requestId: string; sessionId: string } | null = null;
  bus.on('permission:requested', (p) => { requested = p as typeof requested; });

  const promise = requestApproval({
    sessionId: 's1', toolName: 't', input: { x: 1 },
    rule: 'r', reason: 'why', bus,
  });
  // 给 emit 跑一拍
  await delay(10);
  assert(requested !== null, '[A] permission:requested 事件被推出');
  assert(listPending('s1').length === 1, '[A] listPending 列出新建的 pending');

  const ok = resolveApproval(requested!.requestId, true);
  assert(ok.ok === true, '[A] resolveApproval 返回 ok');
  const allow = await promise;
  assert(allow === true, '[A] 用户 allow=true → Promise resolve true');
  assert(listPending('s1').length === 0, '[A] resolve 后 pending 列表清空');
}

// ───── B. 超时 ─────
{
  const bus = new MessageBus();
  const start = Date.now();
  const allow = await requestApproval({
    sessionId: 's-timeout', toolName: 't', input: {},
    rule: 'r', reason: 'why', bus, timeoutMs: 80,
  });
  const elapsed = Date.now() - start;
  assert(allow === false, '[B] 超时 → 自动 deny=false');
  assert(elapsed >= 70 && elapsed < 400, `[B] 超时大致在 80ms 附近（实际 ${elapsed}ms）`);
  assert(listPending('s-timeout').length === 0, '[B] 超时后 pending 清空');
}

// ───── C. abort signal ─────
{
  const bus = new MessageBus();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const start = Date.now();
  const allow = await requestApproval({
    sessionId: 's-abort', toolName: 't', input: {},
    rule: 'r', reason: 'why', bus, timeoutMs: 60_000, signal: ac.signal,
  });
  const elapsed = Date.now() - start;
  assert(allow === false, '[C] abort 触发 → deny=false');
  assert(elapsed < 400, `[C] abort 不傻等超时（实际 ${elapsed}ms）`);
}

// 已 aborted 的 signal：立即 deny，不创建 pending
{
  const bus = new MessageBus();
  const ac = new AbortController();
  ac.abort();
  const allow = await requestApproval({
    sessionId: 's-pre-abort', toolName: 't', input: {},
    rule: 'r', reason: 'why', bus, signal: ac.signal,
  });
  assert(allow === false, '[C] pre-aborted signal → 立即 deny');
  assert(listPending('s-pre-abort').length === 0, '[C] pre-aborted 不创建 pending');
}

// ───── D. 并发拒绝 ─────
{
  const bus = new MessageBus();
  let resolved1: ((v: boolean) => void) | null = null;
  const p1 = requestApproval({
    sessionId: 's-concurrent', toolName: 't', input: {}, rule: 'r1', reason: '1', bus, timeoutMs: 5000,
  }).then((v) => { resolved1?.(v); return v; });
  await delay(10);
  // 第二个同 session 的 → 直接 deny
  const p2 = requestApproval({
    sessionId: 's-concurrent', toolName: 't', input: {}, rule: 'r2', reason: '2', bus, timeoutMs: 5000,
  });
  const allow2 = await p2;
  assert(allow2 === false, '[D] 同 session 第二个 pending 直接 deny');
  // 清掉第一个避免 hang
  cancelAllForSession('s-concurrent');
  await p1;
}

// ───── E. installApprovalHook 集成 ─────
clearHooks();
installApprovalHook(DEFAULT_APPROVAL_RULES, 200); // 200ms 短超时让测试快
{
  const bus = new MessageBus();
  let req: { requestId: string } | null = null;
  bus.on('permission:requested', (p) => { req = p as typeof req; });

  // E.1 命中规则 + 用户 allow
  const promise = runHooks('before:tool:call', {
    phase: 'before:tool:call', sessionId: 's-hook', agent: 'conductor',
    toolName: 'shell', input: { command: 'git reset --hard HEAD~1' }, bus,
  });
  await delay(15);
  assert(req !== null, '[E.1] hook 命中规则 → 发出 permission:requested');
  resolveApproval(req!.requestId, true);
  const out = await promise;
  assert(out.allow === true, '[E.1] 用户 allow → hook 返回 allow');
}
clearHooks();
installApprovalHook(DEFAULT_APPROVAL_RULES, 200);
{
  const bus = new MessageBus();
  let req: { requestId: string } | null = null;
  bus.on('permission:requested', (p) => { req = p as typeof req; });

  // E.2 用户 deny
  const promise = runHooks('before:tool:call', {
    phase: 'before:tool:call', sessionId: 's-hook-deny', agent: 'conductor',
    toolName: 'shell', input: { command: 'git push --force origin main' }, bus,
  });
  await delay(15);
  resolveApproval(req!.requestId, false);
  const out = await promise;
  assert(out.allow === false, '[E.2] 用户 deny → hook 返回 deny');
  assert(
    (out as { ruleName: string }).ruleName?.startsWith('approval:'),
    `[E.2] ruleName 标记为 approval: 前缀（实际 ${(out as { ruleName: string }).ruleName}）`,
  );
}
clearHooks();
installApprovalHook(DEFAULT_APPROVAL_RULES, 200);
{
  // E.3 没命中规则 → 直接 allow
  const out = await runHooks('before:tool:call', {
    phase: 'before:tool:call', sessionId: 's-hook-pass', agent: 'conductor',
    toolName: 'shell', input: { command: 'ls -la' }, bus: new MessageBus(),
  });
  assert(out.allow === true, '[E.3] 不命中审批规则 → 直接 allow');
}

// ───── F. cancelAllForSession ─────
clearHooks();
installApprovalHook(DEFAULT_APPROVAL_RULES, 60_000);  // 长超时确保不是超时清掉的
{
  const bus = new MessageBus();
  const promise = runHooks('before:tool:call', {
    phase: 'before:tool:call', sessionId: 's-cancel', agent: 'conductor',
    toolName: 'shell', input: { command: 'git reset --hard HEAD~1' }, bus,
  });
  await delay(15);
  assert(listPending('s-cancel').length === 1, '[F] 创建了 1 个 pending');

  cancelAllForSession('s-cancel');
  const out = await promise;
  assert(out.allow === false, '[F] cancel 后 hook 返回 deny');
  assert(listPending('s-cancel').length === 0, '[F] cancel 后 pending 列表清空');
}

console.log('\n全部通过 ✅');
console.log(`内置审批规则 ${DEFAULT_APPROVAL_RULES.length} 条`);
