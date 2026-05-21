'use client';
import { memo, useState } from 'react';
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
  /** 是否是「最新一条 assistant」—— 仅它显示 ↻ 重生按钮 */
  isLatestAssistant?: boolean;
  _remoteId?: string;               // 与服务端 message id 关联
}

interface MessageBubbleProps {
  data: BubbleData;
  onRegenerate?: () => void;        // 只在 isLatestAssistant 时被调用
}

export const MessageBubble = memo(MessageBubbleImpl, (prev, next) => {
  const a = prev.data, b = next.data;
  if (a === b && prev.onRegenerate === next.onRegenerate) return true;
  if (a.streaming || b.streaming) return false;
  return (
    a.id === b.id &&
    a.content === b.content &&
    a.role === b.role &&
    a.tools === b.tools &&
    a.attachments === b.attachments &&
    a.streaming === b.streaming &&
    a.isLatestAssistant === b.isLatestAssistant &&
    prev.onRegenerate === next.onRegenerate
  );
});

function MessageBubbleImpl({ data, onRegenerate }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(data.content); } catch {/* ignore */}
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

  const showActions = !data.streaming && data.content;

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
          {showActions && (
            <div className="msg-actions">
              <button
                className={'msg-action-btn' + (copied ? ' copied' : '')}
                onClick={onCopy}
                type="button"
                aria-label="复制消息"
              >
                <Icon name={copied ? 'i-check' : 'i-copy'} size="sm" />
                <span>{copied ? '已复制' : '复制'}</span>
              </button>
              {data.role === 'assistant' && data.isLatestAssistant && onRegenerate && (
                <button
                  className="msg-action-btn"
                  onClick={onRegenerate}
                  type="button"
                  aria-label="重新生成"
                  title="重新生成（截断当前回复后重跑）"
                >
                  <Icon name="i-edit" size="sm" />
                  <span>重生</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
