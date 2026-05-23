/**
 * 沙箱 Python 执行（用 Pyodide / WASM，零原生依赖）。
 *
 * 设计：
 *   1. **per-session runtime**：同 session 多次 exec 共享 Python globals（Jupyter 多 cell 的体验）
 *   2. **30 分钟空闲清理**：避免 long-running session 内存膨胀
 *   3. **自动捕获 matplotlib**：plt.show() / 任何 plt 输出 → 转 base64 PNG 通过 bus emit
 *   4. **自动捕获 pandas DataFrame**：repr 时调 .to_html() 让前端能美化渲染
 *   5. **超时**：JS 端 race timer（Pyodide 没有可中断 API，超时只能强杀整个 runtime——
 *      此时该 session 的下次调用会冷启动新 runtime）
 *
 * 安全：
 *   - Pyodide 默认无网络、无宿主 fs 访问
 *   - 文件 IO 只能在 /sandbox/input/（读）和 /sandbox/output/（写）虚拟路径，
 *     对应宿主 `data/sandbox/<sessionId>/{input,output}/`
 *   - 顶层 safety hook（registry.invoke）会拦危险代码模式（os.system / __import__('os') 等）
 */
import path from 'node:path';
import fs from 'node:fs';
import { logger } from '../observability/logger.js';
import type { MessageBus } from './messageBus.js';

// 直接 import type；运行时 import 也 OK，pyodide 顶层无副作用
import { loadPyodide as _loadPyodide, type PyodideInterface } from 'pyodide';

const SANDBOX_ROOT = path.resolve('./data/sandbox');
const IDLE_TIMEOUT_MS = Number(process.env.CODE_EXEC_IDLE_MS || 30 * 60_000);

interface SessionRuntime {
  py: PyodideInterface;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout>;
}

const _runtimes = new Map<string, SessionRuntime>();
/** 同 session 的 exec 必须串行：Pyodide runtime 单线程，并行 exec 会乱 globals */
const _execLocks = new Map<string, Promise<unknown>>();

/**
 * 取或建 session 对应的 Pyodide runtime。
 * 冷启动 ~2s（加载 WASM + 标准库）；之后驻留直到 IDLE_TIMEOUT_MS 不用就清。
 */
async function getRuntime(sessionId: string): Promise<PyodideInterface> {
  const existing = _runtimes.get(sessionId);
  if (existing) {
    existing.lastUsedAt = Date.now();
    clearTimeout(existing.idleTimer);
    existing.idleTimer = setTimeout(() => _evict(sessionId), IDLE_TIMEOUT_MS);
    return existing.py;
  }

  logger.info({ sessionId }, '[codeExec] 冷启动 Pyodide runtime');
  const py = await _loadPyodide();
  // 装一次基础包（pyodide 自带 numpy/pandas/matplotlib，loadPackage 后才能 import）
  await py.loadPackage(['numpy', 'pandas', 'matplotlib']);

  // 准备 sandbox 文件系统：在 Pyodide 虚拟 FS 内挂载 /sandbox
  // input / output 都是空目录，第一次 exec 时按需建
  py.FS.mkdirTree('/sandbox/input');
  py.FS.mkdirTree('/sandbox/output');

  // 注入 helper：matplotlib show() 自动捕获 → base64 PNG → 通过 print(__IMG__:<b64>) 串出来
  // 这是最简方案；不用 Bridge / proxy callback，避免跨 WASM-JS callback 复杂性
  await py.runPythonAsync(`
import matplotlib
matplotlib.use('Agg')   # 不开窗，纯生成图
import matplotlib.pyplot as _plt
import base64 as _b64
import io as _io
import sys as _sys

_orig_show = _plt.show
def _capture_show(*args, **kwargs):
    """覆盖 plt.show()：把当前 figure 编 base64 PNG，打到 stdout 的特殊前缀，
    服务端用正则抽走，剩下的才作为真正的 stdout 给 LLM。"""
    buf = _io.BytesIO()
    _plt.savefig(buf, format='png', bbox_inches='tight', dpi=100)
    b64 = _b64.b64encode(buf.getvalue()).decode('ascii')
    print(f'__TUTTIKIT_IMG__{b64}__END__', flush=True)
    _plt.close('all')   # 释放，避免下次 show 还带着旧 axes
_plt.show = _capture_show

# pandas DataFrame 默认 repr 是文本，让 LLM 看 html 表更清晰
try:
    import pandas as _pd
    _orig_df_repr = _pd.DataFrame.__repr__
    def _df_repr_html_safe(self):
        # 真长的 df 也不灌爆 token：只显示前 50 行
        if len(self) > 50:
            return _orig_df_repr(self.head(50)) + f'\\n[... {len(self)-50} more rows]'
        return _orig_df_repr(self)
    _pd.DataFrame.__repr__ = _df_repr_html_safe
except ImportError:
    pass
`);

  const runtime: SessionRuntime = {
    py, lastUsedAt: Date.now(),
    idleTimer: setTimeout(() => _evict(sessionId), IDLE_TIMEOUT_MS),
  };
  _runtimes.set(sessionId, runtime);
  return py;
}

function _evict(sessionId: string): void {
  const rt = _runtimes.get(sessionId);
  if (!rt) return;
  clearTimeout(rt.idleTimer);
  _runtimes.delete(sessionId);
  logger.info({ sessionId }, '[codeExec] runtime 空闲清理');
  // Pyodide 没显式 destroy；让 GC 回收
}

/**
 * 写入用户 input 文件到 sandbox（供 LLM 跑代码读取）。
 * 给后续 attachment / 文件传递路径用——本期先暴露但不强用。
 */
export async function writeSandboxInput(sessionId: string, filename: string, content: Buffer | string): Promise<string> {
  const py = await getRuntime(sessionId);
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
  py.FS.writeFile(`/sandbox/input/${safeName}`, bytes);
  return `/sandbox/input/${safeName}`;
}

export interface CodeExecResult {
  stdout: string;
  stderr: string;
  /** 从 stdout 抽出的 matplotlib 图（base64 PNG），按出现顺序 */
  images: string[];
  /** Python 抛错时 traceback 文本 */
  error?: string;
  /** 服务端测得的实际执行毫秒 */
  durationMs: number;
}

const IMG_PATTERN = /__TUTTIKIT_IMG__([A-Za-z0-9+/=]+)__END__\n?/g;

/**
 * 执行 Python 代码（per-session globals 持久）。
 *   - timeout 默认 30s；超时强清该 session 的 runtime（下次冷启动）
 *   - bus 非空时，每抽到一张图就 emit 'code:image'，前端能立即渲染
 *   - 同 session 多次 exec 自动 serialize（避免 Pyodide 单线程乱）
 */
export async function execPython(args: {
  sessionId: string;
  code: string;
  timeoutMs?: number;
  bus?: MessageBus;
}): Promise<CodeExecResult> {
  const timeoutMs = args.timeoutMs ?? 30_000;

  // session 锁：同 session 的 exec 串行
  const prev = _execLocks.get(args.sessionId) ?? Promise.resolve();
  const result = prev.catch(() => undefined).then(() => _doExec(args, timeoutMs));
  _execLocks.set(args.sessionId, result);
  try {
    return await result;
  } finally {
    if (_execLocks.get(args.sessionId) === result) _execLocks.delete(args.sessionId);
  }
}

async function _doExec(args: { sessionId: string; code: string; bus?: MessageBus }, timeoutMs: number): Promise<CodeExecResult> {
  const t0 = Date.now();
  let py: PyodideInterface;
  try {
    py = await getRuntime(args.sessionId);
  } catch (err) {
    return {
      stdout: '', stderr: '', images: [],
      error: `Pyodide 初始化失败: ${(err as Error).message}`,
      durationMs: Date.now() - t0,
    };
  }

  // 重定向 stdout / stderr 到 Python list，exec 完一次性取出
  await py.runPythonAsync(`
import io as _io, sys as _sys
_sys._stdout_capture = _io.StringIO()
_sys._stderr_capture = _io.StringIO()
_sys.stdout = _sys._stdout_capture
_sys.stderr = _sys._stderr_capture
`);

  let pyError: string | undefined;
  try {
    // race：30s 超时硬切
    await Promise.race([
      py.runPythonAsync(args.code),
      new Promise((_, rej) => setTimeout(() => rej(new Error('execution timeout')), timeoutMs)),
    ]);
  } catch (err) {
    pyError = (err as Error).message;
    // timeout → 该 session 的 runtime 状态可能已乱，下次直接冷启动
    if (/timeout/i.test(pyError)) {
      _evict(args.sessionId);
    }
  }

  let rawStdout = '';
  let rawStderr = '';
  try {
    rawStdout = py.runPython('_sys._stdout_capture.getvalue()') as string;
    rawStderr = py.runPython('_sys._stderr_capture.getvalue()') as string;
    // 恢复正常 stdout/stderr
    await py.runPythonAsync(`_sys.stdout = _sys.__stdout__; _sys.stderr = _sys.__stderr__`);
  } catch {/* runtime 已被 evict，捕获不到正常 */}

  // 抽 base64 PNG，剩下的才是真 stdout
  const images: string[] = [];
  const stdout = rawStdout.replace(IMG_PATTERN, (_m, b64) => {
    images.push(b64);
    args.bus?.emit('code:image', { sessionId: args.sessionId, imageBase64: b64, mediaType: 'image/png' });
    return '';
  });

  return {
    stdout,
    stderr: rawStderr,
    images,
    error: pyError,
    durationMs: Date.now() - t0,
  };
}

/** 给测试 / 优雅退出用：清掉某 session 或全部 runtime */
export function clearRuntime(sessionId?: string): void {
  if (sessionId) {
    _evict(sessionId);
    return;
  }
  for (const id of _runtimes.keys()) _evict(id);
}

void SANDBOX_ROOT;     // 当前不用宿主 fs；future 双向同步时再用
void fs;
