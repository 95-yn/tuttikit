'use client';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface SlashItem {
  id: string;                                // 唯一 id（skill name 或 mcp tool fullName）
  kind: 'skill' | 'mcp';
  label: string;                             // 显示名（中文/原文，由 Composer 决定）
  hint: string;                              // 灰色补充信息（scope、description 截断）
  /** 选中后插入到输入框的模板。`{cursor}` 标记光标停留位置；不填则默认末尾 */
  insertText: string;
  /** 搜索 haystack */
  keywords: string;
}

interface Props {
  open: boolean;
  query: string;                             // /<query>
  items: SlashItem[];
  onSelect: (it: SlashItem) => void;
  onClose: () => void;
  /** activeIdx 受控（方便 Composer 拦截上下箭头） */
  activeIdx: number;
  setActiveIdx: (n: number) => void;
}

/**
 * 浮在 Composer 上方的 slash 命令面板。
 *   - 不自带 input；query 是 Composer 维护的 value，去掉前缀 `/` 后传进来
 *   - 不自带键盘（ArrowUp/Down/Enter/Esc 由 Composer 拦截后调 props.onSelect / setActiveIdx / onClose）
 *   - 自动滚动到 active item
 */
export function SlashMenu({
  open, query, items, onSelect, onClose, activeIdx, setActiveIdx,
}: Props) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [scope, setScope] = useState<'all' | 'skill' | 'mcp'>('all');

  // 模糊匹配（lowercased 子串、所有词 AND）
  const filtered = useMemo(() => {
    let pool = items;
    if (scope !== 'all') pool = pool.filter((it) => it.kind === scope);
    const q = query.toLowerCase().trim();
    if (!q) return pool;
    const terms = q.split(/\s+/).filter(Boolean);
    return pool.filter((it) => {
      const hay = it.keywords.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [items, query, scope]);

  // query/scope 变 → 复位高亮
  useEffect(() => { setActiveIdx(0); }, [query, scope, setActiveIdx]);

  // 关闭时跳过渲染（保留 unmount，下次打开干净）
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, onClose]);

  // active item 滚到可视区
  useEffect(() => {
    const el = itemRefs.current[activeIdx];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, filtered.length]);

  if (!open) return null;

  // 分组（保留 filtered 顺序）
  const skillItems = filtered.filter((it) => it.kind === 'skill');
  const mcpItems = filtered.filter((it) => it.kind === 'mcp');
  // 把 active 算到全局 filtered 索引，让 Composer 的键盘逻辑统一
  const indexed: Array<{ it: SlashItem; globalIdx: number }> = filtered.map((it, i) => ({ it, globalIdx: i }));
  // 分组渲染时按 kind 拆，但保留 globalIdx 让 active 高亮对得上

  return (
    <div className="slash-menu" ref={listRef} role="listbox">
      <div className="slash-menu-head">
        <div className="slash-menu-tabs">
          {(['all', 'skill', 'mcp'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={'slash-tab' + (scope === k ? ' active' : '')}
              onClick={() => setScope(k)}
            >
              {k === 'all' ? '全部'
               : k === 'skill' ? `Skills (${items.filter((it) => it.kind === 'skill').length})`
               : `MCP (${items.filter((it) => it.kind === 'mcp').length})`}
            </button>
          ))}
        </div>
        <span className="slash-menu-help">↑↓ 选 · Enter 确认 · Esc 关</span>
      </div>
      <div className="slash-menu-list">
        {filtered.length === 0 ? (
          <div className="slash-menu-empty">没匹配项</div>
        ) : (
          <>
            {(scope === 'all' || scope === 'skill') && skillItems.length > 0 && (
              <div className="slash-group">
                <div className="slash-group-label">SKILLS</div>
                {skillItems.map((it) => {
                  const g = indexed.findIndex((x) => x.it.id === it.id);
                  return (
                    <div
                      key={it.id}
                      ref={(el) => { itemRefs.current[g] = el; }}
                      className={'slash-item' + (g === activeIdx ? ' active' : '')}
                      onMouseEnter={() => setActiveIdx(g)}
                      onMouseDown={(e) => { e.preventDefault(); onSelect(it); }}
                    >
                      <span className="slash-item-icon">🧩</span>
                      <span className="slash-item-label">{it.label}</span>
                      <span className="slash-item-hint">{it.hint}</span>
                    </div>
                  );
                })}
              </div>
            )}
            {(scope === 'all' || scope === 'mcp') && mcpItems.length > 0 && (
              <div className="slash-group">
                <div className="slash-group-label">MCP TOOLS</div>
                {mcpItems.map((it) => {
                  const g = indexed.findIndex((x) => x.it.id === it.id);
                  return (
                    <div
                      key={it.id}
                      ref={(el) => { itemRefs.current[g] = el; }}
                      className={'slash-item' + (g === activeIdx ? ' active' : '')}
                      onMouseEnter={() => setActiveIdx(g)}
                      onMouseDown={(e) => { e.preventDefault(); onSelect(it); }}
                    >
                      <span className="slash-item-icon">🔌</span>
                      <span className="slash-item-label">{it.label}</span>
                      <span className="slash-item-hint">{it.hint}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Composer 给 SlashMenu 用的：把 skills/mcp 数据拼成统一 SlashItem[] */
export function buildSlashItems(args: {
  skills: Array<{ name: string; description: string; scope: string }>;
  mcpTools: Array<{ name: string; description?: string }>;
  /** 已翻译的 skill display 名（可选） */
  zhSkillNames?: Record<string, string>;
}): SlashItem[] {
  const skillItems: SlashItem[] = args.skills.map((s) => {
    const zh = args.zhSkillNames?.[s.name];
    return {
      id: s.name,
      kind: 'skill',
      label: zh || s.name,
      hint: `${s.scope} · ${s.description.slice(0, 80)}`,
      keywords: `${s.name} ${zh || ''} ${s.description}`,
      insertText: `请使用 skill \`${s.name}\` 完成：{cursor}`,
    };
  });
  const mcpItems: SlashItem[] = args.mcpTools.map((t) => ({
    id: t.name,
    kind: 'mcp',
    label: t.name,
    hint: (t.description ?? '').slice(0, 80),
    keywords: `${t.name} ${t.description ?? ''}`,
    insertText: `请使用工具 \`${t.name}\` {cursor}`,
  }));
  return [...skillItems, ...mcpItems];
}
