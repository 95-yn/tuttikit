'use client';
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Icon } from './IconSprite';
import { CtxMeter } from './CtxMeter';
import { ThemeToggle } from './ThemeToggle';

// 每个 provider 的紧凑可视化：圆点 + 短名。
//   PC / 移动端都用同一个组件，颜色取自各家品牌色
const PROVIDER_META: Record<string, { color: string; label: string }> = {
  anthropic: { color: '#D97757', label: 'Claude' },
  openai:    { color: '#10A37F', label: 'GPT' },
  deepseek:  { color: '#4D6BFE', label: 'DeepSeek' },
  mock:      { color: '#8A8E99', label: 'Mock' },
};

interface Props {
  title: string;
  canRename: boolean;
  onRename: (title: string) => void;
  provider: string;                  // 选中的 provider（空 = 默认 .env）
  effectiveProvider: string;         // 实际生效的 provider（用于 ctx meter）
  defaultProvider: string;           // 从 /health 拿到的
  /** v0.2+：/health 返回的当前 model（仅在用默认 provider 时准；override 时未知 model） */
  defaultModel?: string;
  /** v0.2+：server 计算出的 contextWindow（tokens）；未 override provider 时直接用 */
  serverContextWindow?: number;
  onProviderChange: (p: string) => void;
  ctxUsage: {
    lastInputTokens: number;
    sessionTotalIn: number;
    sessionTotalOut: number;
    sessionUSD?: number;
    budgetWarn?: { scope: 'session' | 'day'; ratio: number } | null;
  };
  onMenu: () => void;
  onNew: () => void;                  // 移动端「+」新建会话
}

export function Topbar({
  title, canRename, onRename,
  provider, effectiveProvider, defaultProvider, defaultModel, serverContextWindow, onProviderChange,
  ctxUsage, onMenu, onNew,
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
      {/* 移动端「+ 新建对话」：CSS 控制只在 ≤720px 显示 */}
      <button className="btn-new-mobile" type="button" title="新建对话" onClick={onNew} aria-label="新建对话">
        <Icon name="i-plus" size="sm" />
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
        {/* 紧凑 provider 徽章：色点 + 短名。
            包了一个隐形 <select>，原生点击即弹下拉，PC/移动都好用 */}
        <ProviderBadge
          effectiveProvider={effectiveProvider}
          provider={provider}
          onChange={onProviderChange}
        />
        {/* 管理入口：Skills / MCP / Traces */}
        <nav className="topbar-nav" aria-label="管理页">
          <Link href="/skills" className="topbar-nav-link" title="Skills 管理">🧩</Link>
          <Link href="/mcp"    className="topbar-nav-link" title="MCP servers">🔌</Link>
          <Link href="/traces" className="topbar-nav-link" title="Traces">📊</Link>
        </nav>
        <ThemeToggle />
        <CtxMeter
          provider={effectiveProvider}
          /* 用户切到非默认 provider 时 model / contextWindow 未知，传 undefined 让 CtxMeter 走前端表前缀匹配 */
          model={effectiveProvider === defaultProvider ? defaultModel : undefined}
          contextWindow={effectiveProvider === defaultProvider ? serverContextWindow : undefined}
          lastInputTokens={ctxUsage.lastInputTokens}
          sessionTotalIn={ctxUsage.sessionTotalIn}
          sessionTotalOut={ctxUsage.sessionTotalOut}
          sessionUSD={ctxUsage.sessionUSD}
          budgetWarn={ctxUsage.budgetWarn}
        />
      </div>
    </header>
  );
}

function ProviderBadge({
  effectiveProvider, provider, onChange,
}: {
  effectiveProvider: string;
  provider: string;
  onChange: (p: string) => void;
}) {
  const meta = PROVIDER_META[effectiveProvider] ?? PROVIDER_META.mock;
  return (
    <label className="provider-badge" title={`当前 Provider: ${effectiveProvider}（点击切换）`}>
      <span className="provider-dot" style={{ background: meta.color }} />
      <span className="provider-label">{meta.label}</span>
      {/* 原生 select 透明覆盖，点击一下就弹下拉，桌面 + 移动通用 */}
      <select
        className="provider-select-overlay"
        value={provider}
        onChange={(e) => onChange(e.target.value)}
        aria-label="切换 Provider"
      >
        <option value="">默认 (.env)</option>
        <option value="mock">mock</option>
        <option value="anthropic">anthropic</option>
        <option value="openai">openai</option>
        <option value="deepseek">deepseek</option>
      </select>
    </label>
  );
}
