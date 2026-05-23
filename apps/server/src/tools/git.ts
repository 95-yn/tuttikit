/**
 * Git inspection tools (B 系列：让 LLM 改自己代码时能看清自己改了什么)。
 *
 *   - git_status：列 untracked / modified / staged 文件
 *   - git_diff：看具体改动（unified diff）
 *
 * 只读工具，没有 git_commit / git_push（commit/push 是 risky action，应该走 approval hook
 * 或者干脆让用户自己 git commit；agent 不主动 push）。
 *
 * 安全：
 *   - 只调 git 子命令；不接受任意 shell
 *   - cwd 固定到项目 root（process.cwd()）—— LLM 不能跨项目搞事
 *   - safety hook 仍生效（rm -rf / DROP TABLE 等通用规则会扫 input）
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolSpec } from '../types.js';

function runGit(args: string[], maxBytes = 50_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    let total = 0;
    child.stdout.on('data', (d: Buffer) => {
      total += d.length;
      if (total <= maxBytes) stdout += d.toString();
      else if (total - d.length < maxBytes) stdout += d.toString().slice(0, maxBytes - (total - d.length)) + '\n...[output truncated]';
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    child.on('error', (err) => resolve({ stdout, stderr: stderr + err.message, code: -1 }));
  });
}

// ───── git_status ─────
const StatusInput = z.object({
  /** 限定单个路径前缀，未传则全仓 */
  pathFilter: z.string().optional(),
});

export const gitStatusTool: ToolSpec<z.infer<typeof StatusInput>, { status: string; clean: boolean }> = {
  name: 'git_status',
  description: '看当前 working tree 的 git status（哪些文件被改 / 新加 / 未 staged）。返回 git status -sb 的纯文本输出。',
  parameters: {
    type: 'object',
    properties: {
      pathFilter: { type: 'string', description: '可选：限定路径前缀' },
    },
  },
  inputSchema: StatusInput,
  allowedAgents: ['conductor', 'coder', 'reviewer'],
  async handler({ pathFilter }) {
    const args = ['status', '-sb'];
    if (pathFilter) args.push('--', pathFilter);
    const r = await runGit(args);
    return {
      status: r.stdout.trim() || '(working tree clean)',
      clean: r.stdout.trim().split('\n').length <= 1,    // -sb 第一行总是 ## branch
    };
  },
};

// ───── git_diff ─────
const DiffInput = z.object({
  /** 限定单个文件 / 目录 */
  path: z.string().optional(),
  /** 看 staged vs HEAD 还是 working vs HEAD */
  staged: z.boolean().optional(),
  /** unified context 行数，默认 3 */
  context: z.number().int().min(0).max(20).optional(),
});

export const gitDiffTool: ToolSpec<
  z.infer<typeof DiffInput>,
  { diff: string; truncated: boolean }
> = {
  name: 'git_diff',
  description:
    '看 git diff（unified format）。默认看 working tree vs HEAD；staged=true 看 已 git add 的 vs HEAD。\n' +
    '输出最多 50KB，超出截断（避免 LLM 一次拿 100MB diff）。',
  parameters: {
    type: 'object',
    properties: {
      path:    { type: 'string',  description: '可选：限定文件或目录' },
      staged:  { type: 'boolean', description: '看已 staged 改动（默认 false 即 working vs HEAD）' },
      context: { type: 'integer', description: 'unified context 行数（默认 3）' },
    },
  },
  inputSchema: DiffInput,
  allowedAgents: ['conductor', 'coder', 'reviewer'],
  async handler({ path: filter, staged, context }) {
    const args = ['diff'];
    if (staged) args.push('--cached');
    if (typeof context === 'number') args.push(`-U${context}`);
    if (filter) args.push('--', filter);
    const r = await runGit(args);
    return {
      diff: r.stdout || '(no changes)',
      truncated: r.stdout.endsWith('...[output truncated]'),
    };
  },
};
