'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { Composer } from '@/components/Composer';
import { EmptyState } from '@/components/EmptyState';
import { MessageBubble } from '@/components/MessageBubble';
import { ToastModalHost, showConfirm, showToast } from '@/components/ToastModalHost';
import { ChatNotices } from '@/components/ChatNotices';
import { PendingApprovalPanel } from '@/components/PendingApprovalPanel';
import { QrFab } from '@/components/QrFab';
import { CommandPalette } from '@/components/CommandPalette';
import { DebugPanel } from '@/components/DebugPanel';
import { useChat } from '@/hooks/useChat';
import { useGlobalSync } from '@/hooks/useGlobalSync';
import { useAttachments } from '@/hooks/useAttachments';
import { useKeyboardAware } from '@/hooks/useKeyboardAware';
import { exportSessionToMarkdown, downloadMarkdown, copyToClipboard } from '@/lib/exportSession';
import * as api from '@/lib/api';
import type { SessionSummary, Session } from '@/lib/types';

export default function ChatPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [defaultProvider, setDefaultProvider] = useState('mock');
  const [defaultModel, setDefaultModel] = useState<string>('');
  const [serverContextWindow, setServerContextWindow] = useState<number | undefined>(undefined);
  const [providerOverride, setProviderOverride] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [input, setInput] = useState('');
  const [focusToken, setFocusToken] = useState(0);
  const focusInput = useCallback(() => setFocusToken((t) => t + 1), []);
  const [cmdkOpen, setCmdkOpen] = useState(false);

  const chat = useChat(currentId);
  const attach = useAttachments();
  const messagesRef = useRef<HTMLDivElement | null>(null);
  useKeyboardAware();

  // ───── Boot ─────
  useEffect(() => {
    api.getHealth().then((h) => {
      if (h?.provider) setDefaultProvider(h.provider);
      if (h?.model) setDefaultModel(h.model);
      if (typeof h?.contextWindow === 'number') setServerContextWindow(h.contextWindow);
    }).catch(() => {});
    refreshSessions().then((list) => {
      if (list.length) loadSession(list[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切窗口宽度时自动收起抽屉
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth > 720) setDrawerOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 全局快捷键：Cmd+N 新建 / Cmd+K 命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        newSession();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCmdkOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 滚动行为：贴底就 follow，用户上滚就尊重他
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setPinnedToBottom(distance < 80);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [currentId]);
  // 每次有新 token / 新消息时：贴底才滚（不再强行打扰用户）
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    if (pinnedToBottom) el.scrollTop = el.scrollHeight;
  }, [chat.bubbles, pinnedToBottom]);
  const scrollToBottom = () => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // ───── Actions ─────
  const refreshSessions = useCallback(async () => {
    const list = await api.listSessions();
    setSessions(list);
    return list;
  }, []);

  const loadSession = useCallback(async (id: string) => {
    setCurrentId(id);
    setDrawerOpen(false);
    const s = await api.getSession(id);
    setCurrentSession(s);
    chat.loadFromSession(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newSession = useCallback(async () => {
    const s = await api.createSession();
    await refreshSessions();
    await loadSession(s.id);
    focusInput();   // 新建会话直接定位到输入框，省一次点击
  }, [refreshSessions, loadSession, focusInput]);

  const onDelete = useCallback(async (s: SessionSummary) => {
    const ok = await showConfirm({
      title: '删除对话',
      message: `「${s.title}」中的全部消息将被永久删除，无法恢复。`,
      confirmText: '删除', cancelText: '取消', danger: true,
    });
    if (!ok) return;
    await api.deleteSession(s.id);
    if (currentId === s.id) {
      setCurrentId(null);
      setCurrentSession(null);
    }
    const list = await refreshSessions();
    if (currentId === s.id && list.length) loadSession(list[0].id);
    showToast('对话已删除', { type: 'success', duration: 2400 });
  }, [currentId, refreshSessions, loadSession]);

  const onRename = useCallback(async (id: string, title: string) => {
    await api.renameSession(id, title);
    await refreshSessions();
    if (currentId === id) {
      const s = await api.getSession(id);
      setCurrentSession(s);
    }
  }, [currentId, refreshSessions]);

  // ───── 跨设备同步：监听后端全局事件，命中当前会话就静默重拉 ─────
  const reloadCurrent = useCallback(async () => {
    if (!currentId) return;
    const s = await api.getSession(currentId);
    setCurrentSession(s);
    chat.loadFromSession(s);
  }, [currentId, chat]);

  // 导出当前会话为 markdown 文件
  const exportCurrent = useCallback(async () => {
    if (!currentId) { showToast('先选一个会话', { type: 'warn' }); return; }
    const s = await api.getSession(currentId);
    const md = exportSessionToMarkdown(s);
    const safeTitle = (s.title || 'session').replace(/[\\/:*?"<>|]/g, '_');
    downloadMarkdown(md, `${safeTitle}.md`);
    showToast('已下载 .md 文件', { type: 'success', duration: 2400 });
  }, [currentId]);

  // 复制当前会话全文到剪贴板
  const copyCurrent = useCallback(async () => {
    if (!currentId) { showToast('先选一个会话', { type: 'warn' }); return; }
    const s = await api.getSession(currentId);
    const md = exportSessionToMarkdown(s);
    const ok = await copyToClipboard(md);
    showToast(ok ? '会话已复制到剪贴板' : '复制失败', { type: ok ? 'success' : 'error', duration: 2400 });
  }, [currentId]);

  // 重生：找到最后一条 user 消息 → 截断（含 user）→ 重发同样内容
  const regenerate = useCallback(async () => {
    if (!currentId || chat.busy) return;
    try {
      const s = await api.getSession(currentId);
      let lastUserIdx = -1;
      for (let i = s.messages.length - 1; i >= 0; i--) {
        if (s.messages[i].role === 'user') { lastUserIdx = i; break; }
      }
      if (lastUserIdx < 0) {
        showToast('找不到要重生的用户消息', { type: 'warn' });
        return;
      }
      const userMsg = s.messages[lastUserIdx];
      const text = userMsg.content || '';
      const attachments = userMsg.attachments || [];
      await api.truncateMessages(currentId, lastUserIdx);
      const fresh = await api.getSession(currentId);
      setCurrentSession(fresh);
      chat.loadFromSession(fresh);
      await chat.send(text, { provider: providerOverride || undefined, attachments });
      refreshSessions();
    } catch (err) {
      showToast(`重生失败：${(err as Error).message}`, { type: 'error', duration: 4000 });
    }
  }, [currentId, chat, providerOverride, refreshSessions]);

  useGlobalSync(
    {
      onSessionsChanged: () => { refreshSessions(); },
      onSessionUpdated: (sid) => { if (sid === currentId) reloadCurrent(); },
    },
    // 自己正在流式的那条不让广播覆盖（自己的状态领先于服务端落盘）
    { selfStreamingId: chat.busy ? currentId : null },
  );

  const send = useCallback(async () => {
    const text = input;
    if (!text.trim() && attach.items.length === 0) return;

    let sid = currentId;
    if (!sid) {
      const s = await api.createSession();
      sid = s.id;
      setCurrentId(sid);
      setCurrentSession({ ...s, messages: [] });
      await refreshSessions();
    }
    setInput('');
    const sending = [...attach.items];
    attach.clear();
    await chat.send(text, { provider: providerOverride || undefined, attachments: sending });
    refreshSessions();
  }, [input, currentId, providerOverride, chat, refreshSessions, attach]);

  const effectiveProvider = providerOverride || defaultProvider;

  return (
    <>
      <div id="app">
        <div
          id="sidebarBackdrop"
          className={'sidebar-backdrop' + (drawerOpen ? ' show' : '')}
          onClick={() => setDrawerOpen(false)}
          aria-hidden={!drawerOpen}
        />

        <Sidebar
          sessions={sessions}
          currentId={currentId}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onSelect={loadSession}
          onNew={newSession}
          onRename={onRename}
          onDelete={onDelete}
        />

        <main id="main">
          <Topbar
            title={currentSession?.title || '选择或新建对话'}
            canRename={!!currentId}
            onRename={(t) => currentId && onRename(currentId, t)}
            provider={providerOverride}
            effectiveProvider={effectiveProvider}
            defaultProvider={defaultProvider}
            defaultModel={defaultModel}
            serverContextWindow={serverContextWindow}
            onProviderChange={setProviderOverride}
            ctxUsage={chat.ctxUsage}
            onMenu={() => setDrawerOpen(true)}
            onNew={newSession}
          />

          <div id="messages" className="messages" ref={messagesRef}>
            {chat.bubbles.length === 0 ? (
              <EmptyState onPick={(t) => { setInput(t); focusInput(); }} />
            ) : (
              (() => {
                // 标记最后一条非流式 assistant 为「最新」—— 只它显示重生按钮
                let latestAssistantId: string | null = null;
                for (let i = chat.bubbles.length - 1; i >= 0; i--) {
                  const b = chat.bubbles[i];
                  if (b.role === 'assistant' && !b.streaming) {
                    latestAssistantId = b.id; break;
                  }
                }
                return chat.bubbles.map((b) => (
                  <MessageBubble
                    key={b.id}
                    data={{ ...b, isLatestAssistant: b.id === latestAssistantId }}
                    onRegenerate={b.id === latestAssistantId ? regenerate : undefined}
                  />
                ));
              })()
            )}
          </div>
          {/* 用户上滚时浮一个「回到底部」按钮，PC + 移动通用 */}
          {!pinnedToBottom && chat.bubbles.length > 0 && (
            <button
              type="button"
              className="scroll-to-bottom"
              onClick={scrollToBottom}
              aria-label="回到底部"
              title="回到底部"
            >
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <polyline points="19 12 12 19 5 12" />
              </svg>
            </button>
          )}

          <Composer
            value={input}
            onChange={setInput}
            onSend={send}
            onStop={chat.stop}
            busy={chat.busy}
            attachments={attach.items}
            uploading={attach.uploading}
            onAddFiles={attach.addFiles}
            onRemoveAttachment={attach.remove}
            focusToken={focusToken}
          />
        </main>
      </div>

      <QrFab />
      <CommandPalette
        open={cmdkOpen}
        onClose={() => setCmdkOpen(false)}
        sessions={sessions}
        currentId={currentId}
        onSelectSession={loadSession}
        onNewSession={newSession}
        onDeleteSession={onDelete}
        onSetProvider={setProviderOverride}
        effectiveProvider={effectiveProvider}
        onExportCurrent={currentId ? exportCurrent : undefined}
        onCopyCurrent={currentId ? copyCurrent : undefined}
      />
      <DebugPanel />
      <ToastModalHost />
      <ChatNotices notices={chat.notices} onDismiss={chat.dismissNotice} />
      <PendingApprovalPanel pending={chat.pendingApproval} onAnswer={chat.answerPermission} />
    </>
  );
}
