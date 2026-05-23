'use client';
import { useMemo, useRef, useState } from 'react';
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
  onShare?: (s: SessionSummary) => void;
}

function bucketOf(updatedAt: string | undefined): string {
  if (!updatedAt) return '更早';
  const now = new Date();
  const t = new Date(updatedAt);
  if (Number.isNaN(t.getTime())) return '更早';
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const today = new Date(now);
  if (sameDay(t, today)) return '今天';
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (sameDay(t, yest)) return '昨天';
  // 本周（过去 7 天）
  const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
  if (t > weekAgo) return '本周';
  // 本月
  const monthAgo = new Date(now); monthAgo.setMonth(now.getMonth() - 1);
  if (t > monthAgo) return '本月';
  return '更早';
}
const BUCKET_ORDER = ['今天', '昨天', '本周', '本月', '更早'];

export function Sidebar({
  sessions, currentId, open, onClose, onSelect, onNew, onRename, onDelete, onShare,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');

  const startEdit = (s: SessionSummary) => {
    setEditingId(s.id);
    setDraft(s.title);
  };
  const commitEdit = (s: SessionSummary) => {
    const t = draft.trim();
    setEditingId(null);
    if (t && t !== s.title) onRename(s.id, t);
  };

  // 触屏左滑关闭抽屉
  const swipeStartX = useRef<number | null>(null);
  const onSwipeStart = (e: React.TouchEvent) => {
    if (!open) return;
    swipeStartX.current = e.touches[0].clientX;
  };
  const onSwipeEnd = (e: React.TouchEvent) => {
    if (swipeStartX.current == null) return;
    const dx = e.changedTouches[0].clientX - swipeStartX.current;
    if (dx < -60) onClose();
    swipeStartX.current = null;
  };

  // 长按 session item 直接进入重命名 —— 移动端单手操作友好
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const startLongPress = (s: SessionSummary) => {
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      try { navigator.vibrate?.(15); } catch {/* ignore */}
      startEdit(s);
    }, 500);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  // 搜索 + 按时间分组
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, query]);

  const groups = useMemo(() => {
    const map: Record<string, SessionSummary[]> = {};
    for (const s of filtered) {
      const b = bucketOf(s.updatedAt);
      (map[b] ||= []).push(s);
    }
    return BUCKET_ORDER.filter((b) => map[b]?.length).map((b) => ({ bucket: b, items: map[b] }));
  }, [filtered]);

  return (
    <aside
      id="sidebar"
      className={open ? 'open' : ''}
      onTouchStart={onSwipeStart}
      onTouchEnd={onSwipeEnd}
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
        <input
          className="sidebar-search"
          type="search"
          placeholder="搜索对话..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索会话"
        />
      </div>
      <div id="sessionList" className="session-list">
        {sessions.length === 0 ? (
          <div className="session-section-label">还没有对话</div>
        ) : filtered.length === 0 ? (
          <div className="session-section-label">「{query}」无匹配</div>
        ) : (
          groups.map(({ bucket, items }) => (
            <div key={bucket}>
              <div className="session-section-label">{bucket}</div>
              {items.map((s) => (
                <div
                  key={s.id}
                  className={'session-item' + (s.id === currentId ? ' active' : '')}
                  onClick={() => {
                    if (longPressFired.current) { longPressFired.current = false; return; }
                    if (editingId !== s.id) onSelect(s.id);
                  }}
                  onTouchStart={() => startLongPress(s)}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                  onContextMenu={(e) => { e.preventDefault(); startEdit(s); }}
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
                    {onShare && (
                      <button
                        type="button"
                        className="session-action-btn"
                        title="创建分享链接"
                        onClick={(e) => { e.stopPropagation(); onShare(s); }}
                      >
                        <Icon name="i-share" size="sm" />
                      </button>
                    )}
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
            </div>
          ))
        )}
      </div>
      <div className="sidebar-foot">
        <a className="link" href="/traces">traces</a>
        <a className="link" href="/api/memory" target="_blank">memory</a>
      </div>
    </aside>
  );
}
