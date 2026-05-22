import { ShortTermMemory } from '../memory/shortTerm.js';
import { childLogger } from '../observability/logger.js';
import type { Logger } from 'pino';
import type {
  LLMLike, LLMCallArgs, Message, Usage,
} from '../types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { MessageBus } from '../core/messageBus.js';
import type { LongTermMemory } from '../memory/longTerm.js';
import type { Trace, Tracer } from '../observability/tracer.js';

export interface BaseAgentDeps {
  name: string;
  role?: string;
  systemPrompt?: string;
  llm: LLMLike;
  toolRegistry?: ToolRegistry;
  longTermMemory?: LongTermMemory;
  bus?: MessageBus;
  maxSteps?: number;
}

export interface RunArgs {
  input: string;
  trace: Trace;
  tracer: Tracer;
  parentSpanId?: string | null;
  stream?: boolean;
  /**
   * 主 session 的 id（来自 conductor 调 delegate 时透传过来）。
   * sub-agent 调 tool 时塞进 ToolCtx，让 hook（safety / approval）能识别归属。
   */
  sessionId?: string;
}

export interface RunResult {
  content: string;
  usage: Usage;
  steps: number;
}

/**
 * BaseAgent —— 所有具体 Agent 的父类。一次 run() = 在自己的短期记忆里跑一个 ReAct 循环。
 */
export class BaseAgent {
  name: string;
  role: string;
  systemPrompt: string;
  llm: LLMLike;
  toolRegistry?: ToolRegistry;
  longTermMemory?: LongTermMemory;
  bus?: MessageBus;
  maxSteps: number;
  memory: ShortTermMemory;
  logger: Logger;

  constructor({
    name, role, systemPrompt = '', llm, toolRegistry, longTermMemory, bus, maxSteps = 6,
  }: BaseAgentDeps) {
    this.name = name;
    this.role = role || name;
    this.systemPrompt = systemPrompt;
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this.longTermMemory = longTermMemory;
    this.bus = bus;
    this.maxSteps = maxSteps;
    this.memory = new ShortTermMemory();
    this.logger = childLogger({ agent: this.name });
  }

  /** 子类可覆盖：把长期记忆中的内容拼到 system prompt 里 */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  buildSystemPrompt(_userInput: string): string {
    return this.systemPrompt;
  }

  async run({ input, trace, tracer, parentSpanId = null, stream = false, sessionId }: RunArgs): Promise<RunResult> {
    const span = tracer.startSpan(trace, 'agent', `${this.name}.run`, { parentId: parentSpanId, input });
    this.bus?.emit('agent:start', { agent: this.name, input });
    this.logger.info({ input }, 'agent run start');

    this.memory.append({ role: 'user', content: input });
    const tools = this.toolRegistry?.specsFor(this.role) ?? [];

    let finalContent = '';
    let stepCount = 0;
    const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };

    try {
      while (stepCount < this.maxSteps) {
        stepCount += 1;
        const llmSpan = tracer.startSpan(trace, 'llm', `${this.name}.llm[${stepCount}]`, {
          parentId: span.spanId,
          provider: this.llm.name,
        });

        const callArgs: LLMCallArgs = {
          system: this.buildSystemPrompt(input),
          messages: this.memory.getAll(),
          tools,
        };

        let response;
        if (stream && this.bus) {
          response = await this.llm.stream(callArgs, (chunk) =>
            this.bus!.emit('agent:token', { agent: this.name, chunk }),
          );
        } else {
          response = await this.llm.chat(callArgs);
        }

        tracer.endSpan(trace, llmSpan, { usage: response.usage, output: response.content?.slice(0, 200) });
        totalUsage.inputTokens! += response.usage?.inputTokens || 0;
        totalUsage.outputTokens! += response.usage?.outputTokens || 0;

        const assistantMsg: Message = {
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        };
        this.memory.append(assistantMsg);

        if (!response.toolCalls?.length) {
          finalContent = response.content;
          break;
        }

        for (const call of response.toolCalls) {
          const toolSpan = tracer.startSpan(trace, 'tool', call.name, {
            parentId: span.spanId,
            input: call.input,
          });
          this.bus?.emit('tool:start', {
            agent: this.name, tool: call.name, input: call.input, toolCallId: call.id,
          });
          try {
            const result = await this.toolRegistry!.invoke(call.name, call.input, {
              agent: this.name, trace, tracer,
              parentSpanId: toolSpan.spanId,
              bus: this.bus,
              sessionId,    // 透传给 hook（safety / approval），让 sub-agent 路径的事件也归属正确 session
            });
            tracer.endSpan(trace, toolSpan, { output: truncate(result) });
            this.bus?.emit('tool:end', {
              agent: this.name, tool: call.name, result, toolCallId: call.id,
            });
            this.memory.append({
              role: 'tool',
              toolCallId: call.id,
              toolName: call.name,
              content: JSON.stringify(result),
            });
          } catch (err) {
            const e = err as Error;
            const errObj = err as { name?: string; toLLMPayload?: () => unknown; ruleName?: string; denyReason?: string };
            tracer.endSpan(trace, toolSpan, { status: 'error', error: err });
            // sub-agent 路径也可能命中 safety hook（rm -rf 通过 delegate 调到这里），
            // 区分 SafetyDeniedError / ToolInputError / 其他，让 LLM 看到结构化 payload
            if (errObj?.name === 'SafetyDeniedError') {
              this.bus?.emit('safety:denied', {
                agent: this.name, tool: call.name, toolCallId: call.id,
                rule: errObj.ruleName, reason: errObj.denyReason,
              });
              this.logger.warn(
                { agent: this.name, tool: call.name, rule: errObj.ruleName },
                '[safety] sub-agent 路径上的 tool call 被拦截',
              );
            } else {
              this.bus?.emit('tool:error', {
                agent: this.name, tool: call.name, error: e.message, toolCallId: call.id,
              });
            }
            const payload = (errObj?.name === 'SafetyDeniedError' || errObj?.name === 'ToolInputError')
              && typeof errObj.toLLMPayload === 'function'
              ? errObj.toLLMPayload()
              : { error: e.message };
            this.memory.append({
              role: 'tool',
              toolCallId: call.id,
              toolName: call.name,
              content: JSON.stringify(payload),
            });
          }
        }
      }

      if (!finalContent) {
        finalContent = '(已达最大步数，未给出最终答复)';
      }

      tracer.endSpan(trace, span, { output: finalContent.slice(0, 200), usage: totalUsage });
      this.bus?.emit('agent:end', { agent: this.name, output: finalContent, usage: totalUsage });
      this.logger.info({ usage: totalUsage, steps: stepCount }, 'agent run end');
      return { content: finalContent, usage: totalUsage, steps: stepCount };
    } catch (err) {
      const e = err as Error;
      tracer.endSpan(trace, span, { status: 'error', error: err });
      this.bus?.emit('agent:error', { agent: this.name, error: e.message });
      this.logger.error({ err }, 'agent run failed');
      throw err;
    }
  }
}

function truncate(obj: unknown, max = 300): string {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return s.length > max ? s.slice(0, max) + '…' : s;
}
