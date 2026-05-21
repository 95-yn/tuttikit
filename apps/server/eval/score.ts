import type { EvalTask, AssertionResult } from './types.js';
import { judgeAnswer, isJudgeAvailable } from './judge.js';

export interface ScoreInput {
  finalAnswer: string;
  toolsCalled: string[];
  steps: number;
  tokensIn: number;
  tokensOut: number;
}

export interface ScoreOptions {
  judgeProvider?: string;
}

/**
 * 对一条 EvalTask 跑所有 expect 断言，返回每条结果。
 * 任一断言失败 → 任务整体失败。
 */
export function scoreTask(task: EvalTask, run: ScoreInput): AssertionResult[] {
  const out: AssertionResult[] = [];
  const e = task.expect;

  if (e.must_call_tool) {
    const required = toArray(e.must_call_tool);
    for (const tool of required) {
      const hit = run.toolsCalled.includes(tool);
      out.push({
        name: `must_call_tool(${tool})`,
        pass: hit,
        detail: hit ? undefined : `实际调用工具：[${run.toolsCalled.join(', ') || '<无>'}]`,
      });
    }
  }

  if (e.must_not_call_tool) {
    const forbidden = toArray(e.must_not_call_tool);
    for (const tool of forbidden) {
      const hit = run.toolsCalled.includes(tool);
      out.push({
        name: `must_not_call_tool(${tool})`,
        pass: !hit,
        detail: hit ? `不该调用 ${tool}` : undefined,
      });
    }
  }

  for (const needle of e.final_contains) {
    const ok = run.finalAnswer.includes(needle);
    out.push({
      name: `final_contains("${truncate(needle)}")`,
      pass: ok,
      detail: ok ? undefined : `答案片段：${truncate(run.finalAnswer, 80)}`,
    });
  }

  for (const banned of e.must_not_contain) {
    const hit = run.finalAnswer.includes(banned);
    out.push({
      name: `must_not_contain("${truncate(banned)}")`,
      pass: !hit,
      detail: hit ? `答案中出现了被禁词：${truncate(banned)}` : undefined,
    });
  }

  if (e.max_steps !== undefined) {
    const ok = run.steps <= e.max_steps;
    out.push({
      name: `max_steps(${e.max_steps})`,
      pass: ok,
      detail: ok ? undefined : `实际 ${run.steps} 步`,
    });
  }

  if (e.max_tokens !== undefined) {
    const total = run.tokensIn + run.tokensOut;
    const ok = total <= e.max_tokens;
    out.push({
      name: `max_tokens(${e.max_tokens})`,
      pass: ok,
      detail: ok ? undefined : `实际 ${total} tokens (in=${run.tokensIn} out=${run.tokensOut})`,
    });
  }

  // judge_prompt：实际打分在 scoreTaskAsync 里跑（需要异步）；这里仅占位
  if (e.judge_prompt) {
    out.push({
      name: 'judge (pending)',
      pass: true,
      detail: 'judge 在 async 路径运行，此处占位',
    });
  }

  return out;
}

/**
 * Async 版：包含 LLM-as-judge 调用。runner 用这个。
 * judge 不可用（mock provider）时，judge 断言记为 skipped（pass=true + detail 说明）。
 */
export async function scoreTaskAsync(
  task: EvalTask,
  run: ScoreInput,
  opts: ScoreOptions = {},
): Promise<AssertionResult[]> {
  const out = scoreTask(task, run).filter((r) => r.name !== 'judge (pending)');
  const e = task.expect;
  if (!e.judge_prompt) return out;

  if (!isJudgeAvailable(opts.judgeProvider)) {
    out.push({
      name: 'judge (skipped)',
      pass: true,
      detail: 'judge provider 不可用（mock 或缺 API key），任务视为通过',
    });
    return out;
  }
  const minScore = e.judge_min_score ?? 3;
  const result = await judgeAnswer({
    task: task.input,
    rubric: e.judge_prompt,
    draft: run.finalAnswer,
    providerName: opts.judgeProvider,
  });
  if (result.error) {
    out.push({
      name: 'judge (error)',
      pass: false,
      detail: result.error,
    });
    return out;
  }
  out.push({
    name: `judge(>=${minScore})`,
    pass: result.score >= minScore,
    score: result.score,
    detail: result.reason
      ? `${result.score}/5 · ${result.reason}`
      : `${result.score}/5`,
  });
  return out;
}

export function allPass(assertions: AssertionResult[]): boolean {
  return assertions.every((a) => a.pass);
}

function toArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

function truncate(s: string, n = 40): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}
