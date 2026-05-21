'use client';
import { useEffect, useState } from 'react';

/**
 * 客户端调试面板：URL 加 `?debug=1` 启用，右下角浮窗。
 * 显示：
 *   - 当前 provider / theme / kb-offset
 *   - sessions 数 / 活跃会话 id 截断
 *   - SSE 连接状态 + 重连次数（从 console 日志推断）
 *   - 一键清缓存 / reload
 *
 * 不参与生产路径，纯排错用。
 */
export function DebugPanel() {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<Record<string, string>>({});

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(location.search);
    const isOn = params.get('debug') === '1' || localStorage.getItem('mas:debug') === '1';
    setEnabled(isOn);
    if (isOn) localStorage.setItem('mas:debug', '1');
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      const html = document.documentElement;
      const kb = html.style.getPropertyValue('--kb-offset') || '0';
      const theme = html.getAttribute('data-theme') || 'dark';
      const sessions = document.querySelectorAll('.session-item').length;
      const active = document.querySelector('.session-item.active .session-title-text')?.textContent || '—';
      const provider = document.querySelector('.provider-label')?.textContent || '?';
      const msgs = document.querySelectorAll('.msg').length;
      const tools = document.querySelectorAll('.tool-block').length;
      setInfo({
        theme,
        kb,
        provider,
        sessions: String(sessions),
        activeSession: active.length > 30 ? active.slice(0, 30) + '…' : active,
        msgs: String(msgs),
        tools: String(tools),
        viewport: `${window.innerWidth}×${window.innerHeight}`,
        ua: navigator.userAgent.match(/(Chrome|Firefox|Safari|Edge)\/[\d.]+/)?.[0] || 'unknown',
      });
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div className={'debug-panel' + (open ? ' open' : '')}>
      <button
        type="button"
        className="debug-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? '收起 debug 面板' : '展开 debug 面板'}
        title="Debug 面板"
      >
        {open ? '×' : '🐛'}
      </button>
      {open && (
        <div className="debug-body">
          <div className="debug-title">Debug</div>
          {Object.entries(info).map(([k, v]) => (
            <div key={k} className="debug-row">
              <span className="debug-key">{k}</span>
              <span className="debug-val">{v}</span>
            </div>
          ))}
          <div className="debug-actions">
            <button type="button" onClick={() => location.reload()}>reload</button>
            <button type="button" onClick={() => {
              // 清掉本地 cache（localStorage、sessionStorage）
              localStorage.clear();
              sessionStorage.clear();
              location.reload();
            }}>clear cache + reload</button>
            <button type="button" onClick={() => {
              localStorage.removeItem('mas:debug');
              location.href = location.pathname;     // 去掉 ?debug=1 query
            }}>关闭 debug</button>
          </div>
        </div>
      )}
    </div>
  );
}
