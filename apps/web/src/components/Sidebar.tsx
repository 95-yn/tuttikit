'use client';
import { useState } from 'react';
import { Icon } from './IconSprite';
import type { SessionSummary } from '@/lib/types';

interface Props {
  sessions: SessionSummary[];
  currentId: string | null;
  open: boolean;                     // 移动端抽屉状态
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (s: SessionSummary) => void;
}

export function Sidebar({
  sessions, currentId, open, onClose, onSelect, onNew, onRename, onDelete,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const startEdit = (s: SessionSummary) => {
    setEditingId(s.id);
    setDraft(s.title);
  };
  const commitEdit = (s: SessionSummary) => {
    const t = draft.trim();
    setEditingId(null);
    if (t && t !== s.title) onRename(s.id, t);
  };

  // 触屏左滑关闭
  let touchStartX: number | null = null;
  const onTouchStart = (e: React.TouchEvent) => {
    if (!open) return;
    touchStartX = e.touches[0].clientX;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (dx < -60) onClose();
    touchStartX = null;
  };

  return (
    <aside
      id="sidebar"
      className={open ? 'open' : ''}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="sidebar-head">
        <div className="brand">
          <span className="logo"><Icon name="i-spark" size="sm" /></span>
          <span>TuttiKit</span>
        </div>
        <button className="btn-new" onClick={onNew} title="新建对话 (Cmd/Ctrl+N)" type="button">
          <Icon name="i-plus" size="sm" />
          <span>新建对话</span>
        </button>
      </div>
      <div id="sessionList" className="session-list">
        {sessions.length === 0 ? (
          <div className="session-section-label">还没有对话</div>
        ) : (
          <>
            <div className="session-section-label">历史对话</div>
            {sessions.map((s) => (
              <div
                key={s.id}
                className={'session-item' + (s.id === currentId ? ' active' : '')}
                onClick={() => editingId !== s.id && onSelect(s.id)}
              >
                {editingId === s.id ? (
                  <input
                    autoFocus
                    className="session-title-text editing"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitEdit(s)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') {
                        setEditingId(null);
                        setDraft(s.title);
                      }
                    }}
                  />
                ) : (
                  <span className="session-title-text" title={s.title}>{s.title}</span>
                )}
                <span className="session-actions">
                  <button
                    type="button"
                    className="session-action-btn"
                    title="重命名"
                    onClick={(e) => { e.stopPropagation(); startEdit(s); }}
                  >
                    <Icon name="i-edit" size="sm" />
                  </button>
                  <button
                    type="button"
                    className="session-action-btn danger"
                    title="删除"
                    onClick={(e) => { e.stopPropagation(); onDelete(s); }}
                  >
                    <Icon name="i-trash" size="sm" />
                  </button>
                </span>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="sidebar-foot">
        <a className="link" href="/api/traces" target="_blank">traces</a>
        <a className="link" href="/api/memory" target="_blank">memory</a>
      </div>
    </aside>
  );
}
