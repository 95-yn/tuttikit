'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { Markdown } from '@/components/Markdown';
import { AttachmentList } from '@/components/AttachmentList';
import * as api from '@/lib/api';
import type { SharedView } from '@/lib/api';

interface Props {
  // Next.js 15: 动态 route params 是 Promise，client component 用 React.use() 拆
  params: Promise<{ token: string }>;
}

export default function SharedConversationPage({ params }: Props) {
  const { token } = use(params);
  const [view, setView] = useState<SharedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getSharedView(token)
      .then((v) => { if (!cancelled) setView(v); })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="share-page">
      <div className="share-banner">
        <span>这是一个分享的对话（只读），由 TuttiKit 生成</span>
        <Link href="/" className="link">回 TuttiKit 主页</Link>
      </div>

      <div className="share-container">
        {loading ? (
          <div className="share-status">加载中…</div>
        ) : error ? (
          <div className="share-status err">分享链接已过期或不存在</div>
        ) : view ? (
          <>
            <h1 className="share-title">{view.title || '未命名对话'}</h1>
            <div className="share-meta">
              创建于 {new Date(view.createdAt).toLocaleString()} · 分享于{' '}
              {new Date(view.sharedAt).toLocaleString()}
            </div>
            <div className="share-messages">
              {view.messages.length === 0 ? (
                <div className="share-status">该对话还没有任何消息</div>
              ) : (
                view.messages.map((m, idx) => {
                  if (m.role === 'tool') return null; // 只读视图里 tool 消息不展示
                  const role = m.role === 'user' ? 'user' : 'assistant';
                  return (
                    <div key={idx} className={`msg ${role}`}>
                      <div className="msg-inner">
                        <div className="msg-avatar">
                          {role === 'user' ? 'YOU' : 'AI'}
                        </div>
                        <div className="msg-body">
                          <div className="msg-author">
                            <span>{role === 'user' ? '你' : 'Conductor'}</span>
                          </div>
                          {m.attachments && m.attachments.length > 0 && (
                            <AttachmentList items={m.attachments} />
                          )}
                          {m.content && (
                            role === 'assistant' ? (
                              <Markdown text={m.content} className="msg-content" />
                            ) : (
                              <div className="msg-content">{m.content}</div>
                            )
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
