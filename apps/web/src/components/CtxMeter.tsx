'use client';
import { CONTEXT_WINDOW, DEFAULT_CTX_WINDOW, fmtTokens } from '@/lib/tokens';

interface Props {
  provider: string;
  lastInputTokens: number;
  sessionTotalIn: number;
  sessionTotalOut: number;
  /** 后端 BudgetGuard 跟踪的本会话累计 USD（来自 turn:done） */
  sessionUSD?: number;
  /** 后端 budget:warn 事件（>= 80% 上限） */
  budgetWarn?: { scope: 'session' | 'day'; ratio: number } | null;
}

export function CtxMeter({
  provider, lastInputTokens, sessionTotalIn, sessionTotalOut,
  sessionUSD, budgetWarn,
}: Props) {
  const max = CONTEXT_WINDOW[provider] || DEFAULT_CTX_WINDOW;
  const pct = Math.min(100, Math.round((lastInputTokens / max) * 100));
  const fillCls = pct >= 90 ? 'ctx-bar-fill error' : pct >= 70 ? 'ctx-bar-fill warn' : 'ctx-bar-fill';
  // budget 颜色覆盖 ctx 颜色（账单更重要）
  const budgetState = budgetWarn
    ? (budgetWarn.ratio >= 1 ? 'error' : 'warn')
    : null;
  const wrapperCls = budgetState ? `ctx-meter ctx-budget-${budgetState}` : 'ctx-meter';

  const title =
    `当前上下文（最近一次请求 input）：${lastInputTokens.toLocaleString()} tokens\n` +
    `模型窗口（${provider}）：${max.toLocaleString()} tokens\n` +
    `会话累计：↓ ${sessionTotalIn.toLocaleString()} in · ↑ ${sessionTotalOut.toLocaleString()} out` +
    (typeof sessionUSD === 'number' ? `\n本会话花费：$${sessionUSD.toFixed(4)}` : '') +
    (budgetWarn ? `\n⚠️ ${budgetWarn.scope === 'session' ? '会话' : '当日'}预算已达 ${Math.round(budgetWarn.ratio * 100)}%` : '');

  return (
    <div className={wrapperCls} title={title}>
      <span className="ctx-label">ctx</span>
      <div className="ctx-bar"><div className={fillCls} style={{ width: pct + '%' }} /></div>
      <span className="ctx-text">{fmtTokens(lastInputTokens)} / {fmtTokens(max)}</span>
      {typeof sessionUSD === 'number' && sessionUSD > 0 && (
        <span className={'ctx-usd' + (budgetState ? ` ctx-usd-${budgetState}` : '')}>
          ${sessionUSD < 0.01 ? sessionUSD.toFixed(4) : sessionUSD.toFixed(2)}
        </span>
      )}
    </div>
  );
}
