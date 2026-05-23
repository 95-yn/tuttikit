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
 */
import { memo, useState } from 'react';
import type { Artifact } from '@/lib/api';

interface Props {
  artifact: Artifact;
}

type Tab = 'preview' | 'source';

function ArtifactFrameImpl({ artifact }: Props) {
  const [tab, setTab] = useState<Tab>('preview');
  const title = artifact.title?.trim() || `Artifact · ${artifact.kind}`;

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
          </button>
        </div>
      </div>

      <div className="artifact-body">
        {tab === 'preview' ? (
          <iframe
            title={title}
            // ↓↓↓ 关键：只给 allow-scripts，不能加 allow-same-origin / allow-forms / allow-top-navigation / allow-popups
            sandbox="allow-scripts"
            srcDoc={artifact.html}
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
          <pre className="artifact-source">
            <code>{artifact.html}</code>
          </pre>
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
        }
        .artifact-tab:hover { color: var(--text); }
        .artifact-tab.active {
          background: var(--accent-soft, rgba(99, 102, 241, 0.16));
          color: var(--accent, #818cf8);
        }
        .artifact-body {
          padding: 10px 12px 12px;
        }
        .artifact-source {
          margin: 0;
          padding: 10px 12px;
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: var(--r-sm, 6px);
          font-size: 11.5px;
          line-height: 1.55;
          color: var(--text-dim, var(--text));
          max-height: 600px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
        }
      `}</style>
    </div>
  );
}

export const ArtifactFrame = memo(ArtifactFrameImpl, (prev, next) =>
  prev.artifact === next.artifact
  || (prev.artifact.id === next.artifact.id
      && prev.artifact.updatedAt === next.artifact.updatedAt),
);
