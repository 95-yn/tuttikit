import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolSpec } from '../types.js';

const ROOT = path.resolve('.');

function safePath(input: string): string {
  const abs = path.resolve(ROOT, input);
  if (!abs.startsWith(ROOT)) {
    throw new Error(`路径越界：${input}`);
  }
  return abs;
}

export const fileReadTool: ToolSpec<{ path: string }, { path: string; size: number; content: string }> = {
  name: 'file_system_read',
  description: '读取项目目录下的文本文件内容。',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: '相对路径，例如 data/foo.txt' } },
    required: ['path'],
  },
  allowedAgents: [],
  async handler({ path: p }) {
    const abs = safePath(p);
    const content = await fs.readFile(abs, 'utf-8');
    return { path: p, size: content.length, content };
  },
};

export const fileWriteTool: ToolSpec<
  { path: string; content: string },
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
  allowedAgents: [],
  async handler({ path: p, content }) {
    const abs = safePath(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
    return { path: p, bytes: Buffer.byteLength(content, 'utf-8'), ok: true };
  },
};
