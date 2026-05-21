'use client';
import { getContextWindow, fmtTokens } from '@/lib/tokens';

interface Props {
  provider: string;
  /** v0.2+：当前 model（从 /health 拿；override provider 时未知）*/
  model?: string;
  /** v0.2+：server 计算好的上下文窗口（首选）；未提供则按 provider+model 查前端表 */
  contextWindow?: number;
  lastInputTokens: number;
  sessionTotalIn: number;
  sessionTotalOut: number;
  /** 后端 BudgetGuard 跟踪的本会话累计 USD（来自 turn:done） */
  sessionUSD?: number;
  /** 后端 budget:warn 事件（>= 80% 上限） */
  budgetWarn?: { scope: 'session' | 'day'; ratio: number } | null;
}

export function CtxMeter({
  provider, model, contextWindow,
  lastInputTokens, sessionTotalIn, sessionTotalOut,
  sessionUSD, budgetWarn,
}: Props) {
  // 优先用 server 传的；其次按 (provider, model) 查前端表；最后兜底
  const max = contextWindow ?? getContextWindow(provider, model);
  const pct = Math.min(100, Math.round((lastInputTokens / max) * 100));
  const fillCls = pct >= 90 ? 'ctx-bar-fill error' : pct >= 70 ? 'ctx-bar-fill warn' : 'ctx-bar-fill';
  // budget 颜色覆盖 ctx 颜色（账单更重要）
  const budgetState = budgetWarn
    ? (budgetWarn.ratio >= 1 ? 'error' : 'warn')
    : null;
  const wrapperCls = budgetState ? `ctx-meter ctx-budget-${budgetState}` : 'ctx-meter';

  const providerLabel = model ? `${provider} · ${model}` : provider;
  const title =
    `当前上下文（最近一次请求 input）：${lastInputTokens.toLocaleString()} tokens\n` +
    `模型窗口（${providerLabel}）：${max.toLocaleString()} tokens\n` +
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
