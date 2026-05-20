'use client';
import { Icon } from './IconSprite';
import { uploadUrl } from '@/lib/api';
import type { Attachment } from '@/lib/types';

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function ParsedBadge({ a }: { a: Attachment }) {
  if (a.extractError) {
    return <span className="att-parsed err" title={a.extractError}>⚠ 解析失败</span>;
  }
  if (a.extractedChars && a.extractedChars > 0) {
    const tip =
      a.kind === 'pdf'
        ? `已解析 PDF 文本：${a.extractedChars} 字符${a.pages ? ` · ${a.pages} 页` : ''}`
        : `OCR 提取：${a.extractedChars} 字符${typeof a.ocrConfidence === 'number' ? ` · 置信度 ${a.ocrConfidence}%` : ''}`;
    return <span className="att-parsed ok" title={tip}>📝 {fmtChars(a.extractedChars)} 字</span>;
  }
  return null;
}

/**
 * 渲染一组已上传附件。
 *   - 图片：缩略图，点击新窗口打开原图
 *   - PDF：卡片，带文件名 + 大小，点击新窗口打开
 *
 * variant='preview'：composer 上方的待发送预览态，每项右上角带 ✕
 */
export function AttachmentList({
  items, variant = 'message', onRemove,
}: {
  items: Attachment[];
  variant?: 'message' | 'preview';
  onRemove?: (id: string) => void;
}) {
  if (!items.length) return null;
  const className = 'att-list' + (variant === 'preview' ? ' preview' : '');
  return (
    <div className={className}>
      {items.map((a) => (
        <div key={a.id} className={'att att-' + a.kind}>
          {a.kind === 'image' ? (
            <>
              <a href={uploadUrl(a.id)} target="_blank" rel="noopener" className="att-image">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={uploadUrl(a.id)} alt={a.filename} loading="lazy" />
              </a>
              <div className="att-overlay-bottom"><ParsedBadge a={a} /></div>
            </>
          ) : (
            <a href={uploadUrl(a.id)} target="_blank" rel="noopener" className="att-pdf">
              <div className="att-pdf-icon"><Icon name="i-file" size="lg" /></div>
              <div className="att-pdf-meta">
                <div className="att-pdf-name" title={a.filename}>{a.filename}</div>
                <div className="att-pdf-size">
                  PDF · {fmtSize(a.sizeBytes)}{a.pages ? ` · ${a.pages} 页` : ''}
                </div>
                <ParsedBadge a={a} />
              </div>
            </a>
          )}
          {variant === 'preview' && onRemove && (
            <button
              type="button"
              className="att-remove"
              title="移除"
              onClick={() => onRemove(a.id)}
            >
              <Icon name="i-x" size="sm" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
