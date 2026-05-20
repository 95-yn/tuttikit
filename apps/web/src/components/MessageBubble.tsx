'use client';
import { useState } from 'react';
import { Icon } from './IconSprite';
import { Markdown } from './Markdown';
import { ToolBlock, type ToolEntry } from './ToolBlock';
import { AttachmentList } from './AttachmentList';
import { fmtTime } from '@/lib/markdown';
import type { Attachment } from '@/lib/types';

export interface BubbleData {
  id: string;                       // 内部 React key
  role: 'user' | 'assistant' | 'error';
  content: string;
  streaming?: boolean;
  tools?: ToolEntry[];
  createdAt?: string;
  attachments?: Attachment[];
  _remoteId?: string;               // 与服务端 message id 关联，用于 SSE 事件路由
}

export function MessageBubble({ data }: { data: BubbleData }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(data.content); } catch {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  if (data.role === 'error') {
    return (
      <div className="msg assistant">
        <div className="msg-inner">
          <div className="msg-avatar" style={{ background: 'rgba(239,68,68,.2)', color: '#ef4444' }}>!</div>
          <div className="msg-body">
            <div className="msg-author"><span style={{ color: '#ef4444' }}>错误</span></div>
            <div className="msg-content" style={{ color: '#ef4444' }}>{data.content}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`msg ${data.role}`}>
      <div className="msg-inner">
        <div className="msg-avatar">{data.role === 'user' ? 'YOU' : 'AI'}</div>
        <div className="msg-body">
          <div className="msg-author">
            <span>{data.role === 'user' ? '你' : 'Conductor'}</span>
            {data.createdAt && <span className="msg-time">· {fmtTime(data.createdAt)}</span>}
          </div>
          {data.attachments && data.attachments.length > 0 && (
            <AttachmentList items={data.attachments} />
          )}
          {data.content && (
            <Markdown text={data.content} streaming={data.streaming} className="msg-content" />
          )}
          {data.tools && data.tools.length > 0 && (
            <div className="msg-tools">
              {data.tools.map((t) => <ToolBlock key={t.toolCallId} entry={t} />)}
            </div>
          )}
          {data.role === 'assistant' && !data.streaming && data.content && (
            <div className="msg-actions">
              <button
                className={'msg-action-btn' + (copied ? ' copied' : '')}
                onClick={onCopy}
                type="button"
              >
                <Icon name={copied ? 'i-check' : 'i-copy'} size="sm" />
                <span>{copied ? '已复制' : '复制'}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
