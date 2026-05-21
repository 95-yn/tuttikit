'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@/lib/types';

export interface Command {
  id: string;
  label: string;
  hint?: string;            // 右侧次要文字
  group?: string;           // 「会话」/「操作」/「Provider」等分组标签
  keywords?: string;         // 额外的搜索关键词
  action: () => void | Promise<void>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  sessions: SessionSummary[];
  currentId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (s: SessionSummary) => void;
  onSetProvider: (p: string) => void;
  effectiveProvider: string;
  onExportCurrent?: () => void;
  onCopyCurrent?: () => void;
}

const PROVIDERS = [
  { id: '', label: '默认 (.env)' },
  { id: 'mock', label: 'Mock（离线）' },
  { id: 'anthropic', label: 'Anthropic Claude' },
  { id: 'openai', label: 'OpenAI GPT' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'qwen', label: '阿里 通义 (qwen)' },
  { id: 'doubao', label: '字节 豆包 (doubao)' },
  { id: 'hunyuan', label: '腾讯 混元 (hunyuan)' },
  { id: 'glm', label: '智谱 GLM' },
  { id: 'kimi', label: 'Moonshot Kimi' },
];

export function CommandPalette({
  open, onClose, sessions, currentId, onSelectSession,
  onNewSession, onDeleteSession, onSetProvider, effectiveProvider,
  onExportCurrent, onCopyCurrent,
}: Props) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 构建可搜索命令集
  const commands = useMemo<Command[]>(() => {
    const ops: Command[] = [
      {
        id: 'new', label: '新建对话', group: '操作', hint: 'Cmd/Ctrl+N',
        keywords: 'new chat session',
        action: () => onNewSession(),
      },
    ];
    if (onExportCurrent) ops.push({
      id: 'export', label: '导出当前会话为 Markdown', group: '操作',
      keywords: 'export download markdown md',
      action: () => onExportCurrent(),
    });
    if (onCopyCurrent) ops.push({
      id: 'copy-all', label: '复制全部对话内容', group: '操作',
      keywords: 'copy all clipboard',
      action: () => onCopyCurrent(),
    });
    const provOps: Command[] = PROVIDERS.map((p) => ({
      id: `prov:${p.id}`,
      label: `切到 ${p.label}`,
      group: 'Provider',
      hint: effectiveProvider === p.id ? '✓ 当前' : undefined,
      action: () => onSetProvider(p.id),
    }));
    const sessOps: Command[] = sessions.map((s) => ({
      id: `sess:${s.id}`,
      label: s.title,
      group: '历史对话',
      hint: s.id === currentId ? '当前' : `${s.messageCount} 条`,
      keywords: s.id,
      action: () => onSelectSession(s.id),
    }));
    return [...ops, ...provOps, ...sessOps];
  }, [sessions, currentId, effectiveProvider, onSelectSession, onNewSession, onSetProvider, onExportCurrent, onCopyCurrent]);

  // 模糊匹配：lowercase 子串
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return commands;
    return commands.filter((c) => {
      const haystack = `${c.label} ${c.group ?? ''} ${c.keywords ?? ''}`.toLowerCase();
      return q.split(/\s+/).every((term) => haystack.includes(term));
    });
  }, [commands, query]);

  useEffect(() => { if (open) setActiveIdx(0); }, [open, query]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); }, [open]);

  // 键盘
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
      }
      else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[activeIdx];
        if (cmd) { onClose(); void cmd.action(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, filtered, activeIdx, onClose]);

  if (!open) return null;

  // 按 group 分组
  const groups: Record<string, Command[]> = {};
  for (const c of filtered) {
    const g = c.group ?? '其他';
    (groups[g] ||= []).push(c);
  }

  return (
    <div
      className="cmdk-root"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="cmdk-panel">
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="搜索命令、会话、provider……（↑↓ 选择，Enter 确认，Esc 关闭）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="命令搜索框"
        />
        <div className="cmdk-list" role="listbox">
          {filtered.length === 0 ? (
            <div className="cmdk-empty">没有匹配项</div>
          ) : (
            Object.entries(groups).map(([group, cmds]) => (
              <div key={group} className="cmdk-group">
                <div className="cmdk-group-label">{group}</div>
                {cmds.map((c) => {
                  const idx = filtered.indexOf(c);
                  const active = idx === activeIdx;
                  return (
                    <div
                      key={c.id}
                      className={'cmdk-item' + (active ? ' active' : '')}
                      onClick={() => { onClose(); void c.action(); }}
                      onMouseEnter={() => setActiveIdx(idx)}
                      role="option"
                      aria-selected={active}
                    >
                      <span className="cmdk-label">{c.label}</span>
                      {c.hint && <span className="cmdk-hint">{c.hint}</span>}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="cmdk-foot">
          <kbd>↑</kbd><kbd>↓</kbd> 选 · <kbd>Enter</kbd> 确认 · <kbd>Esc</kbd> 关
        </div>
      </div>
    </div>
  );
}
