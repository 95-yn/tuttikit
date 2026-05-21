/**
 * Planner —— 把复杂用户请求拆成 N 步 plan。返回结构化 steps，挂到 system prompt 里供 Conductor 执行。
 *
 * V1 范围：单次 LLM 调用 + 把 plan 当成额外的 system context 给 Conductor，
 * 不引入独立 executor agent（避免一轮里串多个 conductor）。完整 explicit per-step 执行留 V2。
 *
 * 触发条件（启发式，避免每次都调）：
 *   1. config.agent.planAndExecute === true
 *   2. shouldPlan(userMessage) === true
 */
import { z } from 'zod';
import type { LLMLike } from '../types.js';
import { logger } from '../observability/logger.js';

const PLANNER_SYSTEM = `你是任务规划师。给定一个用户请求，把它拆成最少必要的执行步骤（通常 2-5 步）。

**规则**：
  - 只在请求确实需要分阶段时才拆；单一动作（"算一下 X"、"什么是 Y"）直接返回 1 步。
  - 每一步要可独立执行 + 可验证（success_criteria）。
  - 步骤间是顺序依赖（depends_on 引用前面 step 的 id）。
  - 不要凭空加用户没要求的步骤（如"先思考"、"先理解需求"——这些是废话）。

**输出严格 JSON**（不要 markdown 包裹）：
{
  "steps": [
    {"id": "s1", "description": "用 calculator 算 (1+2)*3", "success_criteria": "得到数字结果"},
    {"id": "s2", "description": "把结果写到 data/r.md", "success_criteria": "文件已创建", "depends_on": ["s1"]}
  ]
}`;

const StepSchema = z.object({
  id: z.string(),
  description: z.string(),
  success_criteria: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
});
const PlanSchema = z.object({
  steps: z.array(StepSchema).min(1).max(8),
});
export type PlanStep = z.infer<typeof StepSchema>;
export type Plan = z.infer<typeof PlanSchema>;

/**
 * 启发式：什么样的请求才值得规划？
 * 避免每个 "你好" 都跑一次 planner 烧钱。
 */
export function shouldPlan(userMessage: string): boolean {
  if (!userMessage || userMessage.length < 20) return false;
  // 长 + 含"然后/接着/再/最后/先 ... 然后" 这类多阶段提示词
  const multiStepHint = /然后|接着|再.*?[把帮生成创建写]|最后|先.*?然后|step.?by.?step|步骤/i;
  if (multiStepHint.test(userMessage)) return true;
  // 显式列举（行首 "1." / "一、" 等）
  if (/^\s*(?:[1-9一二三四五]\s*[\.、）)])/m.test(userMessage)) return true;
  // 行内连续编号（"... 1.X 2.Y 3.Z ..." 至少出现 3 个） → 也算多步
  const inlineNums = userMessage.match(/(?<![\d.])[1-9]\s*[\.、）)]/g) ?? [];
  if (inlineNums.length >= 3) return true;
  // 很长（> 100 字符）且含动词序列
  if (userMessage.length > 120) return true;
  return false;
}

export async function planTask(llm: LLMLike, userMessage: string): Promise<Plan | null> {
  try {
    const res = await llm.chat({
      system: PLANNER_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0,
      maxTokens: 768,
    });
    const text = (res.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(text);
    const validated = PlanSchema.safeParse(parsed);
    if (!validated.success) {
      logger.warn({ issues: validated.error.issues }, '[planner] schema 校验失败，跳过');
      return null;
    }
    return validated.data;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[planner] 失败，回退纯 ReAct');
    return null;
  }
}

const REPLAN_SYSTEM = `你是任务规划师。原计划在某步失败了，给你失败原因 + 已完成步骤 + 原始用户请求；
请重新规划「剩余」要做的事（如果根本不该继续就返回 1 步给用户解释失败）。

**规则**：
  - 不要重复已完成的步骤。
  - 如果失败原因表明根本不可行（如外部 API 永久挂、用户输入有冲突），返回 1 步：解释为什么不继续。
  - 否则给出替代路径：换工具、换顺序、跳过非关键步、降级版结果。
  - 同样输出严格 JSON {steps: [...]}，不要 markdown 包裹。`;

export async function revisePlan(llm: LLMLike, args: {
  userMessage: string;
  failedStepId: string;
  failureReason: string;
  completedSteps: Array<{ id: string; description: string; outputDigest?: string }>;
  remainingSteps: PlanStep[];
}): Promise<Plan | null> {
  const ctx = [
    `原始用户请求：${args.userMessage}`,
    `失败的 step：${args.failedStepId}`,
    `失败原因：${args.failureReason}`,
    `已完成的步骤：${args.completedSteps.length === 0 ? '(无)' : args.completedSteps.map((s) => `- ${s.id}: ${s.description}${s.outputDigest ? ` → ${s.outputDigest}` : ''}`).join('\n')}`,
    `原计划中尚未执行的步骤：${args.remainingSteps.length === 0 ? '(无)' : args.remainingSteps.map((s) => `- ${s.id}: ${s.description}`).join('\n')}`,
  ].join('\n\n');
  try {
    const res = await llm.chat({
      system: REPLAN_SYSTEM,
      messages: [{ role: 'user', content: ctx }],
      temperature: 0,
      maxTokens: 768,
    });
    const text = (res.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(text);
    const validated = PlanSchema.safeParse(parsed);
    if (!validated.success) {
      logger.warn({ issues: validated.error.issues }, '[replanner] schema 失败');
      return null;
    }
    return validated.data;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[replanner] 失败，跳过');
    return null;
  }
}

/** 把 plan 渲染成给 Conductor 的额外 system 上下文 */
export function renderPlanForConductor(plan: Plan): string {
  const lines: string[] = ['', '## 本任务的执行计划'];
  lines.push('（这是 Planner 给你的计划，按顺序执行即可。允许根据中间结果微调，但不要无故跳步。）');
  for (const s of plan.steps) {
    const dep = s.depends_on?.length ? `（依赖 ${s.depends_on.join(', ')}）` : '';
    const crit = s.success_criteria ? `  · 验收：${s.success_criteria}` : '';
    lines.push(`- **${s.id}**: ${s.description}${dep}${crit}`);
  }
  lines.push('');
  return lines.join('\n');
}
