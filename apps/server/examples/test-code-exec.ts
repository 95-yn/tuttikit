/**
 * Pyodide 沙箱执行测试：
 *   A. 基本 print
 *   B. session 持久 globals（多次 exec 共享变量）
 *   C. numpy / pandas 可用
 *   D. matplotlib 出图（自动捕获 base64 PNG）
 *   E. 超时硬切
 *   F. Python 语法错误被 capture 到 error，不挂宿主
 *   G. 沙箱不能访问宿主文件系统 / 网络
 *   H. safety hook 拦截 os.system 类危险代码（通过 ToolRegistry 走完整路径）
 */
process.env.LOG_LEVEL ??= 'warn';

import { MessageBus } from '../src/core/messageBus.js';
import { execPython, clearRuntime } from '../src/core/codeExec.js';
import { clearHooks } from '../src/core/hooks.js';
import { installDefaultSafetyHooks } from '../src/core/safetyRules.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { codeExecTool } from '../src/tools/codeExec.js';

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

const SID = 'test-codeexec';

// ───── A. 基本 print ─────
{
  const r = await execPython({ sessionId: SID, code: 'print("hello")' });
  assert(r.error === undefined, `[A] 无错（实际 ${r.error}）`);
  assert(r.stdout.trim() === 'hello', `[A] stdout = "hello"（实际 ${JSON.stringify(r.stdout)}）`);
  assert(r.images.length === 0, '[A] 无图');
}

// ───── B. session 持久 globals ─────
{
  await execPython({ sessionId: SID, code: 'x = 42' });
  const r = await execPython({ sessionId: SID, code: 'print(x * 2)' });
  assert(r.stdout.trim() === '84', `[B] 跨 exec 共享变量 x（实际 ${r.stdout.trim()}）`);
}

// ───── C. numpy / pandas 可用 ─────
{
  const r = await execPython({
    sessionId: SID,
    code: 'import numpy as np\nimport pandas as pd\nprint(np.array([1,2,3]).sum())\nprint(pd.DataFrame({"a":[1,2]}).shape)',
  });
  assert(r.error === undefined, `[C] numpy/pandas 无错（实际 ${r.error}）`);
  assert(r.stdout.includes('6'), '[C] numpy sum=6');
  assert(r.stdout.includes('(2, 1)'), '[C] pandas shape=(2,1)');
}

// ───── D. matplotlib 自动出图 ─────
{
  const bus = new MessageBus();
  let emitted = 0;
  bus.on('code:image', () => { emitted++; });

  const r = await execPython({
    sessionId: SID,
    bus,
    code: `
import matplotlib.pyplot as plt
plt.figure()
plt.plot([1,2,3], [4,5,6])
plt.title("test")
plt.show()
`,
  });
  assert(r.error === undefined, `[D] matplotlib 无错（实际 ${r.error}）`);
  assert(r.images.length === 1, `[D] 抽到 1 张图（实际 ${r.images.length}）`);
  assert(r.images[0].length > 1000, '[D] PNG base64 非空（> 1000 字符）');
  assert(emitted === 1, `[D] bus emit 'code:image' 1 次（实际 ${emitted}）`);
  // stdout 已经把图前缀串抽走了，剩下应该是空
  assert(r.stdout.trim() === '', `[D] stdout 不含图前缀（实际 ${JSON.stringify(r.stdout)}）`);
}

// ───── E. 超时（reject 但因 Pyodide 单线程不能硬中断，等 Python 跑完才能 cleanup）─────
{
  const r = await execPython({
    sessionId: SID,
    timeoutMs: 1000,
    code: 'import time\nfor i in range(20):\n    time.sleep(0.1)',  // 2s 总耗时
  });
  assert(r.error?.includes('timeout'), `[E] 超时报错（实际 ${r.error}）`);
  // durationMs 受 Python 实际跑完时间限制；只断言它 >= timeoutMs
  assert(r.durationMs >= 1000, `[E] 至少跑到 timeout（实际 ${r.durationMs}ms）`);
  // 超时后 runtime 被 evict —— 下次 exec 应当冷启动且 globals 不再有之前的 x
  const next = await execPython({ sessionId: SID, code: 'print("x" in dir())' });
  assert(next.stdout.trim() === 'False', '[E] 超时后 runtime 重启，globals 清空');
}

// ───── F. Python 语法错误被 capture ─────
{
  const r = await execPython({ sessionId: SID, code: 'print(1 + )' });
  assert(r.error !== undefined, `[F] 语法错误被捕获（实际 ${r.error}）`);
  // Pyodide PythonError.message 可能空，traceback 在 stderr / message 里
  const traceback = r.error + r.stderr;
  assert(/SyntaxError|invalid syntax|expected/i.test(traceback), `[F] traceback 含语法错误信息（实际 ${traceback.slice(0,200)}）`);
}

// ───── G. 沙箱隔离：宿主 fs / network 不可达 ─────
{
  const r1 = await execPython({
    sessionId: SID,
    code: 'with open("/etc/passwd") as f: print(f.read()[:10])',
  });
  // Pyodide 虚拟 fs 里没有 /etc/passwd —— 应该 FileNotFoundError
  assert(r1.error !== undefined || /FileNotFoundError|No such file/.test(r1.stdout + r1.stderr),
    `[G] /etc/passwd 不可读（error=${r1.error}, stderr=${r1.stderr}）`);

  // 网络也应该不可达（Pyodide 默认无 urllib —— 它有但走 Emscripten fetch；fetch 在 Node 端不工作）
  const r2 = await execPython({
    sessionId: SID,
    code: 'import urllib.request\ntry:\n    urllib.request.urlopen("http://example.com")\nexcept Exception as e:\n    print("BLOCKED:", type(e).__name__)',
  });
  // Pyodide-in-Node 里 urllib 走 Emscripten 没有真 fetch backend
  // 行为：要么抛 URLError，要么 stdout 含 "BLOCKED:"，都算 ✅
  assert(
    r2.stdout.includes('BLOCKED:') || /URLError|gaierror|ConnectionError|HTTPError|RemoteDisconnected/i.test(r2.stdout + r2.stderr + (r2.error || '')),
    `[G] network 不可达（stdout=${r2.stdout.slice(0, 200)} error=${r2.error}）`,
  );
}

// ───── H. safety hook 拦 Python 危险代码 ─────
clearHooks();
installDefaultSafetyHooks();
{
  const registry = new ToolRegistry();
  registry.register({ ...codeExecTool, allowedAgents: ['conductor'] });

  // os.system 应被 python-os-system 规则拦
  let blocked = false;
  let ruleName = '';
  try {
    await registry.invoke('code_execute',
      { code: 'import os\nos.system("ls /")' },
      { agent: 'conductor', sessionId: SID },
    );
  } catch (err) {
    const e = err as { name?: string; ruleName?: string };
    blocked = e?.name === 'SafetyDeniedError';
    ruleName = e?.ruleName ?? '';
  }
  assert(blocked, '[H] os.system 被 SafetyDeniedError 拦下');
  assert(ruleName === 'python-os-system', `[H] 命中 python-os-system 规则（实际 ${ruleName}）`);

  // __import__("os") 也拦
  let blocked2 = false;
  try {
    await registry.invoke('code_execute',
      { code: 'm = __import__("os")\nm.listdir(".")' },
      { agent: 'conductor', sessionId: SID },
    );
  } catch (err) {
    blocked2 = (err as { name?: string })?.name === 'SafetyDeniedError';
  }
  assert(blocked2, '[H] __import__("os") 被拦');

  // 合法代码不误伤
  const ok = await registry.invoke('code_execute',
    { code: 'print(sum([1,2,3]))' },
    { agent: 'conductor', sessionId: SID },
  ) as { stdout: string };
  assert(ok.stdout.trim() === '6', '[H] 合法 print(sum) 不误伤');
}

clearRuntime();
console.log('\n全部通过 ✅');
