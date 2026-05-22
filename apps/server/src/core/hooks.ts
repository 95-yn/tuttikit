/**
 * 生命周期 Hook 系统：在 Conductor / Tool 关键节点插入可拦截 / 可改写参数的回调。
 *
 * 和 MessageBus 的区别：
 *   - MessageBus 是**观察**通道：listener 拿到事件做副作用（比如推 SSE），不能阻塞流程
 *   - Hook 是**拦截**通道：handler 返回 { allow: false, reason } 时**阻止后续执行**
 *
 * 节点（phase）：
 *   - 'before:tool:call'    工具执行前；允许 deny 危险命令或改写参数（如 sanitize 路径）
 *   - 'after:tool:call'     工具执行后；可看结果但不能阻止（已经执行了）
 *   - 'before:llm:call'     LLM 调用前；可看 messages（暂未做参数改写）
 *   - 'before:turn'         turn 开始
 *   - 'after:turn'          turn 结束
 *
 * 同节点多个 hook 按注册顺序**串行**跑，任一返回 deny 即 short-circuit。
 */
import { logger } from '../observability/logger.js';
import type { MessageBus } from './messageBus.js';

export type HookPhase =
  | 'before:tool:call'
  | 'after:tool:call'
  | 'before:llm:call'
  | 'before:turn'
  | 'after:turn';

export interface BeforeToolCallCtx {
  phase: 'before:tool:call';
  sessionId: string;
  agent: string;
  toolName: string;
  /** LLM 提供的原始 input（可能被 hook 改写） */
  input: unknown;
  /** 当前 turn 的事件总线；hook 想推 SSE 事件（如审批请求）时用 */
  bus?: MessageBus;
  /** 当前 turn 的 abort signal；长时间 hook（如审批）应该监听这个提前退出 */
  signal?: AbortSignal;
}

export interface AfterToolCallCtx {
  phase: 'after:tool:call';
  sessionId: string;
  agent: string;
  toolName: string;
  input: unknown;
  result: unknown;
  /** tool 抛错时填，否则 undefined */
  error?: Error;
}

export interface BeforeLLMCallCtx {
  phase: 'before:llm:call';
  sessionId: string;
  agent: string;
  provider: string;
  model?: string;
}

export interface TurnCtx {
  phase: 'before:turn' | 'after:turn';
  sessionId: string;
  userMessage?: string;
}

export type HookCtx<P extends HookPhase> =
  P extends 'before:tool:call' ? BeforeToolCallCtx
  : P extends 'after:tool:call' ? AfterToolCallCtx
  : P extends 'before:llm:call' ? BeforeLLMCallCtx
  : P extends 'before:turn' | 'after:turn' ? TurnCtx
  : never;

export type HookOutcome =
  | { allow: true; mutatedInput?: unknown }
  | { allow: false; reason: string; ruleName?: string };

export type HookHandler<P extends HookPhase = HookPhase> = (
  ctx: HookCtx<P>,
) => HookOutcome | Promise<HookOutcome>;

/**
 * Hook 注册表。模块级单例（process 范围内全局生效）；
 * 测试时用 `clearHooks(phase?)` 重置避免污染。
 */
const registry = new Map<HookPhase, HookHandler[]>();

export function registerHook<P extends HookPhase>(
  phase: P,
  handler: HookHandler<P>,
): () => void {
  const arr = registry.get(phase) ?? [];
  arr.push(handler as HookHandler);
  registry.set(phase, arr);
  // 返回 unregister 函数，方便单测做 setup/teardown
  return () => {
    const cur = registry.get(phase);
    if (!cur) return;
    const idx = cur.indexOf(handler as HookHandler);
    if (idx >= 0) cur.splice(idx, 1);
  };
}

export function clearHooks(phase?: HookPhase): void {
  if (phase) registry.delete(phase);
  else registry.clear();
}

export function listHooks(phase: HookPhase): number {
  return registry.get(phase)?.length ?? 0;
}

/** 给 /debug/hooks endpoint 用：列每个 phase 注册的 handler 数（按 phase 分组） */
export function listAllHooks(): Record<HookPhase, { count: number; names: string[] }> {
  const phases: HookPhase[] = [
    'before:tool:call', 'after:tool:call', 'before:llm:call', 'before:turn', 'after:turn',
  ];
  const out = {} as Record<HookPhase, { count: number; names: string[] }>;
  for (const p of phases) {
    const arr = registry.get(p) ?? [];
    out[p] = {
      count: arr.length,
      // handler 通常是匿名 closure，name 多半空——能拿到 function.name 就给名字
      names: arr.map((h, i) => (h as { name?: string }).name || `<anonymous#${i}>`),
    };
  }
  return out;
}

/**
 * 串行跑所有注册到 phase 的 hook。
 * - 任一返回 { allow: false } 立即 short-circuit
 * - 返回 { allow: true, mutatedInput } 时，后续 hook 看到的是改写后的 input
 * - handler 抛异常时**容错放行**（不让 hook bug 把对话挂掉），但日志 warn
 */
export async function runHooks<P extends HookPhase>(
  phase: P,
  ctx: HookCtx<P>,
): Promise<HookOutcome> {
  const handlers = registry.get(phase);
  if (!handlers || handlers.length === 0) return { allow: true };

  let currentCtx = ctx;
  for (const h of handlers) {
    let outcome: HookOutcome;
    try {
      outcome = await (h as HookHandler<P>)(currentCtx);
    } catch (err) {
      logger.warn({ phase, err: (err as Error).message }, '[hook] handler 抛错，跳过');
      continue;
    }
    if (!outcome.allow) return outcome;     // short-circuit
    // 仅 before:tool:call 才支持 mutatedInput
    if (phase === 'before:tool:call' && outcome.mutatedInput !== undefined) {
      currentCtx = { ...currentCtx, input: outcome.mutatedInput } as HookCtx<P>;
    }
  }
  // 全允许；如果有 mutate 把改写过的 input 返回
  if (phase === 'before:tool:call') {
    return { allow: true, mutatedInput: (currentCtx as BeforeToolCallCtx).input };
  }
  return { allow: true };
}
