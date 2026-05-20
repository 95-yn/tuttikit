'use client';
import { CONTEXT_WINDOW, DEFAULT_CTX_WINDOW, fmtTokens } from '@/lib/tokens';

interface Props {
  provider: string;
  lastInputTokens: number;
  sessionTotalIn: number;
  sessionTotalOut: number;
}

export function CtxMeter({
  provider, lastInputTokens, sessionTotalIn, sessionTotalOut,
}: Props) {
  const max = CONTEXT_WINDOW[provider] || DEFAULT_CTX_WINDOW;
  const pct = Math.min(100, Math.round((lastInputTokens / max) * 100));
  const fillCls = pct >= 90 ? 'ctx-bar-fill error' : pct >= 70 ? 'ctx-bar-fill warn' : 'ctx-bar-fill';
  const title =
    `当前上下文（最近一次请求 input）：${lastInputTokens.toLocaleString()} tokens\n` +
    `模型窗口（${provider}）：${max.toLocaleString()} tokens\n` +
    `会话累计：↓ ${sessionTotalIn.toLocaleString()} in · ↑ ${sessionTotalOut.toLocaleString()} out`;

  return (
    <div className="ctx-meter" title={title}>
      <span className="ctx-label">ctx</span>
      <div className="ctx-bar"><div className={fillCls} style={{ width: pct + '%' }} /></div>
      <span className="ctx-text">{fmtTokens(lastInputTokens)} / {fmtTokens(max)}</span>
    </div>
  );
}
