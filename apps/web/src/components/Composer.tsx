'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './IconSprite';
import { AttachmentList } from './AttachmentList';
import { SlashMenu, buildSlashItems, type SlashItem } from './SlashMenu';
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
  /** 父组件每次递增就让输入框 focus 一次（新建会话 / 点示例时用）*/
  focusToken?: number;
}

const ACCEPT = 'image/png,image/jpeg,image/jpg,image/webp,image/gif,image/heic,image/heif,application/pdf';

export function Composer({
  value, onChange, onSend, onStop, busy,
  attachments, uploading, onAddFiles, onRemoveAttachment,
  focusToken = 0,
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // 用户拖拽手柄调整 textarea 高度 —— 拖完写到 state 持久这次会话
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  const voice = useVoiceInput({ value, setValue: onChange });

  // ───── Slash 命令面板 ─────
  // value 以 '/' 开头且没有空格时才打开（用户开始打 query）；按空格/选完自动关。
  const slashMatch = useMemo(() => {
    const m = value.match(/^\/([^\s\n]*)/);
    return m ? { query: m[1] } : null;
  }, [value]);
  const [slashItems, setSlashItems] = useState<SlashItem[]>([]);
  const [slashActive, setSlashActive] = useState(0);
  const [slashLoaded, setSlashLoaded] = useState(false);

  // 首次打开 slash 时拉一次 skills + mcp 列表，缓存住
  useEffect(() => {
    if (!slashMatch || slashLoaded) return;
    setSlashLoaded(true);
    void Promise.all([
      fetch('/api/skills').then((r) => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/mcp').then((r) => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/skills/translated-names?lang=zh').then((r) => r.ok ? r.json() : null).catch(() => null),
    ]).then(async ([skills, servers, zhIdx]) => {
      // 每个 connected server 再拉 tools
      const serverTools = await Promise.all(
        (servers as Array<{ name: string; state: string }>).map(async (s) => {
          if (s.state !== 'connected') return [] as Array<{ name: string; description?: string }>;
          try {
            const d = await fetch(`/api/mcp/${encodeURIComponent(s.name)}`).then((r) => r.json());
            return (d.tools ?? []) as Array<{ name: string; description?: string }>;
          } catch { return [] as Array<{ name: string; description?: string }>; }
        }),
      );
      setSlashItems(buildSlashItems({
        skills: skills as Array<{ name: string; description: string; scope: string }>,
        mcpTools: serverTools.flat(),
        zhSkillNames: (zhIdx as { names?: Record<string, string> } | null)?.names,
      }));
    });
  }, [slashMatch, slashLoaded]);

  // 当前过滤后的列表长度（给键盘用，包一份在闭包里）
  const slashFiltered = useMemo(() => {
    if (!slashMatch) return [] as SlashItem[];
    const q = slashMatch.query.toLowerCase().trim();
    if (!q) return slashItems;
    const terms = q.split(/\s+/).filter(Boolean);
    return slashItems.filter((it) => terms.every((t) => it.keywords.toLowerCase().includes(t)));
  }, [slashMatch, slashItems]);

  function selectSlash(it: SlashItem): void {
    // value 形如 "/tdd 还有其他文字"；替换前缀 /<query>（不带空格那段）
    const rest = value.replace(/^\/[^\s\n]*/, '');
    const tpl = it.insertText;
    const [before, after] = tpl.includes('{cursor}')
      ? tpl.split('{cursor}', 2) as [string, string]
      : [tpl, ''];
    const next = before + after + rest;
    onChange(next);
    // 光标停留位置
    const caret = before.length;
    requestAnimationFrame(() => {
      const ta = ref.current;
      if (!ta) return;
      ta.focus();
      try { ta.setSelectionRange(caret, caret); } catch { /* ignore */ }
    });
  }

  function closeSlash(): void {
    // 关掉只在 value 仍是 /-prefix 时清掉（用户按 Esc）；否则 do nothing
    if (slashMatch) onChange(value.replace(/^\/[^\s\n]*\s?/, ''));
  }

  // 父组件每次递增 focusToken，输入框就 focus 一次
  useEffect(() => {
    if (focusToken > 0) ref.current?.focus();
  }, [focusToken]);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    if (manualHeight != null) {
      ta.style.height = manualHeight + 'px';
    } else {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }
  }, [value, manualHeight]);

  // 拖拽手柄：垂直拖动调整 textarea 高度。范围 [60, 600]
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const ta = ref.current; if (!ta) return;
    const startY = e.clientY;
    const startH = ta.getBoundingClientRect().height;
    const onMove = (mv: PointerEvent) => {
      const next = Math.min(600, Math.max(60, startH + (startY - mv.clientY)));
      setManualHeight(next);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };
  const resetHeight = () => setManualHeight(null);

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
      {/* 顶部拖拽手柄：上下拖动调整输入框高度，双击重置 */}
      <div
        className="composer-resize-handle"
        onPointerDown={startResize}
        onDoubleClick={resetHeight}
        title="拖动调整输入框高度，双击重置"
        aria-label="调整输入框高度"
      />
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
        <SlashMenu
          open={!!slashMatch && slashFiltered.length >= 0}
          query={slashMatch?.query ?? ''}
          items={slashItems}
          activeIdx={slashActive}
          setActiveIdx={setSlashActive}
          onSelect={selectSlash}
          onClose={closeSlash}
        />
        <textarea
          ref={ref}
          id="input"
          rows={1}
          placeholder={voice.listening ? '正在听... (再次点击停止)'
            : uploading > 0 ? `上传中 (${uploading})…`
            : '发送消息...（输入 / 选 skill 或 MCP）'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            // Slash menu 打开时拦截键盘
            if (slashMatch) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSlashActive(Math.min(slashFiltered.length - 1, slashActive + 1));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSlashActive(Math.max(0, slashActive - 1));
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const it = slashFiltered[slashActive];
                if (it) selectSlash(it);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                closeSlash();
                return;
              }
            }
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
