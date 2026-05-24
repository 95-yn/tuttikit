/**
 * run_command tool 测试：
 *   A. 合法命令（echo / ls / git）跑通 + stdout 拿到 + exitCode 0
 *   B. 不在白名单的命令拒绝（rm / curl / 不存在命令）
 *   C. cwd 越界检查（../ / 绝对路径 / 不在 allowlist 的目录）
 *   D. 超时 SIGTERM
 *   E. 输出截断（stdout > 50KB）
 *   F. 退出码非 0 传回（不抛错；返回 exitCode）
 *   G. safety hook 拦危险参数（rm -rf 写在 args 里）—— 走 ToolRegistry.invoke
 */
process.env.LOG_LEVEL ??= 'warn';
process.env.LLM_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runcmd-test-db-'));
const { setDBPath, closeDB } = await import('../src/core/db.js');
setDBPath(path.join(tmpDir, 'test.db'));

const { ToolRegistry } = await import('../src/tools/registry.js');
const { runCommandTool } = await import('../src/tools/runCommand.js');
const { installDefaultSafetyHooks } = await import('../src/core/safetyRules.js');
const { clearHooks } = await import('../src/core/hooks.js');

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

// ───── A. 合法命令 ─────
{
  const r = await runCommandTool.handler({ command: 'echo', args: ['hello'] }, {});
  assert(r.exitCode === 0, `[A] echo 返回 0（实际 ${r.exitCode}）`);
  assert(r.stdout.trim() === 'hello', `[A] stdout = "hello"（实际 ${JSON.stringify(r.stdout)}）`);
  assert(r.stderr === '', '[A] stderr 为空');
  assert(r.executed.command === 'echo', '[A] executed.command 正确');

  // ls 项目根
  const r2 = await runCommandTool.handler({ command: 'ls', args: ['-la'] }, {});
  assert(r2.exitCode === 0, '[A] ls 返回 0');
  assert(r2.stdout.includes('package.json') || r2.stdout.includes('apps'), '[A] ls 看到 package.json/apps');

  // git status
  const r3 = await runCommandTool.handler({ command: 'git', args: ['log', '--oneline', '-1'] }, {});
  assert(r3.exitCode === 0, '[A] git log 返回 0');
  assert(/[a-f0-9]{7}/.test(r3.stdout), '[A] git log 含 commit hash');
}

// ───── B. 白名单拒绝 ─────
{
  let caught = false;
  let msg = '';
  try { await runCommandTool.handler({ command: 'rm', args: ['file.txt'] }, {}); }
  catch (err) { caught = true; msg = (err as Error).message; }
  assert(caught, '[B] rm 不在白名单被拒');
  assert(/白名单|allow/i.test(msg), `[B] 错误信息提到白名单（${msg.slice(0,80)}）`);

  let caught2 = false;
  try { await runCommandTool.handler({ command: 'curl', args: ['http://x'] }, {}); }
  catch { caught2 = true; }
  assert(caught2, '[B] curl 不在白名单被拒');

  let caught3 = false;
  try { await runCommandTool.handler({ command: 'mkfs.ext4' }, {}); }
  catch { caught3 = true; }
  assert(caught3, '[B] 危险命令被拒');
}

// ───── C. cwd 越界 ─────
{
  let caught = false;
  try { await runCommandTool.handler({ command: 'ls', cwd: '../../../etc' }, {}); }
  catch { caught = true; }
  assert(caught, '[C] ../ 越界被拒');

  let caught2 = false;
  try { await runCommandTool.handler({ command: 'ls', cwd: '/etc' }, {}); }
  catch { caught2 = true; }
  assert(caught2, '[C] 绝对路径越界被拒');

  // 在 allowlist 内的 cwd 正常（注意 test 跑时 cwd 是 apps/server，所以用 examples 子目录）
  const r = await runCommandTool.handler({ command: 'ls', cwd: 'examples' }, {});
  assert(r.exitCode === 0, '[C] cwd=examples 正常运行');
  assert(r.stdout.includes('test-run-command.ts'), '[C] cwd 实际在 examples 目录');
}

// ───── D. 超时 ─────
{
  // python -c "import time; time.sleep(5)"  应 2s 超时
  const r = await runCommandTool.handler({
    command: 'python3',
    args: ['-c', 'import time; time.sleep(10)'],
    timeoutMs: 1500,
  }, {});
  // SIGTERM 后 python 退出码通常 None/null/-15；接受任何非 0
  assert(r.exitCode !== 0, `[D] 超时后 exitCode 非 0（实际 ${r.exitCode}）`);
  assert(r.durationMs >= 1500 && r.durationMs < 10_000, `[D] 时间在 [1500, 10000)（实际 ${r.durationMs}）`);
}

// ───── E. 输出截断 ─────
{
  // 生成 > 50KB 的输出
  const r = await runCommandTool.handler({
    command: 'python3',
    args: ['-c', 'print("x" * 100_000)'],
  }, {});
  assert(r.truncated.stdout === true, '[E] stdout 超 50KB 标记 truncated');
  assert(r.stdout.length <= 50_000, `[E] stdout 实际 ≤ 50KB（实际 ${r.stdout.length}）`);
}

// ───── F. 非 0 exitCode 传回 ─────
{
  // false 命令永远退出 1
  const r = await runCommandTool.handler({ command: 'false' }, {});
  assert(r.exitCode === 1, `[F] false 返回 1（实际 ${r.exitCode}）`);
}

// ───── G. safety hook 拦危险 args（走 ToolRegistry.invoke 完整路径）─────
clearHooks();
installDefaultSafetyHooks();
{
  const registry = new ToolRegistry();
  registry.register({ ...runCommandTool, allowedAgents: ['conductor'] });

  // git reset --hard 在 args 里 —— 走 approval 不是 safety；先测 fork bomb / DROP DATABASE 这种硬拦
  let blocked = false;
  try {
    await registry.invoke('run_command', { command: 'echo', args: ['DROP DATABASE x'] }, { agent: 'conductor', sessionId: 's' });
  } catch (err) {
    blocked = (err as { name?: string })?.name === 'SafetyDeniedError';
  }
  assert(blocked, '[G] echo 的 args 含 DROP DATABASE 被 safety hook 拦');

  // 合法命令不误拦
  const ok = await registry.invoke('run_command', { command: 'echo', args: ['hello'] }, { agent: 'conductor', sessionId: 's' }) as { exitCode: number };
  assert(ok.exitCode === 0, '[G] 合法 echo 不被误拦');
}

closeDB();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n全部通过 ✅');
