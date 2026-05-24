/**
 * failure_log / failure_search —— 让 agent 主动写入 / 查阅全局失败档案。
 *
 * Manus 经验 + Reflexion 强化：保留失败 trace + 给 LLM 看（不是只内部 reflexion）。
 *
 * Conductor 每个 turn 开始自动 inject 最近 5 条到 system，所以多数时候 LLM 不用主动调
 * failure_search；但遇到要 debug 类似旧错时可以显式查。
 */
import { z } from 'zod';
import type { ToolSpec, ToolCtx } from '../types.js';
import { logFailure, searchFailures, type FailureEntry } from '../core/failureLog.js';

const LogInput = z.object({
  task: z.string().min(1).max(200).describe('失败的任务（如 "改 useChat 超时" / "跑 pnpm test"）'),
  reason: z.string().min(1).max(2000).describe('失败原因（错误信息 / traceback 关键部分）'),
  fix: z.string().max(2000).optional().describe('修法（如果已经修好；写明白让以后 LLM 看了能学）'),
});

export const failureLogTool: ToolSpec<z.infer<typeof LogInput>, { entry: FailureEntry }> = {
  name: 'failure_log',
  description:
    '把一次失败记到全局档案（data/agents/global-failures.md）。\n' +
    '会在以后所有 turn 开始时自动给 LLM 看，避免重复犯同样错。\n' +
    'task + reason 必填；fix 可选（已修好就写上，让后人学）。\n' +
    '同 sessionId + 同 task 前 50 字会去重，只保留最新条。',
  parameters: {
    type: 'object',
    properties: {
      task:   { type: 'string', description: '失败的任务描述' },
      reason: { type: 'string', description: '失败原因' },
      fix:    { type: 'string', description: '怎么修的（可选）' },
    },
    required: ['task', 'reason'],
  },
  inputSchema: LogInput,
  allowedAgents: ['conductor', 'coder', 'reviewer'],
  async handler({ task, reason, fix }, ctx: ToolCtx = {}) {
    const entry = await logFailure({ sessionId: ctx.sessionId ?? '_default', task, reason, fix });
    return { entry };
  },
};

const SearchInput = z.object({
  query: z.string().min(1).max(200).describe('在 task / reason / fix 全文做 substring 匹配（不区分大小写）'),
  limit: z.number().int().min(1).max(50).optional(),
});

export const failureSearchTool: ToolSpec<z.infer<typeof SearchInput>, { matches: FailureEntry[] }> = {
  name: 'failure_search',
  description:
    '查全局失败档案。给一个 query 关键词（如 "tsc TS2322" / "useChat"）找历史相关失败。\n' +
    'conductor 已经在每 turn 注入最近 5 条；这个 tool 给"我猜以前栽过这个坑"时主动查。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer', description: '默认 10' },
    },
    required: ['query'],
  },
  inputSchema: SearchInput,
  allowedAgents: ['conductor', 'coder', 'reviewer'],
  async handler({ query, limit }) {
    const matches = await searchFailures(query, limit);
    return { matches };
  },
};
