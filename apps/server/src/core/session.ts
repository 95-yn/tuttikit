import { nanoid } from 'nanoid';
import { logger } from '../observability/logger.js';
import type { Message, Session, SessionSummary } from '../types.js';
import { prepare, transaction } from './db.js';

/**
 * 一个 session = 一段持续对话，存 sqlite `sessions` 表。
 *
 * 迁移自 JSON 写盘版（详见 `migrateJSONToSQLite()` in core/migration.ts）：
 *   - 老的 `data/sessions/<id>.json` 一次性导入；导入后改名 .json.migrated 保留回滚
 *   - API 完全兼容老调用方
 *
 * 并发安全：
 *   - sqlite 用 BEGIN/COMMIT 包 R-M-W 序列，单连接 + WAL 模式下天然串行化
 *   - 仍保留 promise mutex —— 因为 R-M-W 跨多个 statement（read messages → push → write back），
 *     即使有 transaction，并发请求间也要按 session id 排队避免 deadlock 风险
 */
export class SessionManager {
  /** key = sessionId；value = 当前活跃 promise chain 的 tail */
  private _locks: Map<string, Promise<unknown>> = new Map();

  constructor(_opts: { dir?: string } = {}) {
    // dir 参数保留作向后兼容；实际数据现在在 sqlite 里
    // 注意：测试要换 db path 用 setDBPath() in core/db.ts
  }

  private async _withLock<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this._locks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this._locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this._locks.get(id) === next) this._locks.delete(id);
    }
  }

  async create({ title = '新对话' }: { title?: string } = {}): Promise<Session> {
    const session: Session = {
      id: nanoid(10),
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    return this._withLock(session.id, () => {
      prepare(`
        INSERT INTO sessions (id, title, created_at, updated_at, messages, archive)
        VALUES (?, ?, ?, ?, ?, NULL)
      `).run(session.id, session.title, session.createdAt, session.updatedAt ?? session.createdAt, '[]');
      return session;
    });
  }

  async get(id: string): Promise<Session | null> {
    const row = prepare('SELECT id, title, created_at, updated_at, messages, archive FROM sessions WHERE id = ?').get(id) as
      | { id: string; title: string; created_at: string; updated_at: string; messages: string; archive: string | null }
      | undefined;
    if (!row) return null;
    let messages: Message[];
    try { messages = JSON.parse(row.messages) as Message[]; }
    catch (err) {
      logger.warn({ err, id }, 'session.messages JSON 解析失败，用空数组');
      messages = [];
    }
    const session: Session & { archive?: unknown } = {
      id: row.id, title: row.title,
      createdAt: row.created_at, updatedAt: row.updated_at,
      messages,
    };
    if (row.archive) {
      try { session.archive = JSON.parse(row.archive); }
      catch (err) { logger.warn({ err, id }, 'session.archive JSON 解析失败，丢弃'); }
    }
    return session;
  }

  async list(): Promise<SessionSummary[]> {
    // sqlite 一条 query 拿全部 summary；不用读 messages 列（开销大）
    const rows = prepare(`
      SELECT id, title, created_at, updated_at,
             COALESCE(json_array_length(messages), 0) AS message_count
      FROM sessions
      ORDER BY updated_at DESC
    `).all() as Array<{ id: string; title: string; created_at: string; updated_at: string; message_count: number }>;
    return rows.map((r) => ({
      id: r.id, title: r.title,
      createdAt: r.created_at, updatedAt: r.updated_at,
      messageCount: r.message_count,
    }));
  }

  async appendMessage(id: string, message: Message): Promise<Session> {
    return this._withLock(id, async () => {
      return transaction(() => {
        const row = prepare('SELECT title, created_at, messages FROM sessions WHERE id = ?').get(id) as
          | { title: string; created_at: string; messages: string } | undefined;
        if (!row) throw new Error(`session ${id} 不存在`);
        const messages: Message[] = JSON.parse(row.messages);
        messages.push(message);
        let title = row.title;
        if (title === '新对话' && message.role === 'user' && typeof message.content === 'string') {
          title = message.content.slice(0, 30) + (message.content.length > 30 ? '…' : '');
        }
        const updatedAt = new Date().toISOString();
        prepare('UPDATE sessions SET title = ?, messages = ?, updated_at = ? WHERE id = ?')
          .run(title, JSON.stringify(messages), updatedAt, id);
        return { id, title, createdAt: row.created_at, updatedAt, messages };
      });
    });
  }

  async rename(id: string, title: string): Promise<Session> {
    return this._withLock(id, async () => {
      const updatedAt = new Date().toISOString();
      const res = prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, updatedAt, id);
      if (res.changes === 0) throw new Error(`session ${id} 不存在`);
      const full = await this.get(id);
      return full!;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this._withLock(id, () => {
      const res = prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return res.changes > 0;
    });
  }

  async replace(session: Session): Promise<Session> {
    return this._withLock(session.id, () => {
      session.updatedAt = new Date().toISOString();
      const archive = (session as Session & { archive?: unknown }).archive;
      const updatedAt = session.updatedAt ?? session.createdAt;
      const res = prepare(`
        UPDATE sessions
        SET title = ?, updated_at = ?, messages = ?, archive = ?
        WHERE id = ?
      `).run(
        session.title, updatedAt,
        JSON.stringify(session.messages),
        archive ? JSON.stringify(archive) : null,
        session.id,
      );
      if (res.changes === 0) {
        // 没记录则 insert（compactor 第一次写 archive 也走这里）
        prepare(`
          INSERT INTO sessions (id, title, created_at, updated_at, messages, archive)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          session.id, session.title, session.createdAt, updatedAt,
          JSON.stringify(session.messages),
          archive ? JSON.stringify(archive) : null,
        );
      }
      return session;
    });
  }

  async truncateMessages(id: string, fromIndex: number): Promise<Session | null> {
    return this._withLock(id, async () => {
      return transaction(() => {
        const row = prepare('SELECT messages FROM sessions WHERE id = ?').get(id) as { messages: string } | undefined;
        if (!row) return null;
        const messages: Message[] = JSON.parse(row.messages);
        if (fromIndex < 0 || fromIndex > messages.length) {
          throw new Error(`fromIndex 越界: ${fromIndex} / 共 ${messages.length} 条`);
        }
        const truncated = messages.slice(0, fromIndex);
        const updatedAt = new Date().toISOString();
        prepare('UPDATE sessions SET messages = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(truncated), updatedAt, id);
        // 重读完整 session 返回（保持原 API）
        const full = prepare('SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?').get(id) as
          { id: string; title: string; created_at: string; updated_at: string };
        return {
          id: full.id, title: full.title,
          createdAt: full.created_at, updatedAt: full.updated_at,
          messages: truncated,
        };
      });
    });
  }
}

export const sessionManager = new SessionManager();
