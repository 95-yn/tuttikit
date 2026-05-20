'use client';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Icon } from './IconSprite';
import { showToast } from './ToastModalHost';

/**
 * 右下角浮动按钮，点击弹出当前页 LAN 访问 URL + 二维码。
 * 已经在移动端 viewport（≤720px）的用户没必要扫自己 → CSS 隐藏。
 */
export function QrFab() {
  const [open, setOpen] = useState(false);
  const [lanUrl, setLanUrl] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // 拉 LAN URL
  useEffect(() => {
    fetch('/api/lan-host')
      .then((r) => r.json())
      .then((d) => {
        // 优先 LAN，回退到 currentUrl
        const url = d.lanUrl || d.currentUrl;
        setLanUrl(url);
      })
      .catch(() => {});
  }, []);

  // 渲染二维码（白底，给手机摄像头扫得动）
  useEffect(() => {
    if (!lanUrl) return;
    QRCode.toDataURL(lanUrl, {
      width: 192,
      margin: 1,
      color: { dark: '#0a0a0c', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    }).then(setDataUrl).catch(() => {});
  }, [lanUrl]);

  // 点击外面关
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const copy = async () => {
    if (!lanUrl) return;
    try {
      await navigator.clipboard.writeText(lanUrl);
      showToast('链接已复制', { type: 'success', duration: 2000 });
    } catch {
      showToast('复制失败', { type: 'error', duration: 2000 });
    }
  };

  if (!lanUrl) return null;

  return (
    <div className="qr-fab-root" ref={popRef}>
      {open && (
        <div className="qr-popover" role="dialog" aria-label="移动端访问">
          <div className="qr-popover-head">
            <span>移动端扫码访问</span>
            <button
              type="button"
              className="qr-popover-close"
              onClick={() => setOpen(false)}
              aria-label="关闭"
            >
              <Icon name="i-x" size="sm" />
            </button>
          </div>
          <div className="qr-image-wrap">
            {dataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={dataUrl} alt={`QR for ${lanUrl}`} width={192} height={192} />
            ) : (
              <div className="qr-image-loading">生成中…</div>
            )}
          </div>
          <div className="qr-url" title={lanUrl}>{lanUrl}</div>
          <button type="button" className="qr-copy" onClick={copy}>
            <Icon name="i-copy" size="sm" />
            <span>复制链接</span>
          </button>
        </div>
      )}
      <button
        type="button"
        className={'qr-fab' + (open ? ' active' : '')}
        onClick={() => setOpen((v) => !v)}
        title="手机扫码访问"
        aria-label="手机扫码访问"
      >
        <Icon name="i-qr" />
      </button>
    </div>
  );
}
