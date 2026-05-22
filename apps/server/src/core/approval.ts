/**
 * 动态审批：危险但有时合法的操作走人工 Approve / Deny。
 *
 * 流程：
 *   1. before:tool:call hook 命中"需要审批"的规则 → 创建 PendingApproval 进 map，emit 'permission:requested' SSE
 *   2. hook 返回的 Promise 挂起；conductor 这一支不会继续往下走
 *   3. 前端弹按钮组件，用户点 Approve/Deny → POST /sessions/:id/permission/:reqId/answer { allow }
 *   4. resolveApproval(id, allow) 让 Promise resolve；hook 返回 {allow} 给 conductor
 *   5. 超时（默认 30s）自动 deny，让对话不会因为用户离开就死等
 *
 * 关键设计选择：
 *   - **每个 session 同时只允许一个 pending**：UX 上同时多个 approval 太混乱；
 *     第 2 个进来的直接拒绝（避免 hook 永远 pending）
 *   - **超时默认 30s**：太长用户已经离开；太短关键操作来不及决策
 *   - **拒绝时给 LLM 的 hint 说明是"用户主动拒绝"而非"规则黑名单"**：让 LLM 改方案而不是 retry
 */
import crypto from 'node:crypto';
import { logger } from '../observability/logger.js';
import type { MessageBus } from './messageBus.js';
import type { HookHandler } from './hooks.js';
import { registerHook } from './hooks.js';
import type { DangerRule } from './safetyRules.js';
import { checkDangerous } from './safetyRules.js';
import { redactSecrets } from './redact.js';
import { prepare } from './db.js';
import { config } from '../config.js';

export interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  rule: string;
  reason: string;
  createdAt: number;
  /** 兜底超时 ms */
  timeoutMs: number;
  /** 由 requestApproval 持有；resolveApproval 时调 resolve */
  _resolve: (allow: boolean) => void;
  _timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = config.approval.timeoutMs;

interface PendingApprovalInternal extends Omit<PendingApproval, never> {
  bus?: MessageBus;
  abortListener?: () => void;
  signal?: AbortSignal;
}

/** 全局 pending 表：requestId → PendingApprovalInternal */
const pending = new Map<string, PendingApprovalInternal>();
/** session 维度的并发锁：同 session 只允许 1 个 pending */
const sessionLock = new Set<string>();

/** 一个 helper：UI 拉一下当前 pending（如果有），用于刷新 / reconnect */
export function listPending(sessionId: string): Array<Omit<PendingApproval, '_resolve' | '_timer'>> {
  const out: Array<Omit<PendingApproval, '_resolve' | '_timer'>> = [];
  for (const p of pending.values()) {
    if (p.sessionId !== sessionId) continue;
    out.push({
      id: p.id, sessionId: p.sessionId, toolName: p.toolName,
      input: redactSecrets(p.input),    // reconnect 拉取也走 redact
      rule: p.rule, reason: p.reason, createdAt: p.createdAt, timeoutMs: p.timeoutMs,
    });
  }
  return out;
}

/** Hook 内部调用：请求审批 + 等待用户回复 */
export async function requestApproval(args: {
  sessionId: string;
  toolName: string;
  input: unknown;
  rule: string;
  reason: string;
  timeoutMs?: number;
  bus?: MessageBus;
  signal?: AbortSignal;
}): Promise<boolean> {
  // signal 已经 abort：直接 deny，不创建 pending
  if (args.signal?.aborted) return false;

  // 同 session 并发 pending：直接拒绝（避免 UX 混乱 + 防止 hook 永远 pending）
  if (sessionLock.has(args.sessionId)) {
    logger.warn({ sessionId: args.sessionId }, '[approval] 同 session 已有 pending，拒绝新请求');
    return false;
  }
  const id = crypto.randomBytes(8).toString('hex');
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  sessionLock.add(args.sessionId);

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      logger.warn({ id, sessionId: args.sessionId }, '[approval] 超时自动 deny');
      finalize(id, false, 'timeout');
    }, timeoutMs);

    const entry: PendingApprovalInternal = {
      id,
      sessionId: args.sessionId,
      toolName: args.toolName,
      input: args.input,
      rule: args.rule,
      reason: args.reason,
      createdAt: Date.now(),
      timeoutMs,
      _resolve: resolve,
      _timer: timer,
      bus: args.bus,
      signal: args.signal,
    };

    // 用户关闭浏览器 / stop：abort 触发 → 立刻 deny 不傻等超时
    if (args.signal) {
      const onAbort = (): void => finalize(id, false, 'cancel');
      entry.abortListener = onAbort;
      args.signal.addEventListener('abort', onAbort, { once: true });
    }

    pending.set(id, entry);
    // 同步落 sqlite —— 用于 audit / crash 后取证（hook Promise 跨进程不能恢复，但表里能看到挂起过哪些）
    try {
      prepare(`
        INSERT INTO approvals (id, session_id, tool_name, input, rule_name, reason, created_at, timeout_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, args.sessionId, args.toolName, JSON.stringify(args.input), args.rule, args.reason, entry.createdAt, timeoutMs);
    } catch (err) {
      logger.warn({ err: (err as Error).message, id }, '[approval] sqlite 持久化失败（best-effort）');
    }
    args.bus?.emit('permission:requested', {
      sessionId: args.sessionId,
      requestId: id,
      toolName: args.toolName,
      rule: args.rule,
      reason: args.reason,
      // input 透传到前端前 redact secret，避免 LLM 误把 token 塞进命令时漏到 DOM
      input: redactSecrets(args.input),
      timeoutMs,
      createdAt: entry.createdAt,
    });
  });
}

function finalize(id: string, allow: boolean, source: 'user' | 'timeout' | 'cancel'): void {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry._timer);
  if (entry.signal && entry.abortListener) {
    entry.signal.removeEventListener('abort', entry.abortListener);
  }
  pending.delete(id);
  sessionLock.delete(entry.sessionId);
  // 同步删 sqlite 行
  try { prepare('DELETE FROM approvals WHERE id = ?').run(id); }
  catch (err) { logger.warn({ err: (err as Error).message, id }, '[approval] sqlite 清理失败'); }
  entry.bus?.emit('permission:resolved', {
    sessionId: entry.sessionId,
    requestId: id,
    allow,
    source,
  });
  entry._resolve(allow);
}

/** HTTP 路由调用：用户点 Approve / Deny 后 */
export function resolveApproval(id: string, allow: boolean): { ok: boolean; reason?: string } {
  if (!pending.has(id)) return { ok: false, reason: 'not_found_or_expired' };
  finalize(id, allow, 'user');
  return { ok: true };
}

/**
 * Boot 时调一次：清理 sqlite 里上次进程留下的 stale pending。
 * 这些行对应的 hook Promise 在内存里已经随进程消亡，无法 resolve；表里行只是垃圾。
 * 返回清理的行数（可写日志或上 metrics）。
 */
export function clearStaleApprovalsOnBoot(): number {
  try {
    const res = prepare('DELETE FROM approvals').run();
    if (res.changes > 0) {
      logger.warn({ count: res.changes }, '[approval] 清理上次进程残留的 pending（这些请求其实已经丢失）');
    }
    return Number(res.changes);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[approval] boot 清理失败');
    return 0;
  }
}

/** 服务关闭 / session 删除时清理所有 pending；统一 deny */
export function cancelAllForSession(sessionId: string): void {
  for (const [id, entry] of pending.entries()) {
    if (entry.sessionId === sessionId) finalize(id, false, 'cancel');
  }
}

/**
 * 安装"需要审批"的 hook —— 命中 rules 时不 deny，而是请求人工审批。
 *
 * 注意：和 installDefaultSafetyHooks 是**互斥**两条路：
 *   - safety: 命中 → 硬 deny（rm -rf 这种零容忍）
 *   - approval: 命中 → 人工 Approve/Deny（如 git reset --hard、写敏感路径）
 *
 * 两个 hook 都注册到 before:tool:call。safety 优先（按 register 顺序），命中就 short-circuit
 * 不会走到 approval。这样设计是为了：硬危险永远拦，灰色操作问人。
 */
export function installApprovalHook(
  rules: DangerRule[] = DEFAULT_APPROVAL_RULES,
  timeoutMs?: number,
): () => void {
  const handler: HookHandler<'before:tool:call'> = async (ctx) => {
    const hit = checkDangerous(ctx.input, rules);
    if (!hit) return { allow: true };
    const allow = await requestApproval({
      sessionId: ctx.sessionId,
      toolName: ctx.toolName,
      input: ctx.input,
      rule: hit.name,
      reason: hit.reason,
      timeoutMs,
      bus: ctx.bus,
      signal: ctx.signal,
    });
    if (allow) return { allow: true };
    return {
      allow: false,
      ruleName: `approval:${hit.name}`,
      reason: `用户拒绝了审批请求（或超时 / 中断）：${hit.reason}`,
    };
  };
  return registerHook('before:tool:call', handler);
}

/**
 * 内置审批规则示例：灰色但有时合法的操作。
 * 用户可以通过 APPROVAL_RULES env 覆盖（同 SAFETY_EXTRA_RULES 格式）。
 */
export const DEFAULT_APPROVAL_RULES: DangerRule[] = [
  // git 破坏性命令：常规但偶尔需要
  {
    name: 'git-reset-hard',
    reason: 'git reset --hard 会丢弃当前未提交的修改。',
    pattern: /\bgit\s+reset\s+--hard\b/i,
  },
  {
    name: 'git-clean-force',
    reason: 'git clean -fd 会删除未跟踪文件和目录。',
    pattern: /\bgit\s+clean\s+-[a-z]*f[a-z]*\b/i,
  },
  {
    name: 'git-push-force',
    reason: 'git push --force 会覆盖远程历史。',
    pattern: /\bgit\s+push\s+(?:--force|-f)\b/i,
  },
  // 安装 / 卸载包
  {
    name: 'npm-uninstall-global',
    reason: '全局 npm 卸载会影响系统其他项目。',
    pattern: /\bnpm\s+(?:uninstall|remove|rm)\s+(?:-g|--global)\b/i,
  },
  // 写入敏感路径（在 input 字符串里看到这些路径前缀就走审批）
  {
    name: 'write-to-system-path',
    reason: '写入 /etc / /usr / /System 等系统路径会影响系统配置。',
    pattern: /(?:"|\s|^)(?:\/etc\/|\/usr\/(?:bin|sbin|local)\/|\/System\/|c:\\windows\\)/i,
  },
];

/** 从 env 加载额外的审批规则。和 safetyRules.loadExtraRulesFromEnv 完全同构（不同 env 名）。 */
export function loadApprovalRulesFromEnv(): DangerRule[] {
  const raw = process.env.APPROVAL_EXTRA_RULES || config.approval.extraRulesRaw;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ name?: string; reason?: string; pattern?: string; flags?: string }>;
    if (!Array.isArray(parsed)) return [];
    const out: DangerRule[] = [];
    for (const r of parsed) {
      if (!r?.name || !r?.reason || !r?.pattern) continue;
      try {
        out.push({ name: r.name, reason: r.reason, pattern: new RegExp(r.pattern, r.flags ?? 'i') });
      } catch {/* 单条坏规则跳过 */}
    }
    return out;
  } catch {
    return [];
  }
}
