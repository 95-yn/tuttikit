/**
 * 用户对 assistant 消息的反馈（W1.1 Y7）：
 *   - 👍/👎 + 可选文本评论
 *   - 落 sqlite message_feedback 表，未来训练 / 调 prompt 时拿出来分析
 *   - upsert：同 (session_id, message_id) 重复打分覆盖（用户改主意）
 */
import { nanoid } from 'nanoid';
import { prepare } from './db.js';
import { logger } from '../observability/logger.js';

export type FeedbackRating = 1 | -1;

export interface FeedbackRecord {
  id: string;
  sessionId: string;
  messageId: string;
  rating: FeedbackRating;
  comment?: string;
  createdAt: number;
}

export function saveFeedback(args: {
  sessionId: string;
  messageId: string;
  rating: FeedbackRating;
  comment?: string;
}): FeedbackRecord {
  // upsert：同 session + message 已有反馈则覆盖
  const existing = prepare('SELECT id FROM message_feedback WHERE session_id = ? AND message_id = ?')
    .get(args.sessionId, args.messageId) as { id: string } | undefined;

  const record: FeedbackRecord = {
    id: existing?.id ?? nanoid(10),
    sessionId: args.sessionId,
    messageId: args.messageId,
    rating: args.rating,
    comment: args.comment,
    createdAt: Date.now(),
  };

  if (existing) {
    prepare(`
      UPDATE message_feedback SET rating = ?, comment = ?, created_at = ?
      WHERE id = ?
    `).run(record.rating, record.comment ?? null, record.createdAt, record.id);
  } else {
    prepare(`
      INSERT INTO message_feedback (id, session_id, message_id, rating, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.id, record.sessionId, record.messageId, record.rating, record.comment ?? null, record.createdAt);
  }
  logger.info({ sessionId: args.sessionId, messageId: args.messageId, rating: args.rating }, '[feedback] saved');
  return record;
}

export function getFeedbackForSession(sessionId: string): FeedbackRecord[] {
  const rows = prepare(`
    SELECT id, session_id, message_id, rating, comment, created_at
    FROM message_feedback WHERE session_id = ? ORDER BY created_at DESC
  `).all(sessionId) as Array<{
    id: string; session_id: string; message_id: string; rating: number;
    comment: string | null; created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id, sessionId: r.session_id, messageId: r.message_id,
    rating: r.rating as FeedbackRating,
    comment: r.comment ?? undefined,
    createdAt: r.created_at,
  }));
}

/** 给 dashboard / debug 用：统计某 session 的赞踩比 */
export function feedbackStats(sessionId?: string): { up: number; down: number; total: number } {
  const sql = sessionId
    ? 'SELECT rating, COUNT(*) AS n FROM message_feedback WHERE session_id = ? GROUP BY rating'
    : 'SELECT rating, COUNT(*) AS n FROM message_feedback GROUP BY rating';
  const rows = (sessionId ? prepare(sql).all(sessionId) : prepare(sql).all()) as Array<{ rating: number; n: number }>;
  let up = 0, down = 0;
  for (const r of rows) {
    if (r.rating === 1) up += r.n;
    else if (r.rating === -1) down += r.n;
  }
  return { up, down, total: up + down };
}
