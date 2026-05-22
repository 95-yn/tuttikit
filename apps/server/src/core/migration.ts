/**
 * JSON → SQLite 一次性数据迁移。
 *
 * 触发：server boot 时调一次 `migrateJSONToSQLite()`，幂等（已迁移过的 .migrated 文件不会重复处理）。
 *
 * 流程：
 *   1. 扫 `data/sessions/*.json` —— 没标 .migrated 的逐个 import 到 sessions 表，import 后改名 .migrated
 *   2. 扫 `data/long_term_memory.json` —— 同理 import 到 memory 表，改名 .migrated
 *   3. 保留 .migrated 后缀（不删）让用户能回滚检查
 *
 * 安全：
 *   - 单条文件失败只 log，不阻塞其他
 *   - 重复 boot 不会重导（看后缀）
 *   - 已存在的 db row 不覆盖（INSERT OR IGNORE）
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../observability/logger.js';
import { prepare, transaction } from './db.js';
import type { Message, Session, MemoryEntry } from '../types.js';

const SESSIONS_DIR = path.resolve('./data/sessions');
const LONGTERM_FILE = path.resolve('./data/long_term_memory.json');

export function migrateJSONToSQLite(): { sessionsImported: number; memoryImported: number } {
  let sessionsImported = 0;
  let memoryImported = 0;

  // ── 1. sessions ──
  if (fs.existsSync(SESSIONS_DIR)) {
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;     // 跳过 .migrated 和别的
      const full = path.join(SESSIONS_DIR, f);
      try {
        const raw = fs.readFileSync(full, 'utf-8');
        const s = JSON.parse(raw) as Session & { archive?: unknown };
        prepare(`
          INSERT OR IGNORE INTO sessions (id, title, created_at, updated_at, messages, archive)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          s.id, s.title ?? '新对话',
          s.createdAt ?? new Date().toISOString(),
          s.updatedAt ?? s.createdAt ?? new Date().toISOString(),
          JSON.stringify((s.messages as Message[]) ?? []),
          s.archive ? JSON.stringify(s.archive) : null,
        );
        // 改名 .migrated，不删——用户想 rollback 时还能找到
        fs.renameSync(full, full + '.migrated');
        sessionsImported++;
      } catch (err) {
        logger.warn({ err: (err as Error).message, file: f }, '[migration] session 文件导入失败，跳过');
      }
    }
  }

  // ── 2. long_term_memory ──
  if (fs.existsSync(LONGTERM_FILE)) {
    try {
      const raw = fs.readFileSync(LONGTERM_FILE, 'utf-8');
      const items = JSON.parse(raw) as MemoryEntry[];
      transaction(() => {
        const ins = prepare(`
          INSERT OR IGNORE INTO memory (id, text, source, tags, vec, vec_model, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const it of items) {
          if (!it.id || !it.text) continue;
          ins.run(
            it.id, it.text, it.source ?? 'unknown',
            JSON.stringify(it.tags ?? []),
            it.vec ? JSON.stringify(it.vec) : null,
            it.vecModel ?? null,
            it.createdAt ?? Date.now(),
          );
          memoryImported++;
        }
      });
      fs.renameSync(LONGTERM_FILE, LONGTERM_FILE + '.migrated');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[migration] long_term_memory 导入失败');
    }
  }

  if (sessionsImported > 0 || memoryImported > 0) {
    logger.info(
      { sessionsImported, memoryImported },
      '[migration] JSON → sqlite 迁移完成（旧文件已 rename 为 .migrated 后缀，可手动删除）',
    );
  }
  return { sessionsImported, memoryImported };
}
