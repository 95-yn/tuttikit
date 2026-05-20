'use client';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './IconSprite';
import { AttachmentList } from './AttachmentList';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import type { Attachment } from '@/lib/types';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  attachments: Attachment[];
  uploading: number;
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
}

const ACCEPT = 'image/png,image/jpeg,image/jpg,image/webp,image/gif,image/heic,image/heif,application/pdf';

export function Composer({
  value, onChange, onSend, onStop, busy,
  attachments, uploading, onAddFiles, onRemoveAttachment,
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const voice = useVoiceInput({ value, setValue: onChange });

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [value]);

  // 全局拖入文件 → 显示蒙层（监听 window 避免只在 composer 区接得到）
  useEffect(() => {
    let dragDepth = 0;
    const has = (e: DragEvent) =>
      Array.from(e.dataTransfer?.items || []).some((i) => i.kind === 'file');
    const onEnter = (e: DragEvent) => { if (has(e)) { dragDepth++; setDragOver(true); } };
    const onOver  = (e: DragEvent) => { if (has(e)) e.preventDefault(); };
    const onLeave = () => { if (--dragDepth <= 0) { dragDepth = 0; setDragOver(false); } };
    const onDrop  = (e: DragEvent) => {
      if (!has(e)) return;
      e.preventDefault();
      dragDepth = 0;
      setDragOver(false);
      if (e.dataTransfer?.files?.length) onAddFiles(e.dataTransfer.files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onAddFiles]);

  // 粘贴：剪贴板里的图片走上传
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      onAddFiles(files);
    }
  };

  const canSend = (!!value.trim() || attachments.length > 0) && uploading === 0;

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <AttachmentList items={attachments} variant="preview" onRemove={onRemoveAttachment} />
      )}
      <div className="composer-inner">
        <button
          type="button"
          className="btn-attach"
          onClick={() => fileRef.current?.click()}
          title="添加图片或 PDF"
          aria-label="添加附件"
        >
          <Icon name="i-plus" size="sm" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onAddFiles(e.target.files);
            e.target.value = '';      // 同一文件可以再次选择
          }}
        />
        <textarea
          ref={ref}
          id="input"
          rows={1}
          placeholder={voice.listening ? '正在听... (再次点击停止)'
            : uploading > 0 ? `上传中 (${uploading})…`
            : '发送消息...'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!busy && canSend) onSend();
            }
          }}
        />
        {voice.supported && (
          <button
            type="button"
            className={'btn-mic' + (voice.listening ? ' listening' : '')}
            onClick={voice.toggle}
            title={voice.listening ? '停止录音' : '语音输入'}
            aria-label={voice.listening ? '停止录音' : '语音输入'}
          >
            <Icon name={voice.listening ? 'i-mic-off' : 'i-mic'} size="sm" />
          </button>
        )}
        <button
          id="send"
          className={'btn-send' + (busy ? ' stop' : '')}
          disabled={!busy && !canSend}
          title={busy ? '停止生成' : '发送 (Enter)'}
          onClick={() => (busy ? onStop() : onSend())}
          type="button"
        >
          <Icon name={busy ? 'i-stop' : 'i-send'} size="sm" />
        </button>
      </div>
      {voice.interim && <div className="voice-interim">… {voice.interim}</div>}
      <div className="composer-hint">
        <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行 · 支持拖拽 / 粘贴图片 / PDF
      </div>

      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <Icon name="i-plus" size="lg" />
            <div>把图片或 PDF 拖到这里</div>
          </div>
        </div>
      )}
    </div>
  );
}
