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
export async function getHealth(): Promise<{ ok: boolean; provider: string }> {
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
