'use client';
import { useState } from 'react';
import { Icon, type IconName } from './IconSprite';
import { compactJsonOneLine, prettyJson } from '@/lib/markdown';

const ICON_FOR_TOOL: Record<string, IconName> = {
  calculator: 'i-calc',
  web_search: 'i-search',
  file_system_read: 'i-file',
  file_system_write: 'i-file',
};

export interface ToolEntry {
  toolCallId: string;
  name: string;
  input: unknown;
  status: 'running' | 'ok' | 'error';
  output?: unknown;
}

export function ToolBlock({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const isDelegate = entry.name.startsWith('delegate_to_');
  const iconId: IconName = isDelegate ? 'i-bot' : (ICON_FOR_TOOL[entry.name] || 'i-wrench');
  const statusText = entry.status === 'running' ? '运行中'
    : entry.status === 'ok' ? '完成' : '失败';

  return (
    <div className={'tool-block' + (isDelegate ? ' delegate' : '') + (open ? ' open' : '')}>
      <div className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="ticon"><Icon name={iconId} size="sm" /></span>
        <span className="tname">{entry.name}</span>
        <span className="targ">{compactJsonOneLine(entry.input)}</span>
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
      </div>
    </div>
  );
}
