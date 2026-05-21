'use client';
import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';

interface SpanLike {
  spanId: string;
  parentId?: string | null;
  kind: 'agent' | 'llm' | 'tool' | string;
  name: string;
  startedAt: number;
  endedAt?: number | null;
  duration?: number;
  status?: 'running' | 'ok' | 'error';
  error?: string | null;
  usage?: { inputTokens?: number; outputTokens?: number } | null;
  output?: unknown;
  attrs?: Record<string, unknown>;
}

interface TraceFull {
  traceId: string;
  name: string;
  meta?: Record<string, unknown>;
  startedAt: number;
  endedAt: number | null;
  duration?: number;
  spans: SpanLike[];
  totals: { inputTokens: number; outputTokens: number; llmCalls: number; toolCalls: number };
}

interface TraceSummary {
  traceId: string;
  name: string;
  startedAt: number;
  duration: number;
  totals: TraceFull['totals'];
  spanCount: number;
}

export default function TracesPage() {
  const [list, setList] = useState<TraceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceFull | null>(null);
  // A/B 多 provider replay 的对比结果
  const [abResults, setAbResults] = useState<ReplayResult[] | null>(null);

  useEffect(() => {
    fetch('/api/traces')
      .then((r) => r.json())
      .then((arr: TraceSummary[]) => {
        const sorted = [...arr].sort((a, b) => b.startedAt - a.startedAt);
        setList(sorted);
        if (sorted[0]) setSelectedId(sorted[0].traceId);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedId) { setTrace(null); return; }
    fetch(`/api/traces/${selectedId}`)
      .then((r) => r.json())
      .then(setTrace)
      .catch(() => {});
  }, [selectedId]);

  return (
    <div className="traces-page">
      <header className="traces-header">
        <Link href="/" className="traces-back">← 返回对话</Link>
        <h1>Traces</h1>
        <span className="traces-count">{list.length} 条记录</span>
      </header>
      <div className="traces-body">
        <aside className="traces-list">
          {list.length === 0 ? (
            <div className="traces-empty">还没有 trace</div>
          ) : (
            list.map((t) => (
              <div
                key={t.traceId}
                className={'trace-list-item' + (t.traceId === selectedId ? ' active' : '')}
                onClick={() => setSelectedId(t.traceId)}
              >
                <div className="trace-list-name">{t.name}</div>
                <div className="trace-list-meta">
                  <span>{new Date(t.startedAt).toLocaleString()}</span>
                  <span className="trace-list-dur">{t.duration}ms</span>
                </div>
                <div className="trace-list-stats">
                  {t.totals.llmCalls} llm · {t.totals.toolCalls} tool · ↓{t.totals.inputTokens} ↑{t.totals.outputTokens}
                </div>
              </div>
            ))
          )}
        </aside>
        <main className="traces-detail">
          {trace ? (
            <>
              {abResults && (
                <ABComparePanel
                  results={abResults}
                  onClose={() => setAbResults(null)}
                  onPick={(id) => { setSelectedId(id); setAbResults(null); }}
                />
              )}
              <TraceTree
                trace={trace}
                onReplayed={async (newId) => {
                  // 刷新列表 + 跳到新 trace
                  const arr = await fetch('/api/traces').then((r) => r.json()) as TraceSummary[];
                  setList([...arr].sort((a, b) => b.startedAt - a.startedAt));
                  setSelectedId(newId);
                }}
                onCompare={async (results) => {
                  // 拉每个 replay 的完整 trace 用于展示 totals / 终答案
                  const fulls = await Promise.all(results.map(async (r) => {
                    if (!r.replayTraceId) return r;
                    try {
                      const t = await fetch(`/api/traces/${r.replayTraceId}`).then((x) => x.json()) as TraceFull;
                      return { ...r, _full: t };
                    } catch { return r; }
                  }));
                  setAbResults(fulls as ReplayResult[]);
                  // 同步刷新列表
                  const arr = await fetch('/api/traces').then((x) => x.json()) as TraceSummary[];
                  setList([...arr].sort((a, b) => b.startedAt - a.startedAt));
                }}
              />
            </>
          ) : <div className="traces-empty">选一条 trace 看详情</div>}
        </main>
      </div>
    </div>
  );
}

interface SpanNode { span: SpanLike; children: SpanNode[]; }

function buildTree(spans: SpanLike[]): SpanNode[] {
  const byId = new Map<string, SpanNode>();
  spans.forEach((s) => byId.set(s.spanId, { span: s, children: [] }));
  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    const p = node.span.parentId;
    if (p && byId.has(p)) byId.get(p)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function TraceTree({
  trace, onReplayed, onCompare,
}: {
  trace: TraceFull;
  onReplayed?: (newId: string) => void;
  onCompare?: (results: ReplayResult[]) => void;
}) {
  const tree = useMemo(() => buildTree(trace.spans), [trace.spans]);
  const meta = trace.meta as { message?: string; replayOf?: string; provider?: string } | undefined;
  return (
    <div className="trace-tree">
      <div className="trace-summary">
        <div className="trace-summary-head">
          <h2>{trace.name}</h2>
          {meta?.message && <ReplayControls traceId={trace.traceId} onDone={onReplayed} onCompare={onCompare} />}
        </div>
        <div className="trace-meta">
          <span>{new Date(trace.startedAt).toLocaleString()}</span>
          <span>{trace.duration}ms</span>
          <span>{trace.spans.length} spans</span>
          {meta?.replayOf && (
            <span className="trace-replay-of">
              ↻ replay of <code>{meta.replayOf}</code>
              {meta.provider && <> · provider <code>{meta.provider}</code></>}
            </span>
          )}
        </div>
        {meta?.message && (
          <div className="trace-original-msg">
            <span className="trace-original-msg-label">user message:</span>
            <span>{meta.message}</span>
          </div>
        )}
        <div className="trace-totals">
          tokens ↓ <b>{trace.totals.inputTokens}</b> in · ↑ <b>{trace.totals.outputTokens}</b> out ·
          {' '}{trace.totals.llmCalls} llm calls · {trace.totals.toolCalls} tool calls
        </div>
      </div>
      <div className="span-tree">
        {tree.map((n) => <SpanNodeView key={n.span.spanId} node={n} depth={0} />)}
      </div>
    </div>
  );
}

const REPLAY_PROVIDERS = [
  { id: '', label: '默认 (server .env)' },
  { id: 'mock', label: 'Mock（离线）' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'deepseek', label: 'DeepSeek' },
];

interface ReplayResult {
  replayTraceId?: string;
  provider: string;
  forkedSessionId?: string;
  error?: string;
  /** A/B 视图用：onCompare 处理时拉到的完整 trace */
  _full?: TraceFull;
}

function ABComparePanel({
  results, onClose, onPick,
}: {
  results: ReplayResult[];
  onClose: () => void;
  onPick: (traceId: string) => void;
}) {
  return (
    <div className="ab-compare">
      <div className="ab-compare-head">
        <h3>A/B Compare · {results.length} 个 provider</h3>
        <button type="button" className="x" onClick={onClose} aria-label="关闭对比">×</button>
      </div>
      <div className="ab-compare-grid">
        {results.map((r) => (
          <div key={r.provider} className={'ab-card' + (r.error ? ' ab-card-error' : '')}>
            <div className="ab-card-head">
              <span className="ab-card-provider">{r.provider}</span>
              {r._full && (
                <span className="ab-card-stats">
                  {r._full.duration}ms · ↓{r._full.totals.inputTokens} ↑{r._full.totals.outputTokens}
                </span>
              )}
            </div>
            {r.error ? (
              <div className="ab-card-error-msg">⚠ {r.error}</div>
            ) : r._full ? (
              <>
                <div className="ab-card-body">
                  {extractFinalAnswer(r._full) || <em style={{ color: 'var(--muted-2)' }}>（无文本输出）</em>}
                </div>
                <button
                  type="button"
                  className="ab-card-open"
                  onClick={() => r.replayTraceId && onPick(r.replayTraceId)}
                >
                  在右侧打开 →
                </button>
              </>
            ) : (
              <div className="ab-card-body">…</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 从 trace 的 spans 里抽 conductor 最后一个 LLM 输出当成终答 */
function extractFinalAnswer(t: TraceFull): string {
  const llmSpans = t.spans.filter((s) => s.kind === 'llm' && s.name.startsWith('conductor.llm'));
  for (let i = llmSpans.length - 1; i >= 0; i--) {
    const o = llmSpans[i].output;
    if (typeof o === 'string' && o.trim()) return o;
  }
  return '';
}

function ReplayControls({
  traceId, onDone, onCompare,
}: {
  traceId: string;
  onDone?: (newId: string) => void;
  onCompare?: (results: ReplayResult[]) => void;
}) {
  // 默认勾上「默认」单选；用户多选时进 A/B 模式
  const [selected, setSelected] = useState<Set<string>>(new Set(['']));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      if (next.size === 0) next.add('');   // 至少留一个
      return next;
    });
  };

  async function run() {
    setBusy(true); setErr(null);
    const providers = Array.from(selected);
    try {
      const res = await fetch(`/api/traces/${traceId}/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: providers.length > 1
          ? JSON.stringify({ providers: providers.map((p) => p || undefined) })
          : JSON.stringify({ provider: providers[0] || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { replayTraceId?: string; replays?: ReplayResult[] };
      if (data.replays) {
        // 多 provider A/B 模式：弹对比视图
        onCompare?.(data.replays);
        // 同时把第一个成功的设为当前 trace
        const firstOk = data.replays.find((r) => r.replayTraceId);
        if (firstOk?.replayTraceId) onDone?.(firstOk.replayTraceId);
      } else if (data.replayTraceId) {
        onDone?.(data.replayTraceId);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const labels = REPLAY_PROVIDERS.filter((p) => selected.has(p.id)).map((p) => p.label).join(' + ');
  const summary = selected.size === 1 ? labels : `${selected.size} 个并跑：${labels}`;

  return (
    <div className="trace-replay">
      <details className="trace-replay-picker">
        <summary>{summary}</summary>
        <div className="trace-replay-options">
          {REPLAY_PROVIDERS.map((p) => (
            <label key={p.id || '__default'}>
              <input
                type="checkbox"
                checked={selected.has(p.id)}
                onChange={() => toggle(p.id)}
                disabled={busy}
              />
              {p.label}
            </label>
          ))}
        </div>
      </details>
      <button type="button" className="trace-replay-btn" onClick={run} disabled={busy}>
        {busy ? '⏳ 重跑中…' : selected.size > 1 ? `↻ A/B Replay (${selected.size})` : '↻ Replay'}
      </button>
      {err && <span className="trace-replay-err">⚠ {err}</span>}
    </div>
  );
}

function SpanNodeView({ node, depth }: { node: SpanNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);   // 默认前两层展开
  const { span } = node;
  const kindIcon = span.kind === 'llm' ? '🧠' : span.kind === 'tool' ? '🔧' : '🎩';
  const statusColor = span.status === 'error' ? 'var(--error)'
    : span.status === 'running' ? 'var(--warn)' : 'var(--ok)';

  return (
    <div className="span-node">
      <div className="span-row" onClick={() => setOpen((v) => !v)}>
        <span className="span-caret" style={{ visibility: node.children.length ? 'visible' : 'hidden' }}>
          {open ? '▼' : '▶'}
        </span>
        <span className="span-icon">{kindIcon}</span>
        <span className="span-name">{span.name}</span>
        <span className="span-dot" style={{ background: statusColor }} />
        <span className="span-dur">{span.duration ?? '?'}ms</span>
        {span.usage && (
          <span className="span-usage">
            ↓{span.usage.inputTokens ?? 0} ↑{span.usage.outputTokens ?? 0}
          </span>
        )}
      </div>
      {open && (
        <div className="span-children">
          {(span.attrs && Object.keys(span.attrs).length > 0) || span.error || span.output ? (
            <details className="span-detail">
              <summary>详情</summary>
              {span.error && <div className="span-error">⚠ {span.error}</div>}
              {span.attrs && Object.keys(span.attrs).length > 0 && (
                <pre>{JSON.stringify(span.attrs, null, 2)}</pre>
              )}
              {span.output != null && (
                <>
                  <div className="span-detail-label">output</div>
                  <pre>{typeof span.output === 'string' ? span.output : JSON.stringify(span.output, null, 2)}</pre>
                </>
              )}
            </details>
          ) : null}
          {node.children.map((c) => <SpanNodeView key={c.span.spanId} node={c} depth={depth + 1} />)}
        </div>
      )}
    </div>
  );
}
