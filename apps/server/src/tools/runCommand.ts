/**
 * `run_command` tool —— 让 LLM 跑 shell 命令拿 stdout/stderr/exit code。
 *
 * 这是 Cline / Devin / OpenHands / Cursor 的核心闭环：写代码 → 跑 `pnpm test` / `tsc` → 看输出 → 改 bug → 再跑。
 *
 * 安全设计：
 *   1. **白名单**：默认只允许常见 dev 命令（pnpm/npm/yarn/python/pytest/tsc/node/go/cargo/git/ls/cat/echo/grep/...）
 *      env `RUN_COMMAND_EXTRA_ALLOWED=docker,kubectl` 扩展
 *   2. **不走 sh -c**：array form `{ command: 'pnpm', args: ['test'] }`，shell metachar 不会被解释
 *      LLM 想 pipe → 分两步分别调 run_command 自己处理
 *   3. **走 ToolRegistry.invoke**：safety hook 自动接，rm -rf / DROP DATABASE 等仍被拦
 *   4. **cwd 越界检查**：必须落在 FS_WRITE_ALLOWLIST 根目录内
 *   5. **输出截断**：stdout/stderr 各 50KB 上限防 LLM 吃 100MB build log
 *   6. **超时硬 kill**：SIGTERM → 5s 后 SIGKILL
 *
 * 已知 limitation：
 *   - npm install xxx-malicious 这种 supply-chain 攻击拦不到（命令本身合法）
 *   - shell pipeline / 重定向不支持（array form 的代价）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import type { ToolSpec } from '../types.js';
import { logger } from '../observability/logger.js';

const Input = z.object({
  command: z.string().min(1).describe('可执行命令名，如 pnpm / git / pytest'),
  args: z.array(z.string()).max(50).optional().describe('参数数组；不会走 shell，metachar 不会被解释'),
  cwd: z.string().optional().describe('工作目录（相对项目根）；必须落在 FS_WRITE_ALLOWLIST 内'),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional().describe('超时毫秒；默认 60000'),
  env: z.record(z.string()).optional().describe('额外环境变量（merge 到当前 process.env）'),
});

const DEFAULT_ALLOWED = [
  // package managers
  'pnpm', 'npm', 'yarn', 'bun',
  // language runtimes & tools
  'node', 'tsx', 'ts-node', 'tsc', 'eslint', 'prettier',
  'python', 'python3', 'pip', 'pip3', 'pytest', 'ruff', 'mypy', 'black',
  'go', 'gofmt', 'cargo', 'rustc',
  // git
  'git',
  // file inspection (read-only-ish)
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'awk', 'sed', 'sort', 'uniq', 'diff', 'tr',
  // common utilities
  'echo', 'pwd', 'date', 'which', 'env', 'true', 'false',
];

function allowedList(): Set<string> {
  const extra = (process.env.RUN_COMMAND_EXTRA_ALLOWED || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return new Set([...DEFAULT_ALLOWED, ...extra]);
}

function isCwdAllowed(rawCwd: string): boolean {
  const root = process.cwd();
  const abs = path.resolve(root, rawCwd);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  // 复用 fileSystem 的 FS_WRITE_ALLOWLIST 思路：cwd 必须在 allowlist 根之一下
  // 默认允许的根：project root（""）/ data / tmp / output / apps / docs（cwd 比 write 宽松）
  const allowed = (process.env.RUN_COMMAND_CWD_ALLOWLIST
    || (process.env.FS_WRITE_ALLOWLIST || 'data,tmp,output') + ',apps,docs,scripts,eval,examples,public')
    .split(',').map((s) => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
  // project root（rel === ''）总是允许
  if (rel === '') return true;
  return allowed.some((a) => rel === a || rel.startsWith(a + '/'));
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  truncated: { stdout: boolean; stderr: boolean };
  /** 实际跑的：command + args + cwd（便于调试） */
  executed: { command: string; args: string[]; cwd: string };
}

const MAX_BYTES = 50_000;

export const runCommandTool: ToolSpec<z.infer<typeof Input>, RunCommandResult> = {
  name: 'run_command',
  description:
    '跑一条 shell 命令拿 stdout/stderr/exit。array form，**不走 shell**，metachar 不会被解释。\n' +
    '白名单：pnpm/npm/yarn/python/pytest/tsc/node/go/cargo/git/ls/cat/echo/grep 等（RUN_COMMAND_EXTRA_ALLOWED 扩展）。\n' +
    '超时默认 60s，stdout/stderr 各 50KB 截断。\n' +
    '用法：跑测试 / 打包 / lint / git log，看 exit code 判断成功。',
  parameters: {
    type: 'object',
    properties: {
      command:   { type: 'string',  description: '命令名' },
      args:      { type: 'array', items: { type: 'string' }, description: '参数数组（不会走 shell）' },
      cwd:       { type: 'string',  description: '工作目录（相对项目根）' },
      timeoutMs: { type: 'integer', description: '超时毫秒（默认 60000）' },
      env:       { type: 'object',  description: '额外环境变量' },
    },
    required: ['command'],
  },
  inputSchema: Input,
  allowedAgents: ['conductor', 'coder', 'reviewer'],
  async handler({ command, args, cwd, timeoutMs, env }) {
    // 白名单检查
    const allowed = allowedList();
    if (!allowed.has(command)) {
      throw new Error(`命令 "${command}" 不在白名单。允许的：${[...allowed].slice(0, 20).join(', ')}... （env RUN_COMMAND_EXTRA_ALLOWED 扩展）`);
    }
    // cwd 检查
    const finalCwd = cwd ?? '';
    if (!isCwdAllowed(finalCwd)) {
      throw new Error(`cwd "${cwd}" 越界或不在 allowlist（env RUN_COMMAND_CWD_ALLOWLIST / FS_WRITE_ALLOWLIST）`);
    }
    const absCwd = path.resolve(process.cwd(), finalCwd);
    const finalArgs = args ?? [];
    const finalTimeoutMs = timeoutMs ?? 60_000;

    const t0 = Date.now();
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    return await new Promise<RunCommandResult>((resolve) => {
      const child = spawn(command, finalArgs, {
        cwd: absCwd,
        env: { ...process.env, ...(env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,    // 关键：不走 shell，metachar 不被解释
      });

      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length + d.length <= MAX_BYTES) stdout += d.toString();
        else if (!stdoutTruncated) {
          stdout += d.toString().slice(0, MAX_BYTES - stdout.length);
          stdoutTruncated = true;
        }
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length + d.length <= MAX_BYTES) stderr += d.toString();
        else if (!stderrTruncated) {
          stderr += d.toString().slice(0, MAX_BYTES - stderr.length);
          stderrTruncated = true;
        }
      });

      const killTimer = setTimeout(() => {
        logger.warn({ command, finalArgs, finalTimeoutMs }, '[run_command] 超时 SIGTERM');
        child.kill('SIGTERM');
        // 5s 后还没退 → SIGKILL
        setTimeout(() => {
          if (!child.killed) {
            logger.warn({ command }, '[run_command] SIGTERM 5s 后仍活，发 SIGKILL');
            child.kill('SIGKILL');
          }
        }, 5_000);
      }, finalTimeoutMs);

      child.on('error', (err) => {
        clearTimeout(killTimer);
        resolve({
          stdout, stderr: stderr + `\n[spawn error] ${err.message}`,
          exitCode: -1,
          durationMs: Date.now() - t0,
          truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
          executed: { command, args: finalArgs, cwd: absCwd },
        });
      });

      child.on('exit', (code) => {
        clearTimeout(killTimer);
        resolve({
          stdout, stderr,
          exitCode: code,
          durationMs: Date.now() - t0,
          truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
          executed: { command, args: finalArgs, cwd: absCwd },
        });
      });
    });
  },
};
