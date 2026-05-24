/**
 * 全局失败档案（Manus 经验 + Reflexion 强化版）。
 *
 * 文件：`data/agents/global-failures.md`（**全局**，跨 session 累积）
 *
 * 为什么 global 不 per-session：
 *   - per-session 失败下次新 session 就忘了 —— 跟"没记忆"一样
 *   - global 累积让 LLM 看到"上次同类问题怎么栽的"
 *   - 用 cap + 相似度去重防膨胀（默认 200 条）
 *
 * 格式（markdown）：
 *   ```
 *   ## Failures (last 200)
 *
 *   ### 2026-05-24 14:32 · session=abc / task="改 useChat 超时"
 *   失败：tsc error TS2322
 *   修法：useState 用 number 而非 string；setTimeout 返回类型是 ReturnType<typeof setTimeout>
 *
 *   ### 2026-05-22 09:15 · session=xyz / task="跑 pnpm test"
 *   失败：test-rag.ts FileNotFoundError /tmp/rag-xxx
 *   修法：tmpDir 用 mkdtempSync 不是硬编码 /tmp/rag
 *   ```
 *
 * Conductor 每个 turn 开始：把最近 5 条注入 system prompt 让 LLM 自查。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../observability/logger.js';

export interface FailureEntry {
  /** ISO 时间戳 */
  at: string;
  sessionId: string;
  task: string;        // 失败的任务描述（短）
  reason: string;      // 失败原因（错误信息 / traceback）
  fix?: string;        // 怎么修的（如果有）
}

const FILE = path.resolve('./data/agents/global-failures.md');
const MAX_ENTRIES = Number(process.env.FAILURE_LOG_MAX || 200);

/** 串行锁防并发写 race */
let _lock: Promise<unknown> = Promise.resolve();
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _lock;
  const next = prev.catch(() => undefined).then(fn);
  _lock = next;
  return next as Promise<T>;
}

function entryToMd(e: FailureEntry): string {
  const lines = [
    `### ${e.at} · session=${e.sessionId} / task="${e.task.replace(/"/g, "'").slice(0, 100)}"`,
    `失败：${e.reason.slice(0, 500)}`,
  ];
  if (e.fix) lines.push(`修法：${e.fix.slice(0, 500)}`);
  return lines.join('\n');
}

function parseMd(text: string): FailureEntry[] {
  const sections = text.split(/\n### /).slice(1);    // 首段是 "## Failures..." header，跳过
  const entries: FailureEntry[] = [];
  for (const s of sections) {
    const headLine = '### ' + s.split('\n')[0];
    const m = /^### (\S+ \S+) · session=(\S+) \/ task="([^"]+)"/.exec(headLine);
    if (!m) continue;
    const body = s.split('\n').slice(1);
    const reasonLine = body.find((l) => l.startsWith('失败：'));
    const fixLine = body.find((l) => l.startsWith('修法：'));
    if (!reasonLine) continue;
    entries.push({
      at: m[1], sessionId: m[2], task: m[3],
      reason: reasonLine.replace(/^失败：/, ''),
      fix: fixLine?.replace(/^修法：/, ''),
    });
  }
  return entries;
}

async function readAll(): Promise<FailureEntry[]> {
  try {
    const text = await fs.readFile(FILE, 'utf-8');
    return parseMd(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    logger.warn({ err: (err as Error).message }, '[failureLog] 读取失败');
    return [];
  }
}

async function writeAll(entries: FailureEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const lines = [
    `## Failures (latest ${entries.length}, cap ${MAX_ENTRIES})`,
    '',
    ...entries.map(entryToMd),
  ];
  const text = lines.join('\n\n');
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, FILE);
}

/** 简单相似度 dedup：同 sessionId + task 前 50 字相同 → 视为同一条，只保留最新 */
function dedupKey(e: FailureEntry): string {
  return `${e.sessionId}::${e.task.slice(0, 50)}`;
}

export async function logFailure(args: {
  sessionId: string;
  task: string;
  reason: string;
  fix?: string;
}): Promise<FailureEntry> {
  return withLock(async () => {
    const all = await readAll();
    const entry: FailureEntry = {
      at: new Date().toISOString().slice(0, 16).replace('T', ' '),    // 'YYYY-MM-DD HH:MM'
      sessionId: args.sessionId,
      task: args.task,
      reason: args.reason,
      fix: args.fix,
    };
    const key = dedupKey(entry);
    const filtered = all.filter((e) => dedupKey(e) !== key);
    filtered.push(entry);
    // cap
    const trimmed = filtered.slice(-MAX_ENTRIES);
    await writeAll(trimmed);
    logger.info({ sessionId: entry.sessionId, task: entry.task.slice(0, 50) }, '[failureLog] 记录');
    return entry;
  });
}

/**
 * 给 conductor system inject：最近 5 条（或按 query 搜索过滤）。
 * 不超 1500 字符防灌爆 prompt。
 */
export async function recentFailuresForPrompt(query?: string, limit = 5): Promise<string> {
  const all = await readAll();
  if (all.length === 0) return '';
  let pick = all;
  if (query) {
    const q = query.toLowerCase();
    // 关键词命中 task / reason / fix 的优先
    pick = all.filter((e) => (e.task + e.reason + (e.fix ?? '')).toLowerCase().includes(q));
    if (pick.length === 0) pick = all;   // 没命中 fallback 最近
  }
  pick = pick.slice(-limit);
  if (pick.length === 0) return '';
  const lines = ['## 历史失败档案（global-failures.md，按时间排序，最新在后）'];
  for (const e of pick) lines.push('', entryToMd(e));
  const text = lines.join('\n');
  return text.slice(0, 1500);    // 上限 1500 字符
}

export async function searchFailures(query: string, limit = 10): Promise<FailureEntry[]> {
  const all = await readAll();
  const q = query.toLowerCase();
  return all
    .filter((e) => (e.task + e.reason + (e.fix ?? '')).toLowerCase().includes(q))
    .slice(-limit);
}
