'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { Composer } from '@/components/Composer';
import { EmptyState } from '@/components/EmptyState';
import { MessageBubble } from '@/components/MessageBubble';
import { ToastModalHost, showConfirm, showToast } from '@/components/ToastModalHost';
import { QrFab } from '@/components/QrFab';
import { useChat } from '@/hooks/useChat';
import { useGlobalSync } from '@/hooks/useGlobalSync';
import { useAttachments } from '@/hooks/useAttachments';
import * as api from '@/lib/api';
import type { SessionSummary, Session } from '@/lib/types';

export default function ChatPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [defaultProvider, setDefaultProvider] = useState('mock');
  const [providerOverride, setProviderOverride] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [input, setInput] = useState('');

  const chat = useChat(currentId);
  const attach = useAttachments();
  const messagesRef = useRef<HTMLDivElement | null>(null);

  // ───── Boot ─────
  useEffect(() => {
    api.getHealth().then((h) => {
      if (h?.provider) setDefaultProvider(h.provider);
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

  // Cmd/Ctrl+N 新建会话
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        newSession();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动滚到底
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (near || chat.bubbles.at(-1)?.streaming) el.scrollTop = el.scrollHeight;
  }, [chat.bubbles]);

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
  }, [refreshSessions, loadSession]);

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
            onProviderChange={setProviderOverride}
            ctxUsage={chat.ctxUsage}
            onMenu={() => setDrawerOpen(true)}
          />

          <div id="messages" className="messages" ref={messagesRef}>
            {chat.bubbles.length === 0 ? (
              <EmptyState onPick={(t) => setInput(t)} />
            ) : (
              chat.bubbles.map((b) => <MessageBubble key={b.id} data={b} />)
            )}
          </div>

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
          />
        </main>
      </div>

      <QrFab />
      <ToastModalHost />
    </>
  );
}
