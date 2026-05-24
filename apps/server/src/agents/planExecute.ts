/**
 * V2 Plan-and-Execute 路径（从 conductor.ts 抽出）。
 *
 * 流程：
 *   1. 按 plan.steps 顺序逐步执行；每步 append 一条 user 指令后调 runReactSteps
 *   2. 任一步失败 → 给一次 re-plan 机会（修订剩余 steps）；第二次失败保守停止
 *   3. 全部步骤跑完后做最终聚合：把所有 step 结果摆给 LLM，让它给最终答复
 *
 * 设计选择：
 *   - 接受 `runReactSteps` 作为回调注入（依赖注入），避免循环 import conductor
 *   - 其他依赖（llm/sessionManager/bus/logger）通过 deps 对象统一传入
 *   - 不依赖 `this`，是纯 free function——好测、好理解
 */
import type { Logger } from 'pino';
import type { LLMLike, Usage } from '../types.js';
import type { SessionManager } from '../core/session.js';
import type { MessageBus } from '../core/messageBus.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Trace, Tracer, Span } from '../observability/tracer.js';
import { revisePlan, type Plan } from './planner.js';
import { requestApproval } from '../core/approval.js';
import { reflect } from './reflexion.js';
import { logFailure } from '../core/failureLog.js';

// W1.4 R4 Task-level checkpoint：每 N 个 step 暂停问用户「继续 / 中止」。
// 0 = 不做 checkpoint（默认；保留旧行为）
const PLAN_CHECKPOINT_EVERY = Number(process.env.PLAN_CHECKPOINT_EVERY || 0);

export interface PlanExecuteDeps {
  llm: LLMLike;
  sessionManager: SessionManager;
  bus?: MessageBus;
  logger: Logger;
  /** 抽象的"跑 N 步 ReAct"回调；由 conductor 注入它的私有方法 */
  runReactSteps: (args: RunReactArgs) => Promise<{ finalContent: string }>;
}

export interface RunReactArgs {
  sessionId: string;
  augmentedSystem: string;
  tools: ReturnType<ToolRegistry['specsFor']>;
  span: Span;
  trace: Trace;
  tracer: Tracer;
  stream: boolean;
  totalUsage: Usage;
  stepCounter: { value: number };
  maxSteps: number;
  userMessage: string;
  allowCritique: boolean;
  critiqueDoneRef: { value: boolean };
  signal?: AbortSignal;
}

export interface PlanExecuteArgs {
  plan: Plan;
  sessionId: string;
  augmentedSystem: string;
  tools: ReturnType<ToolRegistry['specsFor']>;
  span: Span;
  trace: Trace;
  tracer: Tracer;
  stream: boolean;
  totalUsage: Usage;
  stepCounter: { value: number };
  userMessage: string;
  signal?: AbortSignal;
}

const PER_STEP_MAX = 4;

export async function planExecuteSteps(deps: PlanExecuteDeps, args: PlanExecuteArgs): Promise<void> {
  const stepResults: Array<{ id: string; ok: boolean; output: string }> = [];
  let pendingSteps = [...args.plan.steps];     // 队列：可以被 re-plan 替换
  let revised = false;                          // 一次 turn 只允许 re-plan 一次

  while (pendingSteps.length > 0) {
    const step = pendingSteps.shift()!;
    const stepStartedAt = Date.now();
    deps.bus?.emit('plan:step:start', {
      sessionId: args.sessionId,
      stepId: step.id,
      description: step.description,
    });
    const stepSpan = args.tracer.startSpan(args.trace, 'agent', `plan.step[${step.id}]`, {
      parentId: args.span.spanId,
      description: step.description,
    });
    // 给 LLM 注入「执行这一步」的 user 指令
    await deps.sessionManager.appendMessage(args.sessionId, {
      role: 'user',
      content:
        `[执行计划 ${step.id}] ${step.description}` +
        (step.success_criteria ? `\n验收：${step.success_criteria}` : ''),
      meta: { createdAt: Date.now(), planStep: step.id },
    });

    let stepOk = true;
    let stepContent = '';
    let stepError = '';
    try {
      const r = await deps.runReactSteps({
        sessionId: args.sessionId,
        augmentedSystem: args.augmentedSystem,
        tools: args.tools,
        span: args.span,
        trace: args.trace,
        tracer: args.tracer,
        stream: args.stream,
        totalUsage: args.totalUsage,
        stepCounter: args.stepCounter,
        maxSteps: PER_STEP_MAX,
        userMessage: step.description,
        allowCritique: false,                   // 单步内不 critique
        critiqueDoneRef: { value: true },
        signal: args.signal,
      });
      stepContent = r.finalContent;
    } catch (err) {
      stepOk = false;
      stepError = (err as Error).message;
      stepContent = `(step 失败：${stepError})`;
    }
    args.tracer.endSpan(args.trace, stepSpan, {
      status: stepOk ? 'ok' : 'error',
      output: stepContent?.slice(0, 200),
    });
    deps.bus?.emit('plan:step:end', {
      sessionId: args.sessionId,
      stepId: step.id,
      ok: stepOk,
      durationMs: Date.now() - stepStartedAt,
      finalContent: stepContent?.slice(0, 600),
    });
    stepResults.push({ id: step.id, ok: stepOk, output: stepContent });

    // ── Task-level checkpoint（W1.4 R4）──
    // 每 N 步暂停问用户继续 / 中止；失败的 step 不算（让 re-plan 兜底），最后一步也不问（聚合再问没意义）
    if (PLAN_CHECKPOINT_EVERY > 0 && stepOk && pendingSteps.length > 0
        && stepResults.length % PLAN_CHECKPOINT_EVERY === 0) {
      const doneSummary = stepResults.slice(-PLAN_CHECKPOINT_EVERY)
        .map((r) => `  - ${r.id}: ${r.output.slice(0, 80).replace(/\n/g, ' ')}`).join('\n');
      const allow = await requestApproval({
        sessionId: args.sessionId,
        toolName: 'plan-checkpoint',
        input: { completedCount: stepResults.length, remaining: pendingSteps.length, recent: doneSummary },
        rule: 'plan-checkpoint',
        reason: `已完成 ${stepResults.length} 步，还剩 ${pendingSteps.length} 步。最近 ${PLAN_CHECKPOINT_EVERY} 步：\n${doneSummary}\n\n继续还是中止？`,
        bus: deps.bus,
        signal: args.signal,
      });
      if (!allow) {
        deps.logger.warn({ done: stepResults.length, remaining: pendingSteps.length }, '[plan] checkpoint 被拒，中止剩余 step');
        deps.bus?.emit('plan:checkpoint:abort', {
          sessionId: args.sessionId,
          completedCount: stepResults.length,
          remainingCount: pendingSteps.length,
        });
        break;
      }
    }

    // 失败 → 一次 re-plan 机会
    if (!stepOk) {
      if (revised) {
        deps.logger.warn({ stepId: step.id }, '[plan] 已经 re-plan 过一次，本次失败不再重试');
        break;
      }
      revised = true;
      deps.logger.info({ stepId: step.id, error: stepError }, '[plan] step 失败，尝试 re-plan 剩余步骤');
      // Reflexion（W2.1 R2）：先让 LLM 反思失败原因 → 附到 re-plan prompt
      const reflection = await reflect({
        llm: deps.llm,
        taskDescription: step.description,
        failureReason: stepError || stepContent.slice(0, 200),
        completedSummary: stepResults.filter((r) => r.ok).map((r) => r.id).join(', '),
      });
      if (reflection) {
        deps.bus?.emit('reflexion:noted', { sessionId: args.sessionId, stepId: step.id, reflection });
        deps.logger.info({ stepId: step.id, reflection: reflection.slice(0, 100) }, '[reflexion] 写了反思');
      }
      // 自动落 global failures.md（跨 session 累积，下次类似任务 LLM 自查）
      void logFailure({
        sessionId: args.sessionId,
        task: step.description,
        reason: stepError || stepContent.slice(0, 300),
        fix: reflection ?? undefined,
      }).catch((err) => deps.logger.warn({ err: (err as Error).message }, '[plan] auto logFailure 失败'));
      const replanSpan = args.tracer.startSpan(args.trace, 'llm', 'conductor.replan', { parentId: args.span.spanId });
      try {
        const revisedPlan = await revisePlan(deps.llm, {
          userMessage: args.userMessage,
          failedStepId: step.id,
          failureReason: (stepError || stepContent.slice(0, 200)) + (reflection ? `\n\n反思：${reflection}` : ''),
          completedSteps: stepResults
            .filter((r) => r.ok)
            .map((r) => ({ id: r.id, description: '', outputDigest: r.output.slice(0, 80) })),
          remainingSteps: pendingSteps,
        });
        args.tracer.endSpan(args.trace, replanSpan, {
          output: revisedPlan ? `${revisedPlan.steps.length} new steps` : 'null',
        });
        if (revisedPlan) {
          deps.bus?.emit('plan:revised', {
            sessionId: args.sessionId,
            reason: stepError || stepContent.slice(0, 200),
            failedStepId: step.id,
            newSteps: revisedPlan.steps,
          });
          // 替换剩余队列，重新跑
          pendingSteps = revisedPlan.steps;
          continue;
        }
        // 修订失败 → 保守停止
        break;
      } catch (err) {
        args.tracer.endSpan(args.trace, replanSpan, { status: 'error', error: err });
        break;
      }
    }
  }

  // 最后聚合：把所有 step 结果摆给 LLM，让它给最终答复
  const summary = stepResults.map((r) => `- ${r.id} (${r.ok ? 'ok' : 'fail'}): ${r.output.slice(0, 200)}`).join('\n');
  await deps.sessionManager.appendMessage(args.sessionId, {
    role: 'user',
    content: `[计划执行完成] 各步骤结果如下，请给出最终汇总答复（不要再调工具）：\n${summary}`,
    meta: { createdAt: Date.now(), planSynth: true },
  });
  await deps.runReactSteps({
    sessionId: args.sessionId,
    augmentedSystem: args.augmentedSystem,
    tools: args.tools,
    span: args.span,
    trace: args.trace,
    tracer: args.tracer,
    stream: args.stream,
    totalUsage: args.totalUsage,
    stepCounter: args.stepCounter,
    maxSteps: 2,
    userMessage: args.userMessage,
    allowCritique: false,
    critiqueDoneRef: { value: true },
    signal: args.signal,
  });
}
