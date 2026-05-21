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
  /** 后端 budget 累计：本会话累计 USD（来自 turn:done.sessionUSD）+ 上限警告 */
  sessionUSD?: number;
  budgetWarn?: { scope: 'session' | 'day'; ratio: number } | null;
}

export type PlanStepStatus = 'pending' | 'running' | 'ok' | 'error';
export interface PlanStepNoticeItem {
  id: string;
  description: string;
  status: PlanStepStatus;
  durationMs?: number;
}

export interface ChatNotice {
  id: string;
  kind: 'critique' | 'review' | 'budget' | 'plan';
  /** 触发时间，前端可自动 5-10s 后淡出 */
  at: number;
  text: string;
  /** review:needed 才有：写了哪些文件 */
  files?: string[];
  /** plan:created 才有：步骤进度（V2 模式下会实时更新） */
  steps?: PlanStepNoticeItem[];
  /** plan notice 持续到所有 step 完成；不应被 autoDismiss 8s 干掉 */
  sticky?: boolean;
  /** plan:revised 触发后挂上：标识本计划经过过 re-plan，UI 上显示 ↻ 徽标 */
  revisedFrom?: string;        // 失败的 step id
  revisedReason?: string;
}

export interface UseChatState {
  bubbles: BubbleData[];
  busy: boolean;
  ctxUsage: CtxUsage;
  notices: ChatNotice[];
  dismissNotice: (id: string) => void;
  send: (text: string, opts?: { provider?: string; attachments?: Attachment[] }) => Promise<void>;
  stop: () => void;
  loadFromSession: (s: Session) => Promise<void>;
  reset: () => void;
}

let _bubbleSeq = 0;
const nextLocalId = () => `b-${++_bubbleSeq}-${Math.random().toString(36).slice(2, 6)}`;

export function useChat(sessionId: string | null): UseChatState {
  const [bubbles, setBubbles] = useState<BubbleData[]>([]);
  const [busy, setBusy] = useState(false);
  const [ctxUsage, setCtxUsage] = useState<CtxUsage>({
    lastInputTokens: 0, sessionTotalIn: 0, sessionTotalOut: 0,
    sessionUSD: 0, budgetWarn: null,
  });
  const [notices, setNotices] = useState<ChatNotice[]>([]);

  const pushNotice = useCallback((n: Omit<ChatNotice, 'id' | 'at'>) => {
    const id = `notice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setNotices((arr) => [...arr, { ...n, id, at: Date.now() }]);
  }, []);
  const dismissNotice = useCallback((id: string) => {
    setNotices((arr) => arr.filter((n) => n.id !== id));
  }, []);

  const esRef = useRef<EventSource | null>(null);
  const currentAssistantIdRef = useRef<string | null>(null);

  // 流式 token 批处理：用 rAF 把同一帧里到达的 chunk 合并成一次 setState，
  // 避免每个 token 都触发 React 重渲染（长回答时 setState 风暴会卡顿）。
  const pendingChunksRef = useRef<Map<string, string>>(new Map());
  const rafIdRef = useRef<number | null>(null);

  const flushPendingChunks = useCallback(() => {
    rafIdRef.current = null;
    const pending = pendingChunksRef.current;
    if (pending.size === 0) return;
    const snapshot = new Map(pending);
    pending.clear();
    setBubbles((arr) =>
      arr.map((b) => {
        if (!b._remoteId) return b;
        const add = snapshot.get(b._remoteId);
        return add ? { ...b, content: b.content + add } : b;
      }),
    );
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafIdRef.current !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      rafIdRef.current = requestAnimationFrame(flushPendingChunks);
    } else {
      rafIdRef.current = window.setTimeout(flushPendingChunks, 16) as unknown as number;
    }
  }, [flushPendingChunks]);

  const cancelScheduledFlush = useCallback(() => {
    if (rafIdRef.current === null) return;
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafIdRef.current);
    } else {
      clearTimeout(rafIdRef.current);
    }
    rafIdRef.current = null;
  }, []);

  const stop = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    // 关闭前把残留 chunk 一次性吐出去，避免最后一帧丢字
    if (pendingChunksRef.current.size > 0) {
      cancelScheduledFlush();
      flushPendingChunks();
    } else {
      cancelScheduledFlush();
    }
    setBusy(false);
    // 移除流式态
    setBubbles((arr) =>
      arr.map((b) => (b.streaming ? { ...b, streaming: false } : b)),
    );
  }, [cancelScheduledFlush, flushPendingChunks]);

  // 切会话时清空
  useEffect(() => {
    stop();
    setBubbles([]);
    setCtxUsage({
      lastInputTokens: 0, sessionTotalIn: 0, sessionTotalOut: 0,
      sessionUSD: 0, budgetWarn: null,
    });
    setNotices([]);
  }, [sessionId, stop]);

  // 组件卸载时取消挂起的 rAF
  useEffect(() => {
    return () => { cancelScheduledFlush(); };
  }, [cancelScheduledFlush]);

  const loadFromSession = useCallback(async (session: Session) => {
    const next: BubbleData[] = [];
    let ctx: CtxUsage = {
      lastInputTokens: 0, sessionTotalIn: 0, sessionTotalOut: 0,
      sessionUSD: 0, budgetWarn: null,
    };

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
    // 异步拉后端 BudgetGuard 累计 USD（重启进程后会丢，因为目前没持久化）
    try {
      const stats = await api.getSessionBudget(session.id);
      if (stats.totalUSD > 0) {
        setCtxUsage((u) => ({ ...u, sessionUSD: stats.totalUSD }));
      }
    } catch {/* ignore */}
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
      const prev = pendingChunksRef.current.get(remoteId) ?? '';
      pendingChunksRef.current.set(remoteId, prev + chunk);
      scheduleFlush();
    });

    es.addEventListener('message:end', (e) => {
      const { id: remoteId, content, usage } = JSON.parse((e as MessageEvent).data);
      // 拍下尚未落地的 chunk，跟 message:end 的最终 content 一起原子地落
      cancelScheduledFlush();
      pendingChunksRef.current.delete(remoteId);
      setBubbles((arr) =>
        arr.map((b) => (b._remoteId === remoteId ? { ...b, content: content || b.content, streaming: false } : b)),
      );
      if (usage) {
        setCtxUsage((u) => ({
          ...u,
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

    es.addEventListener('turn:done', (e) => {
      // 后端 turn:done payload 现在带 turnUSD / sessionUSD，更新 ctxUsage
      try {
        const data = JSON.parse((e as MessageEvent).data) as { sessionUSD?: number };
        if (typeof data.sessionUSD === 'number') {
          setCtxUsage((u) => ({ ...u, sessionUSD: data.sessionUSD }));
        }
      } catch {/* ignore */}
      stop();
    });

    es.addEventListener('budget:warn', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          scope: 'session' | 'day'; usd: number; cap: number; ratio: number;
        };
        setCtxUsage((u) => ({ ...u, budgetWarn: { scope: data.scope, ratio: data.ratio } }));
        pushNotice({
          kind: 'budget',
          text: `${data.scope === 'session' ? '本会话' : '当日'}花费已达 $${data.usd.toFixed(3)} / $${data.cap.toFixed(2)} (${Math.round(data.ratio * 100)}%)`,
        });
      } catch {/* ignore */}
    });

    es.addEventListener('review:needed', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { files: string[] };
        pushNotice({
          kind: 'review',
          text: `本轮写了 ${data.files.length} 个代码文件，建议人工/Reviewer 审查`,
          files: data.files,
        });
      } catch {/* ignore */}
    });

    es.addEventListener('critique:revise', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { critique: string };
        pushNotice({
          kind: 'critique',
          text: `自检发现需要修订：${data.critique.replace(/^REVISE:\s*/, '').slice(0, 80)}…`,
        });
      } catch {/* ignore */}
    });

    es.addEventListener('plan:created', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          plan: { steps: Array<{ id: string; description: string }> };
        };
        pushNotice({
          kind: 'plan',
          text: `Planner 拆了 ${data.plan.steps.length} 步，开始执行…`,
          steps: data.plan.steps.map((s) => ({ ...s, status: 'pending' as const })),
          sticky: true,
        });
      } catch {/* ignore */}
    });

    es.addEventListener('plan:step:start', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { stepId: string };
        setNotices((arr) => arr.map((n) => {
          if (n.kind !== 'plan' || !n.steps) return n;
          return {
            ...n,
            steps: n.steps.map((s) => s.id === data.stepId ? { ...s, status: 'running' as const } : s),
          };
        }));
      } catch {/* ignore */}
    });

    es.addEventListener('plan:revised', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          failedStepId: string;
          reason: string;
          newSteps: Array<{ id: string; description: string }>;
        };
        setNotices((arr) => arr.map((n) => {
          if (n.kind !== 'plan' || !n.steps) return n;
          // 保留已完成的 step + 拼上新的 step
          const completed = n.steps.filter((s) => s.status === 'ok' || s.status === 'error');
          const failedAt = n.steps.find((s) => s.id === data.failedStepId);
          const newSteps: PlanStepNoticeItem[] = data.newSteps.map((s) => ({
            ...s, status: 'pending' as const,
          }));
          return {
            ...n,
            text: `Planner 修订：${data.reason.slice(0, 60)}${data.reason.length > 60 ? '…' : ''}`,
            steps: [
              ...completed.map((s) => s.id === data.failedStepId ? { ...s, status: 'error' as const } : s),
              ...(failedAt && !completed.some((c) => c.id === failedAt.id) ? [{ ...failedAt, status: 'error' as const }] : []),
              ...newSteps,
            ],
            sticky: true,
            revisedFrom: data.failedStepId,
            revisedReason: data.reason,
          };
        }));
      } catch {/* ignore */}
    });

    es.addEventListener('plan:step:end', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { stepId: string; ok: boolean; durationMs?: number };
        setNotices((arr) => arr.map((n) => {
          if (n.kind !== 'plan' || !n.steps) return n;
          const steps = n.steps.map((s) => s.id === data.stepId
            ? { ...s, status: (data.ok ? 'ok' : 'error') as PlanStepStatus, durationMs: data.durationMs }
            : s);
          // 所有步骤都结束 → 取消 sticky，让通知 8s 后淡出
          const allDone = steps.every((s) => s.status === 'ok' || s.status === 'error');
          const okCount = steps.filter((s) => s.status === 'ok').length;
          return {
            ...n,
            steps,
            sticky: !allDone,
            text: allDone ? `计划完成：${okCount}/${steps.length} 步成功` : n.text,
          };
        }));
      } catch {/* ignore */}
    });
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

  return { bubbles, busy, ctxUsage, notices, dismissNotice, send, stop, loadFromSession, reset };
}
