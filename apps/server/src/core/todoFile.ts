/**
 * 持久化 todo.md（Manus 经验：file-system as external memory）。
 *
 * 文件路径：`data/agents/<sessionId>/todo.md`（per-session）
 *
 * 格式（markdown checkbox）：
 *   ```
 *   ## Todo
 *   - [ ] id1 改 useChat 超时
 *   - [/] id2 跑测试（in progress）
 *   - [x] id3 写测试（done）
 *   - [!] id4 跑 build（failed: tsc error TS2322）
 *   ```
 *
 * 设计：
 *   - id 是 nanoid(6)，append-only 历史可追溯
 *   - 文件作为唯一真源，加锁防并发 race
 *   - LLM 通过 todo_add / done / fail / list 4 个 tool 操作
 *   - 跨 turn 持久（重启 server 仍在）
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { logger } from '../observability/logger.js';

export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  note?: string;
}

const STATUS_MARK: Record<TodoStatus, string> = {
  pending:     ' ',
  in_progress: '/',
  done:        'x',
  failed:      '!',
};
const MARK_STATUS: Record<string, TodoStatus> = {
  ' ': 'pending',
  '/': 'in_progress',
  x:   'done',
  X:   'done',
  '!': 'failed',
};

function sessionFile(sessionId: string): string {
  return path.resolve(`./data/agents/${sessionId}/todo.md`);
}

/** per-sessionId 串行锁防并发 race */
const _locks = new Map<string, Promise<unknown>>();
async function withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _locks.get(sessionId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  _locks.set(sessionId, next);
  try { return await next; }
  finally { if (_locks.get(sessionId) === next) _locks.delete(sessionId); }
}

function parseMd(text: string): TodoItem[] {
  const items: TodoItem[] = [];
  const lines = text.split('\n');
  // 匹配 "- [x] id text  ← note"  /  "- [ ] id text"
  const re = /^- \[([x X /! ])\]\s+(\S+)\s+(.+?)(?:\s+←\s+(.+))?$/;
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    items.push({
      id: m[2],
      text: m[3].trim(),
      status: MARK_STATUS[m[1]] ?? 'pending',
      note: m[4]?.trim(),
    });
  }
  return items;
}

function renderMd(items: TodoItem[]): string {
  if (items.length === 0) return '## Todo\n\n(空)\n';
  const lines = ['## Todo', ''];
  for (const it of items) {
    const note = it.note ? `  ←  ${it.note}` : '';
    lines.push(`- [${STATUS_MARK[it.status]}] ${it.id} ${it.text}${note}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function readAll(sessionId: string): Promise<TodoItem[]> {
  const file = sessionFile(sessionId);
  try {
    const text = await fs.readFile(file, 'utf-8');
    return parseMd(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    logger.warn({ err: (err as Error).message, sessionId }, '[todo] 读取失败');
    return [];
  }
}

async function writeAll(sessionId: string, items: TodoItem[]): Promise<void> {
  const file = sessionFile(sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // 原子写：先写 .tmp 再 rename
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, renderMd(items));
  await fs.rename(tmp, file);
}

export async function addItems(sessionId: string, texts: string[]): Promise<TodoItem[]> {
  return withLock(sessionId, async () => {
    const items = await readAll(sessionId);
    const fresh: TodoItem[] = texts.map((t) => ({
      id: nanoid(6),
      text: t.trim().slice(0, 200),
      status: 'pending' as const,
    }));
    items.push(...fresh);
    await writeAll(sessionId, items);
    return fresh;
  });
}

export async function setStatus(
  sessionId: string, id: string, status: TodoStatus, note?: string,
): Promise<TodoItem | null> {
  return withLock(sessionId, async () => {
    const items = await readAll(sessionId);
    const found = items.find((it) => it.id === id);
    if (!found) return null;
    found.status = status;
    if (note !== undefined) found.note = note.slice(0, 300);
    await writeAll(sessionId, items);
    return found;
  });
}

export async function listAll(sessionId: string): Promise<TodoItem[]> {
  return readAll(sessionId);
}

/** 给 conductor system prompt 注入用：把活的 todo 拼成给 LLM 看的 markdown */
export async function formatForPrompt(sessionId: string): Promise<string> {
  const items = await readAll(sessionId);
  const open = items.filter((it) => it.status === 'pending' || it.status === 'in_progress');
  const recentDone = items.filter((it) => it.status === 'done' || it.status === 'failed').slice(-5);
  if (open.length === 0 && recentDone.length === 0) return '';
  const lines = ['## 你的 todo（持久化在 data/agents/<sessionId>/todo.md）'];
  if (open.length > 0) {
    lines.push('待办：');
    for (const it of open) lines.push(`  - [${STATUS_MARK[it.status]}] ${it.id} ${it.text}`);
  }
  if (recentDone.length > 0) {
    lines.push('最近完成 / 失败：');
    for (const it of recentDone) {
      const note = it.note ? `  ←  ${it.note}` : '';
      lines.push(`  - [${STATUS_MARK[it.status]}] ${it.id} ${it.text}${note}`);
    }
  }
  lines.push('用 todo_add / todo_done / todo_fail 维护这个列表。');
  return lines.join('\n');
}

/** 测试用：清掉某 session 的 todo 文件 */
export function _resetForTest(sessionId: string): void {
  const file = sessionFile(sessionId);
  try { fsSync.rmSync(file); } catch {/* ignore */}
}
