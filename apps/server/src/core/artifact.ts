/**
 * Artifact 持久化（Claude Artifacts / v0 风格）。
 *
 * LLM 调 `render_artifact` tool 生成 HTML/SVG/React 片段 → 落 sqlite + emit SSE → 前端 iframe 渲染。
 *
 * 同 (sessionId, artifactId) 重复 save 是更新（让 LLM 多轮"把按钮改红"能更新同一个 iframe）。
 */
import { nanoid } from 'nanoid';
import { prepare } from './db.js';
import { logger } from '../observability/logger.js';

export type ArtifactKind = 'html' | 'svg' | 'react';

export interface Artifact {
  id: string;
  sessionId: string;
  kind: ArtifactKind;
  title?: string;
  html: string;
  createdAt: number;
  updatedAt: number;
}

/** 单 artifact HTML 体最大 200KB（防 LLM 生成超大 payload 把 SSE / sqlite 撑爆） */
export const MAX_HTML_BYTES = 200_000;

export function saveArtifact(args: {
  /** 不传则新建；传了则覆盖已有同 id 的 artifact */
  id?: string;
  sessionId: string;
  kind: ArtifactKind;
  title?: string;
  html: string;
}): Artifact {
  if (Buffer.byteLength(args.html, 'utf8') > MAX_HTML_BYTES) {
    throw new Error(`artifact HTML 超过 ${MAX_HTML_BYTES} 字节上限`);
  }
  const now = Date.now();
  if (args.id) {
    const existing = prepare('SELECT created_at FROM artifacts WHERE id = ? AND session_id = ?')
      .get(args.id, args.sessionId) as { created_at: number } | undefined;
    if (existing) {
      prepare(`
        UPDATE artifacts SET kind = ?, title = ?, html = ?, updated_at = ?
        WHERE id = ? AND session_id = ?
      `).run(args.kind, args.title ?? null, args.html, now, args.id, args.sessionId);
      logger.info({ id: args.id, sessionId: args.sessionId, bytes: args.html.length }, '[artifact] 更新');
      return { id: args.id, sessionId: args.sessionId, kind: args.kind, title: args.title, html: args.html, createdAt: existing.created_at, updatedAt: now };
    }
  }
  const id = args.id ?? nanoid(10);
  prepare(`
    INSERT INTO artifacts (id, session_id, kind, title, html, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, args.sessionId, args.kind, args.title ?? null, args.html, now, now);
  logger.info({ id, sessionId: args.sessionId, bytes: args.html.length }, '[artifact] 新建');
  return { id, sessionId: args.sessionId, kind: args.kind, title: args.title, html: args.html, createdAt: now, updatedAt: now };
}

export function getArtifact(id: string): Artifact | null {
  const row = prepare(`
    SELECT id, session_id, kind, title, html, created_at, updated_at
    FROM artifacts WHERE id = ?
  `).get(id) as
    | { id: string; session_id: string; kind: string; title: string | null; html: string; created_at: number; updated_at: number }
    | undefined;
  if (!row) return null;
  return {
    id: row.id, sessionId: row.session_id,
    kind: row.kind as ArtifactKind,
    title: row.title ?? undefined,
    html: row.html, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function listArtifactsForSession(sessionId: string): Artifact[] {
  const rows = prepare(`
    SELECT id, session_id, kind, title, html, created_at, updated_at
    FROM artifacts WHERE session_id = ? ORDER BY updated_at DESC
  `).all(sessionId) as Array<{
    id: string; session_id: string; kind: string; title: string | null; html: string; created_at: number; updated_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id, sessionId: r.session_id,
    kind: r.kind as ArtifactKind,
    title: r.title ?? undefined,
    html: r.html, createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

export function deleteArtifact(id: string): boolean {
  const res = prepare('DELETE FROM artifacts WHERE id = ?').run(id);
  return res.changes > 0;
}
