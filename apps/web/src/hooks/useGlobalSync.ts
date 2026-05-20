'use client';
import { useEffect, useRef } from 'react';

interface Handlers {
  // 任意会话有 CRUD 变化（创建/重命名/删除/某轮结束）→ 重拉列表
  onSessionsChanged?: (reason: string, sessionId?: string) => void;
  // 指定会话内容更新（一轮 turn 结束后落盘了新消息）→ 如果是当前会话就重拉消息
  onSessionUpdated?: (sessionId: string) => void;
}

/**
 * 订阅后端 /events 全局广播：CRUD + turn 完成事件全发到这。
 *
 * 移动端关键加固：
 *   1. visibilitychange：iOS 切回前台主动断开重连（onerror 在 iOS 上不总触发）
 *   2. 心跳超时：30s 没收到任何数据 → 主动重连（运营商代理静默断流场景）
 *   3. EventSource 自带重连作为兜底
 */
export function useGlobalSync(handlers: Handlers, opts?: { selfStreamingId?: string | null }) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const selfIdRef = useRef(opts?.selfStreamingId);
  selfIdRef.current = opts?.selfStreamingId;

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let lastEventAt = Date.now();
    let watchdog: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      es?.close();
      es = null;
      if (watchdog) { clearInterval(watchdog); watchdog = null; }
    };

    const touch = () => { lastEventAt = Date.now(); };

    const connect = () => {
      if (cancelled) return;
      cleanup();
      es = new EventSource('/api/events');
      lastEventAt = Date.now();

      // 后端心跳（: hb\n\n）会让 EventSource 触发底层数据，
      // 但 onmessage 不会因为注释行触发；改用 onopen + 自定义事件兜底刷新时间戳
      es.onopen = touch;

      // 任何具名事件到达都刷新心跳时间
      const listen = (name: string, handler: (e: MessageEvent) => void) => {
        es!.addEventListener(name, (ev) => { touch(); handler(ev as MessageEvent); });
      };

      listen('hello', () => { /* 连接确认 */ });

      listen('sessions:changed', (e) => {
        try {
          const data = JSON.parse(e.data);
          handlersRef.current.onSessionsChanged?.(data.reason, data.sessionId);
        } catch {/* ignore */}
      });

      listen('session:updated', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (selfIdRef.current && selfIdRef.current === data.sessionId) return;
          handlersRef.current.onSessionUpdated?.(data.sessionId);
        } catch {/* ignore */}
      });

      es.onerror = () => {
        cleanup();
        if (!cancelled) setTimeout(connect, 1500);
      };

      // 30s 没拿到任何事件 → 中间代理可能已经吃掉了连接，主动重连
      watchdog = setInterval(() => {
        if (Date.now() - lastEventAt > 30_000) {
          console.warn('[useGlobalSync] 30s 无数据，主动重连');
          cleanup();
          if (!cancelled) setTimeout(connect, 100);
        }
      }, 5_000);
    };

    // 切回前台 → 主动断重连。iOS Safari 后台时连接会被悄悄断，
    // 但 onerror 不一定触发，所以这里强制兜一遍
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        console.log('[useGlobalSync] 切回前台，重连');
        cleanup();
        if (!cancelled) setTimeout(connect, 100);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    connect();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      cleanup();
    };
  }, []);
}
