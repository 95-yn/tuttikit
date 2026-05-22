'use client';
import { useEffect } from 'react';
import type { ChatNotice } from '@/hooks/useChat';

interface Props {
  notices: ChatNotice[];
  onDismiss: (id: string) => void;
  /** 自动消失毫秒数；0 = 不自动 */
  autoDismissMs?: number;
}

const ICON: Record<ChatNotice['kind'], string> = {
  budget: '💸',
  review: '🔍',
  critique: '🪞',
  plan: '🗂',
  compact: '🗜',
  recall: '🔎',
  safety: '🛑',
};

/** 顶部浮层通知条：budget / review / critique / plan */
export function ChatNotices({ notices, onDismiss, autoDismissMs = 8000 }: Props) {
  // 每条 notice 自动 8s 淡出；sticky=true 的（plan 执行中）不淡出
  useEffect(() => {
    if (!autoDismissMs) return;
    const timers = notices
      .filter((n) => !n.sticky)
      .map((n) => window.setTimeout(() => onDismiss(n.id), autoDismissMs));
    return () => { for (const t of timers) clearTimeout(t); };
  }, [notices, onDismiss, autoDismissMs]);

  if (notices.length === 0) return null;
  return (
    <div className="chat-notices" role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`chat-notice chat-notice-${n.kind}`}>
          <span>{ICON[n.kind]}</span>
          {n.revisedFrom && (
            <span
              title={`Plan 修订于 ${n.revisedFrom} 失败：${n.revisedReason ?? ''}`}
              style={{
                fontSize: '11px', padding: '1px 5px',
                background: 'color-mix(in srgb, var(--warn) 25%, transparent)',
                color: 'var(--warn)', borderRadius: 4,
              }}
            >
              ↻ revised
            </span>
          )}
          <span>{n.text}</span>
          {n.files && n.files.length > 0 && (
            <span style={{ color: 'var(--muted-2)', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '12px' }}>
              ({n.files.slice(0, 2).join(', ')}{n.files.length > 2 ? ` +${n.files.length - 2}` : ''})
            </span>
          )}
          {n.kind === 'plan' && n.steps && n.steps.length > 0 && (
            <details style={{ marginLeft: 8 }} open={n.sticky}>
              <summary style={{ cursor: 'pointer', color: 'var(--muted-2)', fontSize: '12px' }}>
                {n.steps.filter((s) => s.status === 'ok').length}/{n.steps.length} 完成
              </summary>
              <ol style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: '12px', color: 'var(--text-dim)' }}>
                {n.steps.map((s) => (
                  <li key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 14, display: 'inline-block', textAlign: 'center' }}>
                      {s.status === 'ok' ? '✓'
                        : s.status === 'error' ? '✗'
                        : s.status === 'running' ? '⋯'
                        : '◌'}
                    </span>
                    <span style={{
                      flex: 1,
                      color: s.status === 'ok' ? 'var(--ok, #4ade80)'
                        : s.status === 'error' ? 'var(--error)'
                        : s.status === 'running' ? 'var(--accent)'
                        : 'var(--muted-2)',
                    }}>
                      {s.description}
                    </span>
                    {s.durationMs !== undefined && (
                      <span style={{ color: 'var(--muted-2)', fontFamily: 'ui-monospace, Menlo, monospace' }}>
                        {s.durationMs}ms
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </details>
          )}
          <button type="button" className="x" aria-label="关闭" onClick={() => onDismiss(n.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
