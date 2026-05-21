import { z } from 'zod';

/** YAML 任务定义：人工写在 apps/server/eval/tasks/<category>/<id>.yaml */
export const EvalTaskSchema = z.object({
  id: z.string().min(1),
  category: z.string().min(1),
  input: z.string().min(1),
  tags: z.array(z.string()).default([]),
  // 可选附件（路径相对 apps/server）
  attachments: z.array(z.string()).default([]),
  expect: z
    .object({
      must_call_tool: z.union([z.string(), z.array(z.string())]).optional(),
      must_not_call_tool: z.union([z.string(), z.array(z.string())]).optional(),
      final_contains: z.array(z.string()).default([]),
      must_not_contain: z.array(z.string()).default([]),
      max_steps: z.number().int().positive().optional(),
      max_tokens: z.number().int().positive().optional(),
      // LLM-as-judge（Phase 1B 才接上，Phase 1A 仅校验 schema）
      judge_prompt: z.string().optional(),
      judge_min_score: z.number().min(0).max(5).optional(),
    })
    .default({}),
});
export type EvalTask = z.infer<typeof EvalTaskSchema>;

/** 单条断言结果 */
export interface AssertionResult {
  name: string;
  pass: boolean;
  detail?: string;
  /** judge 类断言：附带分数（0-5） */
  score?: number;
}

/** 单个任务的执行结果 */
export interface TaskRun {
  task: EvalTask;
  ok: boolean;
  /** 终答案文本 */
  finalAnswer: string;
  /** 实际调用过的工具序列 */
  toolsCalled: string[];
  steps: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  assertions: AssertionResult[];
  /** 出错时的错误信息（runner 自身错误，不是断言失败） */
  error?: string;
  /** 可选：用于事后人工 review */
  traceId?: string;
}

/** 整轮报表 */
export interface RunReport {
  runId: string;
  provider: string;
  judgeProvider?: string;            // LLM-as-judge 用的 provider（如有）
  startedAt: string;
  endedAt: string;
  durationMs: number;
  totals: {
    total: number;
    pass: number;
    fail: number;
    error: number;
  };
  byCategory: Record<string, { pass: number; fail: number; total: number }>;
  tasks: TaskRun[];
  /** 与上一次 latest-<provider>.json 的回归 diff */
  regressions?: Array<{ id: string; wasPass: boolean; nowPass: boolean }>;
  newPasses?: Array<{ id: string }>;
  baselineRunId?: string;
}
