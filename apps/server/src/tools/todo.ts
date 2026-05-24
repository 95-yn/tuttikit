/**
 * todo_add / todo_done / todo_fail / todo_list —— agent 自维护 plan checklist。
 *
 * Manus 经验：file-system as external memory，让 agent 把活的 plan 写到文件而不是脑内。
 * 跨 turn 持久（每次 turn 开始 conductor 会把 todo 注入 system prompt 让 LLM 自查）。
 */
import { z } from 'zod';
import type { ToolSpec, ToolCtx } from '../types.js';
import { addItems, setStatus, listAll, type TodoItem } from '../core/todoFile.js';

const AddInput = z.object({
  items: z.array(z.string().min(1).max(200)).min(1).max(20).describe('要加的 todo 项；每项 ≤ 200 字'),
});
export const todoAddTool: ToolSpec<z.infer<typeof AddInput>, { added: TodoItem[] }> = {
  name: 'todo_add',
  description: '往持久 todo.md 加新项。同一对话跨 turn 持久。用于把 plan 拆成可勾的待办。',
  parameters: {
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'string' } } },
    required: ['items'],
  },
  inputSchema: AddInput,
  allowedAgents: ['conductor', 'coder'],
  async handler({ items }, ctx: ToolCtx = {}) {
    const added = await addItems(ctx.sessionId ?? '_default', items);
    return { added };
  },
};

const StatusInput = z.object({
  id: z.string().min(1).describe('todo 项 id（nanoid，6 字符；从 todo_list 拿）'),
  note: z.string().max(300).optional().describe('附注（done 时写完成产出；fail 时写失败原因）'),
});

export const todoDoneTool: ToolSpec<z.infer<typeof StatusInput>, { item: TodoItem | null }> = {
  name: 'todo_done',
  description: '把 todo 项标 done。note 可写完成产出（如 "改了 useChat.ts:42"）。',
  parameters: {
    type: 'object',
    properties: {
      id:   { type: 'string', description: 'todo 项 id' },
      note: { type: 'string', description: '完成附注' },
    },
    required: ['id'],
  },
  inputSchema: StatusInput,
  allowedAgents: ['conductor', 'coder'],
  async handler({ id, note }, ctx: ToolCtx = {}) {
    const item = await setStatus(ctx.sessionId ?? '_default', id, 'done', note);
    return { item };
  },
};

export const todoFailTool: ToolSpec<z.infer<typeof StatusInput>, { item: TodoItem | null }> = {
  name: 'todo_fail',
  description: '把 todo 项标 failed。note 写失败原因（如 "tsc error TS2322"），后续 failure_log 配合用。',
  parameters: {
    type: 'object',
    properties: {
      id:   { type: 'string', description: 'todo 项 id' },
      note: { type: 'string', description: '失败原因' },
    },
    required: ['id'],
  },
  inputSchema: StatusInput,
  allowedAgents: ['conductor', 'coder'],
  async handler({ id, note }, ctx: ToolCtx = {}) {
    const item = await setStatus(ctx.sessionId ?? '_default', id, 'failed', note);
    return { item };
  },
};

const InProgressInput = z.object({ id: z.string().min(1) });
export const todoStartTool: ToolSpec<z.infer<typeof InProgressInput>, { item: TodoItem | null }> = {
  name: 'todo_start',
  description: '把 todo 项标 in_progress（开始做这一条）。',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  inputSchema: InProgressInput,
  allowedAgents: ['conductor', 'coder'],
  async handler({ id }, ctx: ToolCtx = {}) {
    const item = await setStatus(ctx.sessionId ?? '_default', id, 'in_progress');
    return { item };
  },
};

const ListInput = z.object({});
export const todoListTool: ToolSpec<z.infer<typeof ListInput>, { items: TodoItem[] }> = {
  name: 'todo_list',
  description: '看当前 todo 全表（包括已完成 / 失败的，按时间顺序）。conductor 会在每 turn 开始把 open + 最近 5 个 done/failed 注入 system，所以多数时候不用主动调。',
  parameters: { type: 'object', properties: {} },
  inputSchema: ListInput,
  allowedAgents: ['conductor', 'coder'],
  async handler(_args, ctx: ToolCtx = {}) {
    const items = await listAll(ctx.sessionId ?? '_default');
    return { items };
  },
};
