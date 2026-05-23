'use client';
/**
 * Claude Artifacts 风格的 HTML/SVG 沙箱渲染面板。
 *
 * 安全要点：
 *   - iframe sandbox **只** 给 `allow-scripts`，
 *     不允许 same-origin / forms / top-navigation / popups
 *     —— 即使 LLM 写 eval/fetch 也只能在沙箱里跑，拿不到宿主 cookie/storage/路由
 *   - 用 `srcDoc` 而不是把 html 注入 React 树（避免 React 解析）
 *   - 同 artifactId 重复 render 由父组件用 React `key={artifact.id}` 触发 remount
 *
 * 编辑能力：
 *   - 源码 tab 是受控 textarea，本地 state `editedHtml`
 *   - 预览始终用 `editedHtml`（未保存也能即时预览）
 *   - 保存按钮调 PUT /artifacts/:id，乐观更新（不等 SSE 推回）
 *   - 上游 artifact 变更（SSE / 切 artifact）：无脏则同步，有脏则提示但不覆盖
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { updateArtifact, type Artifact } from '@/lib/api';
import { showToast } from './ToastModalHost';

interface Props {
  artifact: Artifact;
}

type Tab = 'preview' | 'source';

function ArtifactFrameImpl({ artifact }: Props) {
  const [tab, setTab] = useState<Tab>('preview');
  const [editedHtml, setEditedHtml] = useState<string>(artifact.html);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [upstreamConflict, setUpstreamConflict] = useState(false);

  const title = artifact.title?.trim() || `Artifact · ${artifact.kind}`;
  const dirty = editedHtml !== artifact.html;

  // 上游 artifact 变化时的同步策略：
  //   - 无脏 → 直接同步 editedHtml，并清掉冲突提示
  //   - 有脏 → 不覆盖用户输入，但提示「LLM 改了，需要 reload 吗？」
  // 用 ref 拿到最新 dirty/editedHtml，避免把它们放进 deps 触发不必要的 effect。
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const editedRef = useRef(editedHtml);
  editedRef.current = editedHtml;

  useEffect(() => {
    if (!dirtyRef.current) {
      setEditedHtml(artifact.html);
      setUpstreamConflict(false);
    } else if (artifact.html !== editedRef.current) {
      // 上游推了新版本，且我们本地有未保存改动 → 冲突
      setUpstreamConflict(true);
    }
  }, [artifact.id, artifact.html, artifact.updatedAt]);

  const handleReload = useCallback(() => {
    setEditedHtml(artifact.html);
    setUpstreamConflict(false);
  }, [artifact.html]);

  const handleReset = useCallback(() => {
    setEditedHtml(artifact.html);
    setUpstreamConflict(false);
  }, [artifact.html]);

  const handleSave = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const updated = await updateArtifact(artifact.id, { html: editedHtml });
      // 乐观更新：本地立即把 editedHtml 当作新基线（不等 SSE）
      // 注意 artifact 是 prop，无法直接改；但下次 prop 同步进来时 dirty=false，会自动 sync。
      // 这里我们临时把 editedHtml 设为 updated.html 让 dirty 立刻变 false（一般跟原值相同）
      setEditedHtml(updated.html);
      setUpstreamConflict(false);
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 2000);
    } catch (err) {
      showToast((err as Error).message || '保存失败', { type: 'error' });
    } finally {
      setSaving(false);
    }
  }, [artifact.id, dirty, editedHtml, saving]);

  // Tab 键插入 2 空格（不抢焦点跳出 textarea）
  const handleTextareaKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const next = editedHtml.slice(0, start) + '  ' + editedHtml.slice(end);
        setEditedHtml(next);
        // 光标移到插入位置之后
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
        });
      } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void handleSave();
      }
    },
    [editedHtml, handleSave],
  );

  return (
    <div className="artifact-frame">
      <div className="artifact-head">
        <div className="artifact-title" title={title}>
          <span className="artifact-kind">{artifact.kind.toUpperCase()}</span>
          <span className="artifact-title-text">{title}</span>
        </div>
        <div className="artifact-tabs" role="tablist" aria-label="Artifact 视图">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'preview'}
            className={'artifact-tab' + (tab === 'preview' ? ' active' : '')}
            onClick={() => setTab('preview')}
          >
            预览
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'source'}
            className={'artifact-tab' + (tab === 'source' ? ' active' : '')}
            onClick={() => setTab('source')}
          >
            源码
            {dirty && <span className="dirty-dot" aria-label="未保存的改动" />}
          </button>
        </div>
        <div className="artifact-actions">
          {justSaved && <span className="save-flash">已保存</span>}
          <button
            type="button"
            className="artifact-btn ghost"
            onClick={handleReset}
            disabled={!dirty || saving}
            title="放弃改动，恢复到当前 artifact 版本"
          >
            重置
          </button>
          <button
            type="button"
            className="artifact-btn primary"
            onClick={handleSave}
            disabled={!dirty || saving}
            title="保存为新版本 (Cmd/Ctrl+S)"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {upstreamConflict && (
        <div className="artifact-conflict" role="alert">
          <span>LLM 又改了这个 artifact，你本地有未保存的修改。</span>
          <button type="button" className="conflict-link" onClick={handleReload}>
            放弃我的改动并 reload
          </button>
        </div>
      )}

      <div className="artifact-body">
        {tab === 'preview' ? (
          <iframe
            title={title}
            // ↓↓↓ 关键：只给 allow-scripts，不能加 allow-same-origin / allow-forms / allow-top-navigation / allow-popups
            sandbox="allow-scripts"
            // 预览用 editedHtml（即时反映源码 tab 的输入），不是 artifact.html
            srcDoc={editedHtml}
            style={{
              width: '100%',
              border: 'none',
              borderRadius: 8,
              minHeight: 200,
              height: 360,
              maxHeight: 600,
              resize: 'vertical',
              display: 'block',
              background: '#fff',
            }}
          />
        ) : (
          <textarea
            className="artifact-source-edit"
            value={editedHtml}
            onChange={(e) => setEditedHtml(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            aria-label="Artifact 源码"
          />
        )}
      </div>

      <style jsx>{`
        .artifact-frame {
          margin-top: 8px;
          border: 1px solid var(--border);
          border-radius: var(--r-md, 10px);
          background: var(--bg-elev-1);
          overflow: hidden;
        }
        .artifact-head {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 12px;
          border-bottom: 1px solid var(--border);
          background: var(--bg-elev-2, var(--bg-elev-1));
        }
        .artifact-title {
          flex: 1;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: var(--t-xs, 12px);
          color: var(--text);
          font-weight: 600;
          overflow: hidden;
        }
        .artifact-kind {
          display: inline-block;
          font-size: 10px;
          letter-spacing: 0.4px;
          padding: 2px 7px;
          border-radius: 999px;
          background: var(--accent-soft, rgba(99, 102, 241, 0.14));
          color: var(--accent, #818cf8);
          font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
          flex: 0 0 auto;
        }
        .artifact-title-text {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .artifact-tabs {
          display: inline-flex;
          gap: 2px;
          padding: 2px;
          border-radius: 8px;
          background: var(--bg);
          border: 1px solid var(--border);
        }
        .artifact-tab {
          appearance: none;
          background: transparent;
          color: var(--muted, #9ca3af);
          border: none;
          padding: 3px 10px;
          font-size: var(--t-xs, 11.5px);
          font-weight: 600;
          border-radius: 6px;
          cursor: pointer;
          transition: background 0.12s ease, color 0.12s ease;
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .artifact-tab:hover { color: var(--text); }
        .artifact-tab.active {
          background: var(--accent-soft, rgba(99, 102, 241, 0.16));
          color: var(--accent, #818cf8);
        }
        .dirty-dot {
          display: inline-block;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #ef4444;
          box-shadow: 0 0 0 2px var(--bg, transparent);
        }
        .artifact-actions {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .save-flash {
          font-size: 11px;
          color: #10b981;
          font-weight: 600;
          margin-right: 4px;
          animation: fade-in 0.15s ease;
        }
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(-2px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .artifact-btn {
          appearance: none;
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 3px 10px;
          font-size: 11.5px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.12s ease, color 0.12s ease, opacity 0.12s ease;
          background: transparent;
          color: var(--text);
        }
        .artifact-btn.ghost { color: var(--muted, #9ca3af); }
        .artifact-btn.ghost:hover:not(:disabled) {
          color: var(--text);
          background: var(--bg);
        }
        .artifact-btn.primary {
          background: var(--accent, #6366f1);
          color: #fff;
          border-color: transparent;
        }
        .artifact-btn.primary:hover:not(:disabled) { filter: brightness(1.08); }
        .artifact-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
          background: transparent;
          color: var(--muted, #9ca3af);
          border-color: var(--border);
        }
        .artifact-conflict {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 6px 12px;
          font-size: 11.5px;
          background: rgba(245, 158, 11, 0.12);
          color: #d97706;
          border-bottom: 1px solid var(--border);
        }
        .conflict-link {
          appearance: none;
          background: transparent;
          border: none;
          color: inherit;
          text-decoration: underline;
          font-weight: 600;
          cursor: pointer;
          padding: 0;
          font-size: inherit;
        }
        .artifact-body {
          padding: 10px 12px 12px;
        }
        .artifact-source-edit {
          display: block;
          width: 100%;
          min-height: 200px;
          max-height: 600px;
          padding: 8px;
          margin: 0;
          background: var(--bg);
          color: var(--text);
          border: 1px solid var(--border);
          border-radius: var(--r-sm, 6px);
          font-family: ui-monospace, Menlo, monospace;
          font-size: 11.5px;
          line-height: 1.55;
          resize: vertical;
          outline: none;
          tab-size: 2;
          white-space: pre;
        }
        .artifact-source-edit:focus {
          border-color: var(--accent, #6366f1);
          box-shadow: 0 0 0 2px var(--accent-soft, rgba(99, 102, 241, 0.18));
        }
      `}</style>
    </div>
  );
}

export const ArtifactFrame = memo(ArtifactFrameImpl, (prev, next) =>
  prev.artifact === next.artifact
  || (prev.artifact.id === next.artifact.id
      && prev.artifact.updatedAt === next.artifact.updatedAt
      && prev.artifact.html === next.artifact.html),
);
