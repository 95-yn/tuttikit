/**
 * Conversation share（C）：给一个 session 生成只读分享 token。
 *
 * 设计：
 *   - token 是随机 32 字符（crypto.randomBytes(16).toString('hex')）
 *   - 同 session 多次 share 各自生成不同 token（让用户能 revoke 某个分享而不影响其他）
 *   - 默认永不过期；可传 ttlMs 设置过期
 *   - 只读：消费者拿 token 调 GET /share/:token 得到 session messages，不含敏感 meta
 */
import crypto from 'node:crypto';
import { prepare } from './db.js';
import { sessionManager } from './session.js';
import type { Session } from '../types.js';

export interface ShareRecord {
  token: string;
  sessionId: string;
  createdAt: number;
  expiresAt?: number;
}

export function createShare(sessionId: string, ttlMs?: number): ShareRecord {
  const token = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  const expiresAt = ttlMs ? now + ttlMs : null;
  prepare('INSERT INTO shares (token, session_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, sessionId, now, expiresAt);
  return { token, sessionId, createdAt: now, expiresAt: expiresAt ?? undefined };
}

/** async 版本（sessionManager.get 是 async） */
export async function getSharedSessionAsync(token: string): Promise<{ share: ShareRecord; session: Session } | null> {
  const row = prepare('SELECT token, session_id, created_at, expires_at FROM shares WHERE token = ?')
    .get(token) as { token: string; session_id: string; created_at: number; expires_at: number | null } | undefined;
  if (!row) return null;
  if (row.expires_at && Date.now() > row.expires_at) return null;
  const session = await sessionManager.get(row.session_id);
  if (!session) return null;
  return {
    share: {
      token: row.token, sessionId: row.session_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    },
    session,
  };
}

export function deleteShare(token: string): boolean {
  const res = prepare('DELETE FROM shares WHERE token = ?').run(token);
  return res.changes > 0;
}

export function listSharesForSession(sessionId: string): ShareRecord[] {
  const rows = prepare('SELECT token, session_id, created_at, expires_at FROM shares WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionId) as Array<{ token: string; session_id: string; created_at: number; expires_at: number | null }>;
  return rows.map((r) => ({
    token: r.token, sessionId: r.session_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at ?? undefined,
  }));
}
