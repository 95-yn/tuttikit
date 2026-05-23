import type { Session, SessionSummary, Attachment } from './types';

// 走 Next.js rewrites（/api/* → http://localhost:3001/*）
const API = '/api';

export async function listSessions(): Promise<SessionSummary[]> {
  const r = await fetch(`${API}/sessions`);
  return r.json();
}
export async function createSession(): Promise<Session> {
  const r = await fetch(`${API}/sessions`, { method: 'POST' });
  return r.json();
}
export async function getSession(id: string): Promise<Session> {
  const r = await fetch(`${API}/sessions/${id}`);
  return r.json();
}
export interface SessionBudgetStats {
  inputTokens: number;
  outputTokens: number;
  totalUSD: number;
  turns: number;
}
export async function getSessionBudget(id: string): Promise<SessionBudgetStats> {
  const r = await fetch(`${API}/sessions/${id}/budget`);
  if (!r.ok) return { inputTokens: 0, outputTokens: 0, totalUSD: 0, turns: 0 };
  return r.json();
}
export async function renameSession(id: string, title: string): Promise<Session> {
  const r = await fetch(`${API}/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return r.json();
}
export async function deleteSession(id: string): Promise<{ ok: boolean }> {
  const r = await fetch(`${API}/sessions/${id}`, { method: 'DELETE' });
  return r.json();
}

/** 截断会话消息：删除 index >= fromIndex 的所有消息，用于重生 / 编辑重发 */
export async function truncateMessages(id: string, fromIndex: number): Promise<Session> {
  const r = await fetch(`${API}/sessions/${id}/messages?fromIndex=${fromIndex}`, { method: 'DELETE' });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error || `truncate failed: ${r.status}`);
  }
  return r.json();
}
export async function getHealth(): Promise<{
  ok: boolean;
  provider: string;
  /** v0.2+：当前 provider 配置的 model */
  model?: string;
  /** v0.2+：服务端根据 provider × model 推出的上下文窗口（tokens） */
  contextWindow?: number;
}> {
  const r = await fetch(`${API}/health`);
  return r.json();
}

export function streamUrl(
  sessionId: string,
  message: string,
  provider?: string,
  attachmentIds?: string[],
): string {
  const p = new URLSearchParams({ message });
  if (provider) p.set('provider', provider);
  if (attachmentIds && attachmentIds.length) p.set('attachmentIds', attachmentIds.join(','));
  return `${API}/sessions/${sessionId}/stream?${p.toString()}`;
}

export async function uploadFile(file: File): Promise<Attachment> {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch(`${API}/uploads`, { method: 'POST', body: fd });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error || `upload failed: ${r.status}`);
  }
  return r.json();
}

export function uploadUrl(id: string): string {
  return `${API}/uploads/${id}`;
}

// ───── 动态审批 ─────
export async function listPendingPermissions(sessionId: string): Promise<{
  pending: Array<{
    id: string; sessionId: string; toolName: string; input: unknown;
    rule: string; reason: string; createdAt: number; timeoutMs: number;
  }>;
}> {
  const r = await fetch(`${API}/sessions/${sessionId}/permissions`);
  return r.json();
}

export async function answerPermission(
  sessionId: string, requestId: string, allow: boolean,
): Promise<{ ok: boolean; allow?: boolean; reason?: string }> {
  const r = await fetch(`${API}/sessions/${sessionId}/permissions/${requestId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allow }),
  });
  return r.json();
}

// ───── 用户反馈（👍/👎）─────
export interface FeedbackRecord {
  id: string;
  sessionId: string;
  messageId: string;
  rating: 1 | -1;
  comment?: string;
  createdAt: number;
}

export async function postMessageFeedback(
  sessionId: string,
  messageId: string,
  rating: 1 | -1,
  comment?: string,
): Promise<FeedbackRecord> {
  const r = await fetch(`${API}/sessions/${sessionId}/messages/${messageId}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rating, comment }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error || `feedback failed: ${r.status}`);
  }
  return r.json();
}

export async function listSessionFeedback(sessionId: string): Promise<{
  items: FeedbackRecord[];
  stats: { up: number; down: number; total: number };
}> {
  const r = await fetch(`${API}/sessions/${sessionId}/feedback`);
  if (!r.ok) return { items: [], stats: { up: 0, down: 0, total: 0 } };
  return r.json();
}

// ───── Artifacts（Claude Artifacts 风格的沙箱 HTML 渲染）─────
export interface Artifact {
  id: string;
  sessionId: string;
  kind: 'html' | 'svg' | 'react';
  title?: string;
  html: string;
  createdAt: number;
  updatedAt: number;
}

export async function listArtifacts(sessionId: string): Promise<{ items: Artifact[] }> {
  const r = await fetch(`${API}/sessions/${sessionId}/artifacts`);
  if (!r.ok) return { items: [] };
  return r.json();
}

export async function getArtifact(id: string): Promise<Artifact> {
  const r = await fetch(`${API}/artifacts/${id}`);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error || `getArtifact failed: ${r.status}`);
  }
  return r.json();
}
