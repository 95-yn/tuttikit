'use client';
import { useState } from 'react';
import type { TodoItem } from '@/lib/api';

interface Props {
  todos: TodoItem[];
}

/** 状态 → 文本图标（无依赖、跨平台稳定） */
function statusIcon(status: TodoItem['status']): string {
  switch (status) {
    case 'pending':     return '[ ]';
    case 'in_progress': return '[/]';
    case 'done':        return '[x]';
    case 'failed':      return '[!]';
    default:            return '[ ]';
  }
}

function itemClass(status: TodoItem['status']): string {
  switch (status) {
    case 'pending':     return 'todo-item todo-item-pending';
    case 'in_progress': return 'todo-item todo-item-running';
    case 'done':        return 'todo-item todo-item-done';
    case 'failed':      return 'todo-item todo-item-failed';
    default:            return 'todo-item';
  }
}

/**
 * 浮在右下角的 Agent Todo 面板
 * - todos 为空时整面板不渲染
 * - 折叠/展开状态用本地 state（不持久化）
 */
export function TodoPanel({ todos }: Props) {
  const [collapsed, setCollapsed] = useState(false);

  if (todos.length === 0) return null;

  const runningCount = todos.filter((t) => t.status === 'in_progress').length;
  const doneCount    = todos.filter((t) => t.status === 'done').length;

  if (collapsed) {
    return (
      <button
        type="button"
        className="todo-panel-collapsed"
        onClick={() => setCollapsed(false)}
        title="展开 Agent Todo"
        aria-label="展开 Agent Todo"
      >
        <span>🗒</span>
        <span>todos ({doneCount}/{todos.length})</span>
        {runningCount > 0 && <span className="todo-spinner-mini">◌</span>}
      </button>
    );
  }

  return (
    <div className="todo-panel" role="status" aria-live="polite">
      <div className="todo-panel-header">
        <span className="todo-panel-title">🗒 Agent Todo</span>
        <button
          type="button"
          className="todo-panel-collapse-btn"
          onClick={() => setCollapsed(true)}
          title="收起"
          aria-label="收起 Agent Todo"
        >
          –
        </button>
      </div>
      <ul className="todo-list">
        {todos.map((t) => (
          <li key={t.id} className={itemClass(t.status)}>
            <span className={`todo-icon${t.status === 'in_progress' ? ' todo-spinner' : ''}`}>
              {statusIcon(t.status)}
            </span>
            <span className="todo-text-wrap">
              <span className="todo-text">{t.text}</span>
              {t.note && <span className="todo-note">{t.note}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
