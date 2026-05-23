'use client';
import { memo, useState } from 'react';
import { Icon, type IconName } from './IconSprite';
import { compactJsonOneLine, prettyJson } from '@/lib/markdown';

const ICON_FOR_TOOL: Record<string, IconName> = {
  calculator: 'i-calc',
  web_search: 'i-search',
  file_system_read: 'i-file',
  file_system_write: 'i-file',
  code_execute: 'i-wrench',
};

export interface ToolEntry {
  toolCallId: string;
  name: string;
  input: unknown;
  status: 'running' | 'ok' | 'error';
  output?: unknown;
  /** code_execute 沙箱 matplotlib 出的图（base64，不含 data: 前缀） */
  images?: string[];
}

export const ToolBlock = memo(ToolBlockImpl, (prev, next) =>
  prev.entry === next.entry
  || (prev.entry.toolCallId === next.entry.toolCallId
      && prev.entry.status === next.entry.status
      && prev.entry.output === next.entry.output
      && prev.entry.images === next.entry.images)
);

function ToolBlockImpl({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const isDelegate = entry.name.startsWith('delegate_to_');
  const iconId: IconName = isDelegate ? 'i-bot' : (ICON_FOR_TOOL[entry.name] || 'i-wrench');
  const statusText = entry.status === 'running' ? '运行中'
    : entry.status === 'ok' ? '完成' : '失败';
  const hasImages = entry.name === 'code_execute' && !!entry.images && entry.images.length > 0;

  return (
    <div className={'tool-block' + (isDelegate ? ' delegate' : '') + (open ? ' open' : '')}>
      <div className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="ticon"><Icon name={iconId} size="sm" /></span>
        <span className="tname">{entry.name}</span>
        <span className="targ">{compactJsonOneLine(entry.input)}</span>
        {hasImages && (
          <span className="tstatus ok" style={{ marginRight: 6 }}>
            {entry.images!.length} 图
          </span>
        )}
        <span className={'tstatus ' + entry.status}>{statusText}</span>
        <span className="tcaret"><Icon name="i-chev-right" size="sm" /></span>
      </div>
      <div className="tool-body">
        <div className="label">Input</div>
        <pre>{prettyJson(entry.input)}</pre>
        <div className="label">Output</div>
        <pre className="output">
          {entry.output !== undefined ? prettyJson(entry.output) : '(等待中)'}
        </pre>
        {hasImages && (
          <>
            <div className="label">Images</div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                marginTop: 4,
              }}
            >
              {entry.images!.map((b64, i) => (
                <img
                  key={i}
                  src={`data:image/png;base64,${b64}`}
                  alt={`code_execute output ${i + 1}`}
                  style={{
                    maxWidth: '100%',
                    height: 'auto',
                    borderRadius: 8,
                    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                    background: '#fff',
                  }}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
