'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { VirtualList } from '@/components/VirtualList';

const SERVER_ROW_HEIGHT = 70;
const TOOL_ROW_HEIGHT = 56;

interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http';
  state: 'connected' | 'failed' | 'closed';
  toolCount: number;
  error?: string;
}
interface McpServerFull extends McpServerStatus {
  tools: Array<{ name: string; description?: string; parameters: unknown }>;
}
interface McpTranslation {
  server: string;
  displayNames: Record<string, string>;
  descriptions: Record<string, string>;
  path?: string;
  cached?: boolean;
}

/** mcp__server__toolName → toolName */
function stripPrefix(full: string, server: string): string {
  const prefix = `mcp__${server}__`;
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

export default function McpPage() {
  const [list, setList] = useState<McpServerStatus[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [full, setFull] = useState<McpServerFull | null>(null);
  const [busy, setBusy] = useState<string | null>(null);   // 当前 reconnect 的 server name
  const [msg, setMsg] = useState<string | null>(null);

  // 翻译态：每个 server 独立
  const [translation, setTranslation] = useState<McpTranslation | null>(null);
  const [translating, setTranslating] = useState(false);
  const [showZh, setShowZh] = useState(false);
  const [translateErr, setTranslateErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refreshList = useCallback(async () => {
    const arr = await fetch('/api/mcp').then((r) => r.json()) as McpServerStatus[];
    setList([...arr].sort((a, b) => a.name.localeCompare(b.name)));
    if (arr[0] && !selectedName) setSelectedName(arr[0].name);
  }, [selectedName]);

  useEffect(() => { void refreshList(); }, [refreshList]);

  useEffect(() => {
    setTranslation(null); setShowZh(false); setTranslateErr(null); setCopied(false);
    if (!selectedName) { setFull(null); return; }
    fetch(`/api/mcp/${encodeURIComponent(selectedName)}`)
      .then((r) => r.ok ? r.json() : null)
      .then(setFull)
      .catch(() => setFull(null));
    // 看磁盘上是否已经有这个 server 的翻译；备好但默认不显示
    fetch(`/api/mcp/${encodeURIComponent(selectedName)}/translation?lang=zh`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: McpTranslation | null) => {
        if (data) {
          setTranslation(data);
          // 不自动 setShowZh(true)，让用户主动点 🇨🇳 看中文
        }
      })
      .catch(() => {/* 没翻过 */});
  }, [selectedName, list]);   // list 变化（reconnect 完）也刷新当前 detail

  async function translate() {
    if (!selectedName) return;
    setTranslating(true); setTranslateErr(null);
    try {
      const r = await fetch(`/api/mcp/${encodeURIComponent(selectedName)}/translate?lang=zh`, { method: 'POST' });
      if (!r.ok) {
        const e = await r.json().catch(() => ({ error: `HTTP ${r.status}` })) as { error?: string };
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      const data = await r.json() as McpTranslation;
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
    } catch {/* ignore */}
  }

  async function reconnect(name: string) {
    setBusy(name); setMsg(null);
    try {
      const r = await fetch(`/api/mcp/${encodeURIComponent(name)}/reconnect`, { method: 'POST' });
      const data = await r.json() as { ok: boolean; toolCount?: number; error?: string };
      if (data.ok) {
        setMsg(`✓ ${name} 重连成功，加载 ${data.toolCount} 个工具`);
      } else {
        setMsg(`✗ ${name} 重连失败：${data.error}`);
      }
      await refreshList();
    } catch (e) {
      setMsg(`✗ 网络出错：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const stateClass = (s: McpServerStatus['state']): string =>
    s === 'connected' ? 'mcp-state-ok'
    : s === 'failed' ? 'mcp-state-err'
    : 'mcp-state-closed';

  return (
    <div className="admin-page">
      <header className="admin-header">
        <Link href="/" className="admin-back">← 返回对话</Link>
        <h1>MCP Servers</h1>
        <span className="admin-count">{list.length} 个</span>
        <button
          type="button"
          className="admin-action"
          onClick={() => void refreshList()}
          title="重新拉一遍 /api/mcp"
        >
          ↻ Refresh
        </button>
      </header>
      {msg && <div className="admin-flash">{msg}</div>}
      <div className="admin-body">
        <aside className="admin-list admin-list-virtual">
          <div className="admin-list-scroll">
            <VirtualList
              items={list}
              itemHeight={SERVER_ROW_HEIGHT}
              keyOf={(s) => s.name}
              empty={
                <div className="admin-empty">
                  .mcp.json 是空的，或没扫到。<br />
                  <code>cp .mcp.json.example .mcp.json</code> 然后重启 server
                </div>
              }
              renderItem={(s) => (
                <div
                  className={'admin-list-item vl-item vl-item-sm' + (s.name === selectedName ? ' active' : '')}
                  onClick={() => setSelectedName(s.name)}
                >
                  <div className="admin-list-name">
                    <span className={'mcp-state ' + stateClass(s.state)} title={s.state}>●</span>
                    {s.name}
                  </div>
                  <div className="admin-list-meta">
                    {s.transport} · {s.toolCount} tools
                    {s.error && <span className="mcp-err"> · {s.error.slice(0, 30)}…</span>}
                  </div>
                </div>
              )}
            />
          </div>
        </aside>
        <main className="admin-detail">
          {full ? (
            <>
              <div className="admin-detail-head">
                <h2>
                  <span className={'mcp-state ' + stateClass(full.state)}>●</span>
                  {full.name}
                </h2>
                <div className="admin-detail-actions">
                  {translation && (
                    <button
                      type="button"
                      className="admin-action"
                      onClick={() => setShowZh((v) => !v)}
                      title={showZh ? '切回英文' : '查看中文译文'}
                    >
                      {showZh ? '📄 看原文' : '🇨🇳 看中文'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="admin-action admin-action-primary"
                    onClick={() => void translate()}
                    disabled={translating || full.toolCount === 0}
                    title="翻译所有 tool 的 description + 生成中文显示名；落盘到 data/mcp-zh/"
                  >
                    {translating
                      ? '⏳ 翻译中…'
                      : translation
                      ? '↻ 重译'
                      : '🌐 翻译成中文'}
                  </button>
                  <button
                    type="button"
                    className="admin-action"
                    onClick={() => void reconnect(full.name)}
                    disabled={busy === full.name}
                  >
                    {busy === full.name ? '⏳ 重连中…' : '↻ Reconnect'}
                  </button>
                </div>
              </div>
              <table className="admin-kv">
                <tbody>
                  <tr><th>transport</th><td>{full.transport}</td></tr>
                  <tr><th>state</th><td className={stateClass(full.state)}>{full.state}</td></tr>
                  <tr><th>tools</th><td>{full.toolCount}</td></tr>
                  {full.error && <tr><th>error</th><td className="mcp-err">{full.error}</td></tr>}
                </tbody>
              </table>
              {translation && (
                <div className="skill-translation-info">
                  <span>
                    {showZh ? '当前显示：中文译文' : '当前显示：原文'}
                    {translation.cached && showZh && (
                      <span style={{ color: 'var(--muted-2)', marginLeft: 6 }}>（缓存）</span>
                    )}
                  </span>
                  {translation.path && (
                    <div className="skill-translation-path">
                      <span>译文保存于：</span>
                      <code>{translation.path}</code>
                      <button type="button" className="copy-btn" onClick={() => void copyPath()} title="复制路径">
                        {copied ? '✓ 已复制' : '📋'}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {translateErr && (
                <div className="skill-translate-err">⚠ 翻译失败：{translateErr}</div>
              )}
              <h3 className="admin-section">注册的工具（{full.tools.length}）</h3>
              {full.tools.length === 0 ? (
                <div className="admin-empty-inline">无</div>
              ) : (
                <div className="mcp-tools-virtual">
                  <VirtualList
                    items={full.tools}
                    itemHeight={TOOL_ROW_HEIGHT}
                    keyOf={(t) => t.name}
                    renderItem={(t) => {
                      const sn = stripPrefix(t.name, full.name);
                      const zhName = showZh ? translation?.displayNames?.[sn] : '';
                      const zhDesc = showZh ? translation?.descriptions?.[sn] : '';
                      return (
                        <div className="mcp-tool-row vl-item-sm">
                          <div className="mcp-tool-head">
                            {zhName ? (
                              <>
                                <strong>{zhName}</strong>
                                <code className="mcp-tool-id">{t.name}</code>
                              </>
                            ) : (
                              <code>{t.name}</code>
                            )}
                          </div>
                          {(zhDesc || t.description) && (
                            <div className="mcp-tool-desc">{zhDesc || t.description}</div>
                          )}
                        </div>
                      );
                    }}
                  />
                </div>
              )}
            </>
          ) : (
            <div className="admin-empty">{selectedName ? '加载中…' : '左侧选一个 server'}</div>
          )}
        </main>
      </div>
    </div>
  );
}
