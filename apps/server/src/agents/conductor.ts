import { childLogger } from '../observability/logger.js';
import { buildConductorPrompt } from '../prompts/index.js';
import { skillsLoader } from '../skills/index.js';
import type { Logger } from 'pino';
import type {
  LLMLike, Message, Usage, Attachment,
} from '../types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SessionManager } from '../core/session.js';
import type { MessageBus } from '../core/messageBus.js';
import type { Trace, Tracer } from '../observability/tracer.js';

export interface ConductorDeps {
  llm: LLMLike;
  toolRegistry: ToolRegistry;
  sessionManager: SessionManager;
  bus?: MessageBus;
  maxSteps?: number;
}

export interface RespondArgs {
  sessionId: string;
  userMessage: string;
  attachments?: Attachment[];
  stream?: boolean;
  trace: Trace;
  tracer: Tracer;
}

/**
 * ConductorAgent —— 主对话 Agent。
 * 每次 respond() 把 user message append 到 session，然后跑 ReAct 循环。
 */
export class ConductorAgent {
  name = 'conductor';
  role = 'conductor';
  llm: LLMLike;
  toolRegistry: ToolRegistry;
  sessionManager: SessionManager;
  bus?: MessageBus;
  maxSteps: number;
  systemPrompt: string;
  logger: Logger;

  constructor({ llm, toolRegistry, sessionManager, bus, maxSteps = 10 }: ConductorDeps) {
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this.sessionManager = sessionManager;
    this.bus = bus;
    this.maxSteps = maxSteps;
    this.systemPrompt = buildConductorPrompt() + skillsHint();
    this.logger = childLogger({ agent: this.name });
  }

  async respond({
    sessionId, userMessage, attachments = [], stream = true, trace, tracer,
  }: RespondArgs): Promise<{ usage: Usage; steps: number }> {
    await this.sessionManager.appendMessage(sessionId, {
      role: 'user',
      content: userMessage,
      attachments: attachments.length ? attachments : undefined,
      meta: { createdAt: Date.now() },
    });
    this.bus?.emit('message:user', { sessionId, content: userMessage, attachments });

    const span = tracer.startSpan(trace, 'agent', 'conductor.respond', { sessionId });
    const tools = this.toolRegistry.specsFor(this.role);
    const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stepCount = 0;

    try {
      while (stepCount < this.maxSteps) {
        stepCount += 1;

        const session = await this.sessionManager.get(sessionId);
        if (!session) throw new Error(`session ${sessionId} 消失`);
        const messages = stripMeta(session.messages);

        const llmSpan = tracer.startSpan(trace, 'llm', `conductor.llm[${stepCount}]`, {
          parentId: span.spanId,
          provider: this.llm.name,
        });

        const assistantId = `m_${Date.now()}_${stepCount}`;
        this.bus?.emit('message:start', { sessionId, id: assistantId, role: 'assistant' });

        const callArgs = { system: this.systemPrompt, messages, tools };

        const response = stream
          ? await this.llm.stream(callArgs, (chunk) =>
              this.bus?.emit('message:token', { sessionId, id: assistantId, chunk }))
          : await this.llm.chat(callArgs);

        tracer.endSpan(trace, llmSpan, {
          usage: response.usage,
          output: response.content?.slice(0, 200),
        });
        totalUsage.inputTokens! += response.usage?.inputTokens || 0;
        totalUsage.outputTokens! += response.usage?.outputTokens || 0;

        await this.sessionManager.appendMessage(sessionId, {
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
          meta: { id: assistantId, createdAt: Date.now(), usage: response.usage },
        });
        this.bus?.emit('message:end', {
          sessionId, id: assistantId,
          content: response.content,
          toolCalls: response.toolCalls,
          usage: response.usage,
        });

        if (!response.toolCalls?.length) break;

        for (const call of response.toolCalls) {
          const toolSpan = tracer.startSpan(trace, 'tool', call.name, {
            parentId: span.spanId, input: call.input,
          });
          this.bus?.emit('tool:start', {
            sessionId, toolCallId: call.id, name: call.name, input: call.input,
          });

          let toolContent: string;
          try {
            const result = await this.toolRegistry.invoke(call.name, call.input, {
              agent: this.name, trace, tracer,
              parentSpanId: toolSpan.spanId,
              bus: this.bus,
            });
            tracer.endSpan(trace, toolSpan, { output: truncate(result) });
            this.bus?.emit('tool:end', { sessionId, toolCallId: call.id, name: call.name, result });
            toolContent = JSON.stringify(result);
          } catch (err) {
            const e = err as Error;
            tracer.endSpan(trace, toolSpan, { status: 'error', error: err });
            this.bus?.emit('tool:error', {
              sessionId, toolCallId: call.id, name: call.name, error: e.message,
            });
            toolContent = JSON.stringify({ error: e.message });
          }

          await this.sessionManager.appendMessage(sessionId, {
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: toolContent,
            meta: { createdAt: Date.now() },
          });
        }
      }

      tracer.endSpan(trace, span, { usage: totalUsage });
      this.bus?.emit('turn:done', { sessionId, usage: totalUsage, steps: stepCount });
      this.logger.info({ sessionId, steps: stepCount, usage: totalUsage }, 'turn done');
      return { usage: totalUsage, steps: stepCount };
    } catch (err) {
      const e = err as Error;
      tracer.endSpan(trace, span, { status: 'error', error: err });
      this.bus?.emit('turn:error', { sessionId, error: e.message });
      this.logger.error({ err }, 'turn failed');
      throw err;
    }
  }
}

function stripMeta(messages: Message[]): Message[] {
  return messages.map(({ meta: _meta, ...rest }) => rest);
}

function truncate(obj: unknown, max = 300): string {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 启动时把所有可用 Skill 的 name 拼到 system prompt 末尾（只名字省 token）。
 * 模型看到名单后，若觉得相关就调 find_skills/invoke_skill 拉正文。
 */
function skillsHint(): string {
  const skills = skillsLoader.list();
  if (!skills.length) return '';
  const names = skills.map((s) => `\`${s.name}\``).join('、');
  return `\n\n## 可用 Skills（共 ${skills.length} 个）\n` +
    `${names}\n\n` +
    '若任务匹配某个 Skill 的领域，用 `find_skills(query)` 查描述，再 `invoke_skill(name)` 加载正文按其中指引执行。';
}
