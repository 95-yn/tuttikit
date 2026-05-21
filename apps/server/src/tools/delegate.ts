import { z } from 'zod';
import type { ToolSpec, ToolCtx } from '../types.js';
import type { Trace, Tracer } from '../observability/tracer.js';

const DelegateInputSchema = z.object({
  goal: z.string().min(1, 'goal 不能为空'),
  context: z.string().optional(),
});

/**
 * Agent as Tool —— 把一个子 Agent 包装成 Conductor 可调用的工具。
 */
export interface SubAgentLike {
  name: string;
  run: (args: {
    input: string;
    trace: Trace;
    tracer: Tracer;
    parentSpanId?: string | null;
    stream?: boolean;
  }) => Promise<{ content: string; usage: { inputTokens?: number; outputTokens?: number } }>;
}

export interface LongTermMemoryLike {
  remember: (input: { tags: string[]; text: string; source: string }) => unknown;
}

export interface MakeDelegateOpts {
  name: string;
  agent: SubAgentLike;
  description: string;
  longTermMemory?: LongTermMemoryLike;
  persistTagFn?: (input: string) => string[];
}

export interface DelegateInput {
  goal: string;
  context?: string;
}

export interface DelegateOutput {
  agent: string;
  result: string;
  usage: { inputTokens?: number; outputTokens?: number };
}

export function makeDelegateTool({
  name, agent, description, longTermMemory, persistTagFn,
}: MakeDelegateOpts): ToolSpec<DelegateInput, DelegateOutput> {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: '让该子 Agent 完成的具体目标，要尽量自包含（不要依赖主 Agent 的隐性上下文）',
        },
        context: {
          type: 'string',
          description: '相关背景信息（可选）：上游产出、已知约束等',
        },
      },
      required: ['goal'],
    },
    inputSchema: DelegateInputSchema,
    allowedAgents: [],
    handler: async ({ goal, context }, ctx: ToolCtx = {}) => {
      const input = context ? `${goal}\n\n参考背景：\n${context}` : goal;
      const { trace, tracer, parentSpanId, bus } = ctx;
      if (!trace || !tracer) throw new Error('delegate tool 需要 trace/tracer 上下文');
      const result = await agent.run({
        input,
        trace: trace as Trace,
        tracer: tracer as Tracer,
        parentSpanId: (parentSpanId ?? null) as string | null,
        stream: false,
      });

      if (longTermMemory && persistTagFn) {
        try {
          longTermMemory.remember({
            tags: persistTagFn(input),
            text: result.content,
            source: agent.name,
          });
        } catch { /* 沉淀失败不影响主流程 */ }
      }

      bus?.emit('delegate:done', { agent: agent.name, summary: result.content.slice(0, 200) });

      return { agent: agent.name, result: result.content, usage: result.usage };
    },
  };
}
