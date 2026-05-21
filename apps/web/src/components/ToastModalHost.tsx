'use client';
import { useEffect, useState, useCallback } from 'react';
import { Icon, type IconName } from './IconSprite';

// ───── 模块级事件总线（让任意组件能 showConfirm / showToast 而无需 prop 穿透） ─────

type ConfirmOpts = {
  title?: string; message?: string; confirmText?: string; cancelText?: string; danger?: boolean;
};
type ToastOpts = { type?: 'success' | 'warn' | 'error' | 'info'; duration?: number };

type Subs = {
  confirm?: (opts: ConfirmOpts) => Promise<boolean>;
  toast?: (message: string, opts?: ToastOpts) => void;
};
const subs: Subs = {};

export function showConfirm(opts: ConfirmOpts = {}): Promise<boolean> {
  return subs.confirm ? subs.confirm(opts) : Promise.resolve(window.confirm(opts.message || ''));
}
export function showToast(message: string, opts: ToastOpts = {}): void {
  if (subs.toast) subs.toast(message, opts);
  else console.log('[toast]', message);
}

// ───── 实现 ─────

interface ToastItem { id: number; message: string; type: NonNullable<ToastOpts['type']>; closing?: boolean }
interface ModalState extends ConfirmOpts { resolve: (v: boolean) => void }

export function ToastModalHost() {
  const [modal, setModal] = useState<ModalState | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: number) => {
    setToasts((arr) => arr.map((t) => (t.id === id ? { ...t, closing: true } : t)));
    setTimeout(() => setToasts((arr) => arr.filter((t) => t.id !== id)), 200);
  }, []);

  useEffect(() => {
    subs.confirm = (opts) => new Promise<boolean>((resolve) => setModal({ ...opts, resolve }));
    subs.toast = (message, opts) => {
      const type = opts?.type ?? 'info';
      const dur = opts?.duration ?? 3500;
      const id = Date.now() + Math.random();
      // 去重：1.5s 内同样的 message + type 直接吞掉，不刷屏
      setToasts((arr) => {
        const now = Date.now();
        const isDuplicate = arr.some((t) => t.message === message && t.type === type && (now - t.id) < 1500);
        if (isDuplicate) return arr;
        return [...arr, { id, message, type }];
      });
      if (dur > 0) setTimeout(() => removeToast(id), dur);
    };
    return () => { delete subs.confirm; delete subs.toast; };
  }, [removeToast]);

  const closeModal = (v: boolean) => {
    if (!modal) return;
    modal.resolve(v);
    setModal(null);
  };

  // ESC / Enter
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(false); }
      if (e.key === 'Enter') { e.preventDefault(); closeModal(true); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal]);

  return (
    <>
      <div
        id="modalRoot"
        className={'modal-root' + (modal ? '' : ' hidden')}
        aria-hidden={!modal}
        onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(false); }}
      >
        {modal && (
          <div className="modal-card" role="dialog" aria-modal="true">
            <div className="modal-head">
              <div className={'modal-icon ' + (modal.danger ? 'danger' : 'confirm')}>
                <Icon name={modal.danger ? 'i-warn' : 'i-info'} />
              </div>
              <h3 className="modal-title">{modal.title ?? '确认操作'}</h3>
            </div>
            <div className="modal-body">{modal.message ?? ''}</div>
            <div className="modal-foot">
              <button type="button" className="modal-btn secondary" onClick={() => closeModal(false)}>
                {modal.cancelText ?? '取消'}
              </button>
              <button
                type="button"
                autoFocus
                className={'modal-btn ' + (modal.danger ? 'danger' : 'primary')}
                onClick={() => closeModal(true)}
              >
                {modal.confirmText ?? '确定'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div id="toastRoot" className="toast-root" aria-live="polite">
        {toasts.map((t) => {
          const iconId: IconName =
            t.type === 'success' ? 'i-check'
            : t.type === 'warn' ? 'i-warn'
            : t.type === 'error' ? 'i-warn'
            : 'i-info';
          return (
            <div key={t.id} className={'toast ' + t.type + (t.closing ? ' closing' : '')}>
              <span className="toast-icon"><Icon name={iconId} size="sm" /></span>
              <div className="toast-body">{t.message}</div>
              <button className="toast-close" type="button" title="关闭" onClick={() => removeToast(t.id)}>
                <Icon name="i-x" size="sm" />
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
