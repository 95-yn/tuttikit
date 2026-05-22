'use client';
import { useEffect, useState, type ReactElement } from 'react';
import type { PendingApprovalUI } from '@/hooks/useChat';

interface Props {
  pending: PendingApprovalUI | null;
  onAnswer: (allow: boolean) => void | Promise<void>;
}

/**
 * 顶部强提示条：在 LLM 调危险但灰色操作时弹出，等用户 Approve/Deny。
 * 设计：
 *   - 黄色边框 + 半透明黄底 → 比 safety:denied 红色弱、比一般通知强
 *   - 倒计时显示剩余秒数，到 0 时后端自动 deny（permission:resolved → 自动清空）
 *   - Approve 按钮主调（accent），Deny 灰色，键盘 Enter 触发 Deny（安全默认）
 */
export function PendingApprovalPanel({ pending, onAnswer }: Props): ReactElement | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [pending]);

  // 新 pending 出现时，如果页面不可见就发桌面通知（用户在别的 tab 也能看见）
  useEffect(() => {
    if (!pending) return;
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    const fire = (): void => {
      if (document.visibilityState === 'visible') return;
      try {
        new Notification('TuttiKit 等待你的审批', {
          body: `${pending.toolName} 触发了 ${pending.rule}`,
          tag: `approval-${pending.requestId}`,
          requireInteraction: false,
        });
      } catch {/* 浏览器拦截就算了 */}
    };
    if (Notification.permission === 'granted') {
      fire();
    } else if (Notification.permission !== 'denied') {
      // 用户没显式拒绝过 → 请求一次，授权后立即推送
      Notification.requestPermission().then((p) => { if (p === 'granted') fire(); }).catch(() => {/* ignore */});
    }
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void onAnswer(true);             // Cmd/Ctrl+Enter = Approve（要按修饰键，避免误触）
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void onAnswer(false);            // Esc = Deny（安全默认）
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pending, onAnswer]);

  if (!pending) return null;

  const elapsed = now - pending.createdAt;
  const remaining = Math.max(0, Math.ceil((pending.timeoutMs - elapsed) / 1000));
  const inputPreview = JSON.stringify(pending.input).slice(0, 240);

  return (
    <div className="approval-panel" role="alertdialog" aria-modal="false" aria-labelledby="approval-title">
      <div className="approval-head">
        <span className="approval-icon">⚠️</span>
        <span id="approval-title" className="approval-title">
          需要你确认：<code>{pending.toolName}</code> 触发了 <code>{pending.rule}</code>
        </span>
        <span className="approval-timer" title="超时自动拒绝">
          {remaining}s
        </span>
      </div>
      <div className="approval-reason">{pending.reason}</div>
      <details className="approval-details">
        <summary>查看 LLM 提供的 tool input</summary>
        <pre className="approval-input">{inputPreview}{inputPreview.length >= 240 ? '…' : ''}</pre>
      </details>
      <div className="approval-actions">
        <button
          type="button"
          className="approval-btn approval-btn-deny"
          onClick={() => void onAnswer(false)}
        >
          拒绝 (Esc)
        </button>
        <button
          type="button"
          className="approval-btn approval-btn-allow"
          onClick={() => void onAnswer(true)}
        >
          允许 (⌘/Ctrl+Enter)
        </button>
      </div>
    </div>
  );
}
