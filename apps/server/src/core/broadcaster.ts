import { EventEmitter } from 'node:events';

/**
 * 全局事件广播：CRUD/turn 完成 → 推到所有 /events 长连接。
 *   sessions:changed  { reason, sessionId? }
 *   session:updated   { sessionId }
 */
export type BroadcastReason = 'created' | 'renamed' | 'deleted' | 'turn-done';

export interface SessionsChangedPayload {
  type: 'sessions:changed';
  reason: BroadcastReason;
  sessionId?: string;
}

export interface SessionUpdatedPayload {
  type: 'session:updated';
  sessionId: string;
}

export type BroadcastEvent = SessionsChangedPayload | SessionUpdatedPayload;

class Broadcaster extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  sessionsChanged(reason: BroadcastReason, sessionId?: string): void {
    this.emit('event', { type: 'sessions:changed', reason, sessionId } satisfies BroadcastEvent);
  }
  sessionUpdated(sessionId: string): void {
    this.emit('event', { type: 'session:updated', sessionId } satisfies BroadcastEvent);
  }
}

export const broadcaster = new Broadcaster();
