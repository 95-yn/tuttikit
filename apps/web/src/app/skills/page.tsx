'use client';
import { useCallback, useDeferredValue, useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { Markdown } from '@/components/Markdown';
import { VirtualList } from '@/components/VirtualList';

/** 列表项固定行高（px）—— 改这里要同步 .vl-item 的 CSS height */
const ITEM_HEIGHT = 80;

interface SkillMeta {
  name: string;
  description: string;
  source: string;
  scope: 'project' | 'user' | 'plugin';
}
interface SkillFull extends SkillMeta {
  body: string;
}
interface Translation {
  name: string;
  description: string;
  body: string;
  path: string;        // 落盘文件绝对路径
  cached?: boolean;
  provider?: string;
}

export default function SkillsPage() {
  const [list, setList] = useState<SkillMeta[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [full, setFull] = useState<SkillFull | null>(null);
  const [reloading, setReloading] = useState(false);
  const [filter, setFilter] = useState('');
  // 过滤用 deferred + transition：打字时立即更新输入框，过滤稍后做，不阻塞主线程
  const deferredFilter = useDeferredValue(filter);
  const [, startTransition] = useTransition();

  // 列表显示名翻译：name → 中文显示名；空 map 表示没翻过 / 没启用
  const [zhNames, setZhNames] = useState<Record<string, string>>({});
  const [translatingNames, setTranslatingNames] = useState(false);
  const [showZhNames, setShowZhNames] = useState(false);

  // 翻译：每个 skill 独立的 zh 译文 + 当前是否在"查看译文"模式
  const [translation, setTranslation] = useState<Translation | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateErr, setTranslateErr] = useState<string | null>(null);
  const [showZh, setShowZh] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const arr = await fetch('/api/skills').then((r) => r.json()) as SkillMeta[];
    const sorted = [...arr].sort((a, b) => a.name.localeCompare(b.name));
    setList(sorted);
    if (sorted[0] && !selectedName) setSelectedName(sorted[0].name);
  }, [selectedName]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 进页面就去拉「列表显示名」缓存（有就备好，**默认不显示**，要看点 🇨🇳）
  useEffect(() => {
    fetch('/api/skills/translated-names?lang=zh')
      .then((r) => r.ok ? r.json() : null)
      .then((data: { names: Record<string, string> } | null) => {
        if (data?.names && Object.keys(data.names).length > 0) {
          setZhNames(data.names);
          // 注意：不自动 setShowZhNames(true)，保持原文显示，让用户主动选
        }
      })
      .catch(() => {/* 没有就用原 name */});
  }, []);

  async function onTranslateNames() {
    setTranslatingNames(true);
    try {
      const r = await fetch('/api/skills/translate-names?lang=zh', { method: 'POST' });
      if (!r.ok) return;
      // 完成后再 GET 一次拿全集（POST 返回 path 但不直接给 names map）
      const data = await fetch('/api/skills/translated-names?lang=zh').then((x) => x.json());
      if (data?.names) {
        setZhNames(data.names);
        setShowZhNames(true);
      }
    } finally {
      setTranslatingNames(false);
    }
  }

  const displayName = (n: string): string => (showZhNames && zhNames[n]) || n;

  // 切 skill 时清空翻译态 + 拉详情 + 检查是否已有落盘译文
  useEffect(() => {
    setTranslation(null);
    setShowZh(false);
    setTranslateErr(null);
    setCopied(false);
    if (!selectedName) { setFull(null); return; }

    fetch(`/api/skills/${encodeURIComponent(selectedName)}`)
      .then((r) => r.ok ? r.json() : null)
      .then(setFull)
      .catch(() => setFull(null));

    // 看磁盘上有没有这个 skill 的中文翻译（hash 一致才返回，过期会 404）
    fetch(`/api/skills/${encodeURIComponent(selectedName)}/translation?lang=zh`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: Translation | null) => {
        if (data) {
          setTranslation(data);
          // 默认显示原文，不自动切到中文；按钮变成 "🇨🇳 看中文" 让用户主动选
        }
      })
      .catch(() => {/* 没有就没有 */});
  }, [selectedName]);

  async function onTranslate() {
    if (!selectedName) return;
    setTranslating(true);
    setTranslateErr(null);
    try {
      const r = await fetch(`/api/skills/${encodeURIComponent(selectedName)}/translate?lang=zh`, { method: 'POST' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` })) as { error?: string };
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      const data = await r.json() as Translation;
      setTranslation(data);
      setShowZh(true);
    } catch (e) {
      setTranslateErr((e as Error).message);
    } finally {
      setTranslating(false);
    }
  }

  async function copyPath() {
    if (!translation?.path) return;
    try {
      await navigator.clipboard.writeText(translation.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  async function onReload() {
    setReloading(true);
    try {
      await fetch('/api/skills/reload', { method: 'POST' });
      await refresh();
      if (selectedName) {
        const stillExists = await fetch(`/api/skills/${encodeURIComponent(selectedName)}`).then((r) => r.ok).catch(() => false);
        if (!stillExists) setSelectedName(null);
      }
    } finally {
      setReloading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = deferredFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q),
    );
  }, [list, deferredFilter]);

  // 选中 item 在 filtered 里的索引（用来 scroll-to）
  const selectedIdx = useMemo(
    () => selectedName ? filtered.findIndex((s) => s.name === selectedName) : -1,
    [filtered, selectedName],
  );

  const displayDesc = showZh && translation ? translation.description : full?.description;
  const displayBody = showZh && translation ? translation.body : full?.body;

  return (
    <div className="admin-page">
      <header className="admin-header">
        <Link href="/" className="admin-back">← 返回对话</Link>
        <h1>Skills</h1>
        <span className="admin-count">{list.length} 个已加载</span>
        <button
          type="button"
          className="admin-action"
          onClick={() => void onTranslateNames()}
          disabled={translatingNames}
          title="一次性翻译所有 skill 的显示名（保留原 id 不变；结果落盘 data/skills-zh/_names.zh.json）"
        >
          {translatingNames
            ? '⏳ 翻译中…'
            : Object.keys(zhNames).length > 0
            ? `↻ 重译名称 (${Object.keys(zhNames).length})`
            : '🏷 翻译列表名称'}
        </button>
        {Object.keys(zhNames).length > 0 && (
          <button
            type="button"
            className="admin-action"
            onClick={() => setShowZhNames((v) => !v)}
            title="切换列表显示中文名 / 原 id"
          >
            {showZhNames ? '🅰 看原名' : '🇨🇳 看中文名'}
          </button>
        )}
        <button
          type="button"
          className="admin-action"
          onClick={onReload}
          disabled={reloading}
          title="重新扫描 ~/.claude/skills、.claude/skills、~/.claude/plugins/marketplaces"
        >
          {reloading ? '⏳ 扫盘中…' : '↻ Reload'}
        </button>
      </header>
      <div className="admin-body">
        <aside className="admin-list admin-list-virtual">
          <input
            className="admin-filter"
            placeholder="过滤名字 / 描述"
            value={filter}
            onChange={(e) => {
              const next = e.target.value;
              // 输入框立即更新；过滤 + 重渲染推到 transition
              setFilter(next);
              startTransition(() => { /* deferredFilter 自动驱动 filtered useMemo */ });
            }}
          />
          <div className="admin-list-scroll">
            <VirtualList
              items={filtered}
              itemHeight={ITEM_HEIGHT}
              scrollToIndex={selectedIdx >= 0 ? selectedIdx : undefined}
              empty={
                <div className="admin-empty">
                  {list.length === 0
                    ? '没扫到 skill。放一个 SKILL.md 到 .claude/skills/<name>/ 试试'
                    : '过滤没匹配'}
                </div>
              }
              keyOf={(s) => s.name}
              renderItem={(s) => {
                const zh = showZhNames ? zhNames[s.name] : '';
                return (
                  <div
                    className={'admin-list-item vl-item' + (s.name === selectedName ? ' active' : '')}
                    onClick={() => setSelectedName(s.name)}
                  >
                    <div className="admin-list-name">
                      <span className={'skill-scope skill-scope-' + s.scope}>{s.scope}</span>
                      {zh || s.name}
                    </div>
                    {zh && (
                      <div className="admin-list-id" title="程序调用用的 id">{s.name}</div>
                    )}
                    <div className="admin-list-meta">{s.description}</div>
                  </div>
                );
              }}
            />
          </div>
        </aside>
        <main className="admin-detail">
          {full ? (
            <>
              <div className="admin-detail-head">
                <h2>
                  <span className={'skill-scope skill-scope-' + full.scope}>{full.scope}</span>
                  {displayName(full.name)}
                  {showZhNames && zhNames[full.name] && (
                    <code className="admin-detail-id" title="程序调用用的 id">{full.name}</code>
                  )}
                </h2>
                <div className="admin-detail-actions">
                  {translation ? (
                    <button
                      type="button"
                      className="admin-action"
                      onClick={() => setShowZh((v) => !v)}
                      title={showZh ? '切回原文' : '查看已保存的中文译文'}
                    >
                      {showZh ? '📄 看原文' : '🇨🇳 看中文'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="admin-action admin-action-primary"
                    onClick={onTranslate}
                    disabled={translating}
                    title={translation ? '原文若已变可重新翻译' : '调用 LLM 翻译 description + body，结果落盘到 data/skills-zh/'}
                  >
                    {translating
                      ? '⏳ 翻译中…'
                      : translation
                      ? '↻ 重新翻译'
                      : '🌐 翻译成中文'}
                  </button>
                </div>
              </div>
              <code className="admin-detail-path" title="原 SKILL.md 文件路径">{full.source}</code>
              {translation && (
                <div className="skill-translation-info">
                  <span>
                    {showZh ? '当前显示：中文译文' : '当前显示：原文'}
                    {translation.cached && showZh && (
                      <span style={{ color: 'var(--muted-2)', marginLeft: 6 }}>（缓存）</span>
                    )}
                  </span>
                  <div className="skill-translation-path">
                    <span>译文保存于：</span>
                    <code>{translation.path}</code>
                    <button type="button" className="copy-btn" onClick={() => void copyPath()} title="复制路径">
                      {copied ? '✓ 已复制' : '📋'}
                    </button>
                  </div>
                </div>
              )}
              {translateErr && (
                <div className="skill-translate-err">⚠ 翻译失败：{translateErr}</div>
              )}
              <div className="admin-detail-desc">{displayDesc}</div>
              <hr className="admin-hr" />
              <div className="skill-body">
                <Markdown text={displayBody || ''} />
              </div>
            </>
          ) : (
            <div className="admin-empty">{selectedName ? '加载中…' : '左侧选一个 skill'}</div>
          )}
        </main>
      </div>
    </div>
  );
}
