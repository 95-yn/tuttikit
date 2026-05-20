'use client';
import { useState, useEffect, useRef } from 'react';
import { Icon } from './IconSprite';
import { CtxMeter } from './CtxMeter';

interface Props {
  title: string;
  canRename: boolean;
  onRename: (title: string) => void;
  provider: string;                  // 选中的 provider（空 = 默认 .env）
  effectiveProvider: string;         // 实际生效的 provider（用于 ctx meter）
  defaultProvider: string;           // 从 /health 拿到的
  onProviderChange: (p: string) => void;
  ctxUsage: { lastInputTokens: number; sessionTotalIn: number; sessionTotalOut: number };
  onMenu: () => void;
}

export function Topbar({
  title, canRename, onRename,
  provider, effectiveProvider, defaultProvider, onProviderChange,
  ctxUsage, onMenu,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { setDraft(title); }, [title]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== title) onRename(t);
    else setDraft(title);
  };

  return (
    <header id="topbar">
      <button id="btnMenu" className="btn-menu" type="button" title="打开会话列表" onClick={onMenu}>
        <Icon name="i-menu" />
      </button>
      {editing ? (
        <input
          ref={inputRef}
          className="session-title"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') { setDraft(title); setEditing(false); }
          }}
        />
      ) : (
        <h1
          className="session-title"
          title="双击重命名"
          onDoubleClick={() => canRename && setEditing(true)}
        >
          {title}
        </h1>
      )}

      <div className="topbar-right">
        <label className="select-wrap">
          <span>Provider</span>
          <select value={provider} onChange={(e) => onProviderChange(e.target.value)}>
            <option value="">默认 (.env)</option>
            <option value="mock">mock</option>
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
            <option value="deepseek">deepseek</option>
          </select>
        </label>
        <span className="badge">provider · {defaultProvider}</span>
        <CtxMeter
          provider={effectiveProvider}
          lastInputTokens={ctxUsage.lastInputTokens}
          sessionTotalIn={ctxUsage.sessionTotalIn}
          sessionTotalOut={ctxUsage.sessionTotalOut}
        />
      </div>
    </header>
  );
}
