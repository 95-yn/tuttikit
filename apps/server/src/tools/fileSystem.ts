import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolSpec } from '../types.js';

const ReadInput = z.object({
  path: z.string().min(1, 'path 不能为空'),
});
const WriteInput = z.object({
  path: z.string().min(1, 'path 不能为空'),
  content: z.string(),
});

const ROOT = path.resolve('.');

/**
 * 写入允许列表：只允许 Agent 写到这几个目录下。读不限制（让 Agent 能读源码 debug）。
 * 配置 `FS_WRITE_ALLOWLIST=data,tmp,output,custom-dir` 覆盖。
 */
const WRITE_ALLOWLIST: string[] = (process.env.FS_WRITE_ALLOWLIST || 'data,tmp,output')
  .split(',').map((s) => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);

/**
 * 写入拒绝列表：即便它落在 allowlist 里也禁止（safety net）。
 * 路径以 POSIX 风格匹配，相对 ROOT。
 *
 * 默认列表覆盖最常见的"千万别写"路径；用户可通过 env 追加（不覆盖默认，仅 append）：
 *   FS_WRITE_DENYLIST_EXTRA=secrets/,credentials.json
 */
const WRITE_DENYLIST_DEFAULT: string[] = [
  '.env', '.env.local', '.env.production',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  '.git', '.github', 'node_modules', '.mcp.json',
];
const WRITE_DENYLIST: string[] = [
  ...WRITE_DENYLIST_DEFAULT,
  ...(process.env.FS_WRITE_DENYLIST_EXTRA || '')
    .split(',').map((s) => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean),
];

// 用 path.relative 做越界检查：在大小写不敏感的文件系统上（macOS HFS+/APFS、Windows NTFS），
// 简单的 startsWith(ROOT) 可能被 /Root/../Other 这类绕过；path.relative 算的是规范化后的相对路径，
// 起始为 ".." 或绝对路径才算越界。
function safePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('路径不能为空');
  }
  if (input.includes('\0')) {
    throw new Error('路径包含非法字符');
  }
  const abs = path.resolve(ROOT, input);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径越界：${input}`);
  }
  return abs;
}

/** 写入额外校验：必须落在 allowlist 内、且不在 denylist 内 */
function assertWriteAllowed(input: string): void {
  const abs = safePath(input);
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  for (const deny of WRITE_DENYLIST) {
    if (rel === deny || rel.startsWith(deny + '/')) {
      throw new Error(`禁止写入受保护路径 "${rel}"（denylist）`);
    }
  }
  const ok = WRITE_ALLOWLIST.some((a) => rel === a || rel.startsWith(a + '/'));
  if (!ok) {
    throw new Error(
      `只允许写入 ${WRITE_ALLOWLIST.map((a) => `"${a}/"`).join(' / ')} 目录，收到 "${rel}"`,
    );
  }
}

export const fileReadTool: ToolSpec<z.infer<typeof ReadInput>, { path: string; size: number; content: string }> = {
  name: 'file_system_read',
  description: '读取项目目录下的文本文件内容。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '相对路径，例如 data/foo.txt' } },
    required: ['path'],
  },
  inputSchema: ReadInput,
  allowedAgents: [],
  async handler({ path: p }) {
    const abs = safePath(p);
    const content = await fs.readFile(abs, 'utf-8');
    return { path: p, size: content.length, content };
  },
};

export const fileWriteTool: ToolSpec<
  z.infer<typeof WriteInput>,
  { path: string; bytes: number; ok: true }
> = {
  name: 'file_system_write',
  description: '在项目目录下写入文本文件（不存在则创建，存在则覆盖）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对路径，例如 data/report.md' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
  inputSchema: WriteInput,
  allowedAgents: [],
  async handler({ path: p, content }) {
    assertWriteAllowed(p);            // 越界 / denylist / 非 allowlist 都在这里抛
    const abs = safePath(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
    return { path: p, bytes: Buffer.byteLength(content, 'utf-8'), ok: true };
  },
};
