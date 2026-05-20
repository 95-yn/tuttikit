'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '@/lib/api';
import type { Attachment, Session } from '@/lib/types';
import type { BubbleData } from '@/components/MessageBubble';
import type { ToolEntry } from '@/components/ToolBlock';

export interface CtxUsage {
  lastInputTokens: number;
  sessionTotalIn: number;
  sessionTotalOut: number;
}

export interface UseChatState {
  bubbles: BubbleData[];
  busy: boolean;
  ctxUsage: CtxUsage;
  send: (text: string, opts?: { provider?: string; attachments?: Attachment[] }) => Promise<void>;
  stop: () => void;
  loadFromSession: (s: Session) => void;
  reset: () => void;
}

let _bubbleSeq = 0;
const nextLocalId = () => `b-${++_bubbleSeq}-${Math.random().toString(36).slice(2, 6)}`;

export function useChat(sessionId: string | null): UseChatState {
  const [bubbles, setBubbles] = useState<BubbleData[]>([]);
  const [busy, setBusy] = useState(false);
  const [ctxUsage, setCtxUsage] = useState<CtxUsage>({
    lastInputTokens: 0, sessionTotalIn: 0, sessionTotalOut: 0,
  });

  const esRef = useRef<EventSource | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setBusy(false);
    // 移除流式态
    setBubbles((arr) =>
      arr.map((b) => (b.streaming ? { ...b, streaming: false } : b)),
    );
  }, []);

  // 切会话时清空
  useEffect(() => {
    stop();
    setBubbles([]);
    setCtxUsage({ lastInputTokens: 0, sessionTotalIn: 0, sessionTotalOut: 0 });
  }, [sessionId, stop]);

  const loadFromSession = useCallback((session: Session) => {
    const next: BubbleData[] = [];
    let ctx: CtxUsage = { lastInputTokens: 0, sessionTotalIn: 0, sessionTotalOut: 0 };

    for (const m of session.messages) {
      if (m.role === 'user') {
        next.push({
          id: nextLocalId(), role: 'user',
          content: m.content || '', createdAt: m.meta?.createdAt,
          attachments: m.attachments,
        });
      } else if (m.role === 'assistant') {
        if (m.meta?.usage) {
          ctx.lastInputTokens = Math.max(ctx.lastInputTokens, m.meta.usage.inputTokens || 0);
          ctx.sessionTotalIn  += m.meta.usage.inputTokens  || 0;
          ctx.sessionTotalOut += m.meta.usage.outputTokens || 0;
        }
        const tools: ToolEntry[] = (m.toolCalls || []).map((tc) => ({
          toolCallId: tc.id, name: tc.name, input: tc.input,
          status: 'ok' as const, output: undefined,
        }));
        next.push({
          id: nextLocalId(), role: 'assistant',
          content: m.content || '', createdAt: m.meta?.createdAt,
          tools,
        });
      } else if (m.role === 'tool') {
        // 把 tool 输出回填到最近一条 assistant 的对应 toolCall
        const lastAssistant = [...next].reverse().find((b) => b.role === 'assistant');
        if (!lastAssistant?.tools) continue;
        const t = lastAssistant.tools.find((x) => x.toolCallId === m.toolCallId);
        if (t) {
          let parsed: unknown;
          try { parsed = JSON.parse(m.content || ''); } catch { parsed = m.content; }
          const errLike = parsed && typeof parsed === 'object' && 'error' in (parsed as object);
          t.status = errLike ? 'error' : 'ok';
          t.output = parsed;
        }
      }
    }
    setBubbles(next);
    setCtxUsage(ctx);
  }, []);

  const reset = useCallback(() => {
    stop();
    setBubbles([]);
  }, [stop]);

  const send = useCallback(async (
    text: string,
    opts?: { provider?: string; attachments?: Attachment[] },
  ) => {
    if (!sessionId || busy) return;
    const attachments = opts?.attachments ?? [];
    if (!text.trim() && attachments.length === 0) return;

    // 立即追加 user 气泡
    setBubbles((arr) => [
      ...arr,
      {
        id: nextLocalId(), role: 'user', content: text,
        createdAt: new Date().toISOString(),
        attachments: attachments.length ? attachments : undefined,
      },
    ]);
    setBusy(true);

    const es = new EventSource(api.streamUrl(
      sessionId, text, opts?.provider, attachments.map((a) => a.id),
    ));
    esRef.current = es;

    es.addEventListener('message:start', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      const id = nextLocalId();
      currentAssistantIdRef.current = id;
      setBubbles((arr) => [
        ...arr,
        {
          id, role: 'assistant', content: '', streaming: true,
          createdAt: new Date().toISOString(),
          tools: [],
          _remoteId: data.id,
        },
      ]);
    });

    es.addEventListener('message:token', (e) => {
      const { id: remoteId, chunk } = JSON.parse((e as MessageEvent).data);
      setBubbles((arr) =>
        arr.map((b) => (b._remoteId === remoteId ? { ...b, content: b.content + chunk } : b)),
      );
    });

    es.addEventListener('message:end', (e) => {
      const { id: remoteId, content, usage } = JSON.parse((e as MessageEvent).data);
      setBubbles((arr) =>
        arr.map((b) => (b._remoteId === remoteId ? { ...b, content: content || b.content, streaming: false } : b)),
      );
      if (usage) {
        setCtxUsage((u) => ({
          lastInputTokens: Math.max(u.lastInputTokens, usage.inputTokens || 0),
          sessionTotalIn: u.sessionTotalIn + (usage.inputTokens || 0),
          sessionTotalOut: u.sessionTotalOut + (usage.outputTokens || 0),
        }));
      }
    });

    es.addEventListener('tool:start', (e) => {
      const { toolCallId, name, input } = JSON.parse((e as MessageEvent).data);
      setBubbles((arr) => {
        // 找到最近一条 assistant
        const idx = [...arr].map((b, i) => ({ b, i })).reverse().find((x) => x.b.role === 'assistant')?.i;
        if (idx === undefined) return arr;
        const target = arr[idx];
        const tools = [...(target.tools || []), {
          toolCallId, name, input, status: 'running' as const,
        }];
        const updated = { ...target, tools };
        return arr.map((b, i) => (i === idx ? updated : b));
      });
    });

    es.addEventListener('tool:end', (e) => {
      const { toolCallId, result } = JSON.parse((e as MessageEvent).data);
      setBubbles((arr) =>
        arr.map((b) => {
          if (!b.tools?.some((t) => t.toolCallId === toolCallId)) return b;
          return {
            ...b,
            tools: b.tools.map((t) =>
              t.toolCallId === toolCallId ? { ...t, status: 'ok', output: result } : t,
            ),
          };
        }),
      );
    });

    es.addEventListener('tool:error', (e) => {
      const { toolCallId, error } = JSON.parse((e as MessageEvent).data);
      setBubbles((arr) =>
        arr.map((b) => {
          if (!b.tools?.some((t) => t.toolCallId === toolCallId)) return b;
          return {
            ...b,
            tools: b.tools.map((t) =>
              t.toolCallId === toolCallId ? { ...t, status: 'error', output: { error } } : t,
            ),
          };
        }),
      );
    });

    es.addEventListener('turn:done', () => { stop(); });
    es.addEventListener('turn:error', (e) => {
      const { error } = JSON.parse((e as MessageEvent).data);
      setBubbles((arr) => [
        ...arr,
        { id: nextLocalId(), role: 'error', content: error },
      ]);
      stop();
    });
    es.onerror = () => stop();
  }, [sessionId, busy, stop]);

  return { bubbles, busy, ctxUsage, send, stop, loadFromSession, reset };
}
