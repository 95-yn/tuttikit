/**
 * 副作用模块：在 import 'node:sqlite' 之前 monkey-patch process.emit，
 * 拦截 sqlite 的 ExperimentalWarning（每次 import 打 stderr 污染日志）。
 *
 * 为什么 monkey-patch 而不是 process.on('warning', ...)：
 *   - Node 默认 warning handler 也是一个 listener；自定义 listener 只是**追加**一个，
 *     无法阻止 Node 把 warning 打到 stderr
 *   - 只有 override emit 本身才能"屏蔽" warning（让它根本不被发出）
 *
 * 等 node:sqlite 转 stable（预计 Node 25+）就可以删掉这个文件。
 */
const _origEmit = process.emit.bind(process);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as unknown as { emit: (...args: any[]) => boolean }).emit = function patched(name: string | symbol, ...args: unknown[]) {
  if (name === 'warning') {
    const w = args[0] as { name?: string; message?: string } | undefined;
    if (w?.name === 'ExperimentalWarning' && typeof w?.message === 'string' && /SQLite/i.test(w.message)) {
      return false;       // 吞掉这条 warning：Node 默认 handler 不会被触发
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (_origEmit as any)(name, ...args);
};
