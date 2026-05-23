import { childLogger } from '../observability/logger.js';
import { buildConductorPrompt } from '../prompts/index.js';
import { skillsLoader } from '../skills/index.js';
import { budgetGuard, BudgetExceededError } from '../core/budget.js';
import { drainer } from '../core/drain.js';
import { config } from '../config.js';
import { SELF_CRITIQUE_PROMPT } from '../prompts/selfCritique.js';
import { planTask, renderPlanForConductor, shouldPlan, type Plan } from './planner.js';
import { planExecuteSteps } from './planExecute.js';
import { compactIfNeeded, persistCompact, recallRelevant, formatRecalled } from '../core/sessionCompact.js';
import { CitationCollector, CITATION_INSTRUCTION } from '../core/citation.js';
import { extractAndRemember } from '../memory/autoExtract.js';
import { longTermMemory } from '../memory/longTerm.js';
import { contextWindowOf } from '../llm/contextWindow.js';
import { redactSecrets } from '../core/redact.js';
import type { Logger } from 'pino';
import type {
  LLMLike, Message, Usage, Attachment,
} from '../types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SessionManager } from '../core/session.js';
import type { MessageBus } from '../core/messageBus.js';
import type { Trace, Tracer, Span } from '../observability/tracer.js';

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
  /** 外部可注入的取消 signal（HTTP 客户端断开 / 用户主动 stop）；本 turn 内的 tool 调用会一起 abort */
  signal?: AbortSignal;
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

  constructor({ llm, toolRegistry, sessionManager, bus, maxSteps = 20 }: ConductorDeps) {
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this.sessionManager = sessionManager;
    this.bus = bus;
    this.maxSteps = maxSteps;
    this.systemPrompt = buildConductorPrompt() + skillsHint();
    this.logger = childLogger({ agent: this.name });
  }

  async respond({
    sessionId, userMessage, attachments = [], stream = true, trace, tracer, signal,
  }: RespondArgs): Promise<{ usage: Usage; steps: number }> {
    // 本 turn 的 abort 控制器：外部 signal 转发进来，下游 tool ctx 共享
    const ac = new AbortController();
    const onExternal = (): void => ac.abort(new Error('turn cancelled'));
    if (signal) {
      if (signal.aborted) ac.abort(signal.reason ?? new Error('turn cancelled'));
      else signal.addEventListener('abort', onExternal, { once: true });
    }
    // turn 结束时 detach 外部监听
    const cleanupSignal = (): void => {
      if (signal) signal.removeEventListener('abort', onExternal);
    };
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
    const stepCounter = { value: 0 };
    const critiqueDoneRef = { value: false };        // self-critique 只跑一次，防死循环

    // 预算守卫：超额抛 BudgetExceededError，外层 catch 会转 turn:error。
    // 注意：drainer.enter() 必须放在 budget 通过之后，否则被拦的请求也会算 in-flight。
    try {
      budgetGuard.beforeTurn(sessionId);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        tracer.endSpan(trace, span, { status: 'error', error: err });
        this.bus?.emit('turn:error', { sessionId, error: err.message });
        this.logger.warn({ err: err.message }, 'turn blocked by budget');
        throw err;
      }
      throw err;
    }

    drainer.enter();

    // ────── 上下文管理（C+D） ──────
    // C: 估算当前 session 是否要压缩，超阈值就把老消息批量摘要 + 全文进 archive
    // D: 把当前 user query 拿去 archive 做 RAG 召回，相关历史片段拼回 system prompt
    //   两者都跑在 plan / react 之前，让后续走压缩后的 session
    let recalledBlock = '';
    // citations per turn：tools / RAG 注册的 source 都进这个 pool，turn 结束写到 meta
    const citations = new CitationCollector();
    try {
      const modelForCtx = (this.llm as { model?: { modelId?: string } }).model?.modelId
        || (config.llm as unknown as Record<string, { model?: string }>)[this.llm.name]?.model
        || this.llm.name;
      const ctxWindow = contextWindowOf(this.llm.name, modelForCtx);
      const result = await compactIfNeeded({
        sessionId, contextWindow: ctxWindow, llm: this.llm,
      });
      if (result.triggered) {
        await persistCompact(sessionId, result);
        this.bus?.emit('context:compacted', {
          sessionId,
          beforeTokens: result.beforeTokens,
          afterTokens: result.afterTokens,
          archivedCount: result.archivedCount,
          summariesCreated: result.summariesCreated,
          ratio: ctxWindow > 0 ? result.beforeTokens / ctxWindow : 0,
        });
        this.logger.info(
          { sessionId, beforeTokens: result.beforeTokens, afterTokens: result.afterTokens, archived: result.archivedCount },
          '[compact] 触发上下文压缩',
        );
      }
      // RAG 召回（archive 非空时才有意义）；同时 register 到 citations 让 LLM 能引用
      const recalled = await recallRelevant({ sessionId, query: userMessage });
      if (recalled.length > 0) {
        recalledBlock = '\n\n' + formatRecalled(recalled, citations);
        this.bus?.emit('context:recalled', { sessionId, count: recalled.length });
      }
    } catch (err) {
      // compact / recall 任一失败都不应该让对话挂掉；记 warn 让对话继续走原始 messages
      this.logger.warn({ err: (err as Error).message }, '[compact/recall] 失败，跳过');
    }
    // 有 source 才加 citation instruction，避免空池子也教 LLM 引用（它会瞎标）
    const citationBlock = citations.size() > 0 ? CITATION_INSTRUCTION : '';

    // Plan-and-Execute V1：先调 planner 拿 steps，把计划渲染进 system，让 ReAct 按计划走。
    // 启发式（shouldPlan）过滤短任务，避免每个 "你好" 都烧一次 planner。
    let plan: Plan | null = null;
    // 注意：recalledBlock 拼在 system prompt **尾部**，前缀部分保持稳定让 Anthropic prompt cache 命中（Manus / Claude Code 经验）
    let augmentedSystem = this.systemPrompt + recalledBlock + citationBlock;
    if (config.agent.planAndExecute && shouldPlan(userMessage)) {
      const planSpan = tracer.startSpan(trace, 'llm', 'conductor.plan', { parentId: span.spanId });
      try {
        plan = await planTask(this.llm, userMessage);
        if (plan) {
          augmentedSystem = this.systemPrompt + renderPlanForConductor(plan);
          tracer.endSpan(trace, planSpan, { output: `${plan.steps.length} steps` });
          this.bus?.emit('plan:created', { sessionId, plan });
          this.logger.info({ sessionId, steps: plan.steps.length }, '[plan] planner 返回 plan');
        } else {
          tracer.endSpan(trace, planSpan, { status: 'error', error: 'planner returned null' });
        }
      } catch (err) {
        tracer.endSpan(trace, planSpan, { status: 'error', error: err });
        this.logger.warn({ err }, '[plan] planner 异常，回退纯 ReAct');
      }
    }

    try {
      // V2 显式步骤模式 vs V1 plan-aware ReAct 一次跑完
      if (plan && config.agent.planExplicitSteps) {
        // V2 逻辑抽到 agents/planExecute.ts；conductor 注入 _runReactSteps 作为回调
        await planExecuteSteps(
          {
            llm: this.llm,
            sessionManager: this.sessionManager,
            bus: this.bus,
            logger: this.logger,
            runReactSteps: (a) => this._runReactSteps(a),
          },
          {
            plan, sessionId, augmentedSystem: this.systemPrompt + recalledBlock + citationBlock,   // V2 不注入 plan 进 system
            tools, span, trace, tracer, stream,
            totalUsage, stepCounter,
            userMessage,
            signal: ac.signal,
          },
        );
      } else {
        // V1 / 无 plan：原始 while-loop（含 self-critique）
        await this._runReactSteps({
          sessionId, augmentedSystem,
          tools, span, trace, tracer, stream,
          totalUsage, stepCounter,
          maxSteps: this.maxSteps,
          userMessage,
          allowCritique: true,
          critiqueDoneRef,
          signal: ac.signal,
          citations,
        });
      }

      // Auto-review：本轮如果写了代码文件，emit 一个事件，UI 可据此提示用户「需要 review 一下吗？」
      if (config.agent.autoReviewCode) {
        const codeFiles = this._extractCodeWrites(trace);
        if (codeFiles.length > 0) {
          this.bus?.emit('review:needed', { sessionId, files: codeFiles });
          this.logger.info({ sessionId, files: codeFiles }, '[auto-review] 写了代码文件，建议人工/Reviewer 审查');
        }
      }

      // 累加预算 + 阈值警告
      const modelName = (this.llm as { model?: { modelId?: string } }).model?.modelId
        || (this.llm as { name?: string }).name
        || 'unknown';
      const budget = budgetGuard.afterTurn(sessionId, totalUsage, this.llm.name, modelName);
      if (budget.warn) {
        this.bus?.emit('budget:warn', budget.warn);
      }
      tracer.endSpan(trace, span, { usage: totalUsage });
      // citations 写到最后一条 assistant 消息的 meta（前端拿来渲染 footnote）
      if (citations.size() > 0) {
        const sess = await this.sessionManager.get(sessionId);
        const lastAssistant = sess?.messages.slice().reverse().find((m) => m.role === 'assistant');
        if (lastAssistant) {
          lastAssistant.meta = { ...lastAssistant.meta, citations: citations.export() };
          if (sess) await this.sessionManager.replace(sess);
        }
      }
      this.bus?.emit('turn:done', {
        sessionId, usage: totalUsage, steps: stepCounter.value,
        turnUSD: budget.turnUSD, sessionUSD: budget.sessionUSD,
        citations: citations.export(),
      });
      this.logger.info(
        { sessionId, steps: stepCounter.value, usage: totalUsage, turnUSD: budget.turnUSD, sessionUSD: budget.sessionUSD },
        'turn done',
      );
      // 自动 long-term memory 提取（W2.2 Y3）：fire-and-forget，不阻塞响应
      if (process.env.MEMORY_AUTO_EXTRACT === 'true') {
        const finalAssistant = (await this.sessionManager.get(sessionId))?.messages
          .slice().reverse().find((m) => m.role === 'assistant');
        if (finalAssistant?.content) {
          void extractAndRemember({
            userMessage, assistantResponse: finalAssistant.content,
            llm: this.llm, longTermMemory,
          }).then((r) => {
            if (r.added > 0) this.bus?.emit('memory:auto-saved', { sessionId, count: r.added });
          }).catch((err) => this.logger.warn({ err: (err as Error).message }, '[auto-memory] fire-and-forget 失败'));
        }
      }
      return { usage: totalUsage, steps: stepCounter.value };
    } catch (err) {
      const e = err as Error;
      tracer.endSpan(trace, span, { status: 'error', error: err });
      this.bus?.emit('turn:error', { sessionId, error: e.message });
      this.logger.error({ err }, 'turn failed');
      throw err;
    } finally {
      drainer.exit();
      cleanupSignal();
    }
  }

  /**
   * 抽出来的「ReAct N 步循环」：跑直到 assistant 不再调工具、或本次 budget 用尽。
   * 由 V1 / 无 plan 路径调用一次；由 V2 路径在每个 step 内分别调用（小 budget）。
   *
   * stepCounter 在调用方共享（用来给 assistantId 编号 + 报到全局 turn 步数）。
   * critiqueDoneRef 一个会话只 critique 一次（V2 模式下也只在最后聚合阶段算一次）。
   */
  private async _runReactSteps(args: {
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
    citations?: CitationCollector;
  }): Promise<{ finalContent: string }> {
    const {
      sessionId, augmentedSystem, tools, span, trace, tracer, stream,
      totalUsage, stepCounter, maxSteps, userMessage, allowCritique, critiqueDoneRef, signal,
      citations,
    } = args;
    let finalContent = '';
    let stepsTaken = 0;

    while (stepsTaken < maxSteps) {
      if (signal?.aborted) throw signal.reason ?? new Error('turn cancelled');
      stepsTaken += 1;
      stepCounter.value += 1;
      const myStep = stepCounter.value;

      const session = await this.sessionManager.get(sessionId);
      if (!session) throw new Error(`session ${sessionId} 消失`);
      const messages = stripMeta(session.messages);

      const llmSpan = tracer.startSpan(trace, 'llm', `conductor.llm[${myStep}]`, {
        parentId: span.spanId,
        provider: this.llm.name,
      });

      const assistantId = `m_${Date.now()}_${myStep}`;
      this.bus?.emit('message:start', { sessionId, id: assistantId, role: 'assistant' });

      const callArgs = { system: augmentedSystem, messages, tools };
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

      if (!response.toolCalls?.length) {
        finalContent = response.content || '';
        // self-critique（仅当允许 + 没用过）
        if (allowCritique && !critiqueDoneRef.value && stepsTaken < maxSteps && finalContent.trim()) {
          const critique = await this._critique(userMessage, finalContent, trace, tracer, span.spanId);
          if (critique && critique.startsWith('REVISE:')) {
            this.bus?.emit('critique:revise', { sessionId, critique });
            await this.sessionManager.appendMessage(sessionId, {
              role: 'user',
              content: `[内部审校建议]\n${critique}\n\n请按上面的建议修订你刚才的答复。`,
              meta: { createdAt: Date.now(), critique: true },
            });
            critiqueDoneRef.value = true;
            continue;
          }
          this.bus?.emit('critique:ok', { sessionId });
        }
        break;
      }

      // 执行 tools
      for (const call of response.toolCalls) {
        const toolSpan = tracer.startSpan(trace, 'tool', call.name, {
          parentId: span.spanId, input: call.input,
        });
        this.bus?.emit('tool:start', {
          sessionId, toolCallId: call.id, name: call.name, input: call.input,
        });
        let toolContent: string;
        try {
          // hook 现在统一在 ToolRegistry.invoke 内部跑（让 sub-agent 路径也受保护）。
          // 命中 deny 会抛 SafetyDeniedError，下面 catch 转结构化 tool_result 给 LLM。
          const result = await this.toolRegistry.invoke(call.name, call.input, {
            agent: this.name, trace, tracer,
            parentSpanId: toolSpan.spanId,
            bus: this.bus,
            signal,
            sessionId,
            citations,
          });
          tracer.endSpan(trace, toolSpan, { output: truncate(result) });
          this.bus?.emit('tool:end', { sessionId, toolCallId: call.id, name: call.name, result });
          toolContent = JSON.stringify(result);
        } catch (err) {
          const e = err as Error;
          const errObj = err as { name?: string; toLLMPayload?: () => unknown; ruleName?: string; denyReason?: string };
          tracer.endSpan(trace, toolSpan, { status: 'error', error: err });
          // 区分三种错误：safety 拦截 / 输入校验失败 / 其他运行时错
          if (errObj?.name === 'SafetyDeniedError') {
            this.bus?.emit('safety:denied', {
              sessionId, toolCallId: call.id, name: call.name,
              rule: errObj.ruleName, reason: errObj.denyReason,
              input: redactSecrets(call.input),
            });
            this.logger.warn(
              { sessionId, tool: call.name, rule: errObj.ruleName },
              '[safety] 拦截危险 tool call',
            );
            toolContent = JSON.stringify(errObj.toLLMPayload!());
          } else if (errObj?.name === 'ToolInputError' && typeof errObj.toLLMPayload === 'function') {
            this.bus?.emit('tool:error', { sessionId, toolCallId: call.id, name: call.name, error: e.message });
            toolContent = JSON.stringify(errObj.toLLMPayload());
          } else {
            this.bus?.emit('tool:error', { sessionId, toolCallId: call.id, name: call.name, error: e.message });
            toolContent = JSON.stringify({ error: e.message });
          }
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
    return { finalContent };
  }


  /**
   * 扫 trace 找写代码文件的 file_system_write 调用，返回相对路径列表。
   * 用于 auto-review hook。
   */
  private _extractCodeWrites(trace: Trace): string[] {
    const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cpp|h|hpp|cs|rb|php|swift|kt|scala)$/i;
    const out: string[] = [];
    for (const sp of trace.spans) {
      if (sp.kind !== 'tool' || sp.name !== 'file_system_write') continue;
      const input = sp.attrs.input as { path?: string } | undefined;
      const p = input?.path;
      if (p && CODE_EXT.test(p)) out.push(p);
    }
    return Array.from(new Set(out));
  }

  /**
   * 用同 LLM 跑一次轻量审校，输出 "OK" 或 "REVISE: ..."。
   * 默认不开（config.agent.selfCritique=true 才启用）。
   */
  private async _critique(
    userMessage: string,
    draft: string,
    trace: Trace,
    tracer: Tracer,
    parentSpanId: string,
  ): Promise<string | null> {
    const critiqueSpan = tracer.startSpan(trace, 'llm', 'conductor.critique', { parentId: parentSpanId });
    try {
      const res = await this.llm.chat({
        system: SELF_CRITIQUE_PROMPT,
        messages: [
          { role: 'user', content: `任务：${userMessage}\n\n草稿：${draft}` },
        ],
        temperature: 0,
        maxTokens: 256,
      });
      tracer.endSpan(trace, critiqueSpan, {
        usage: res.usage,
        output: res.content?.slice(0, 200),
      });
      return (res.content || '').trim();
    } catch (err) {
      tracer.endSpan(trace, critiqueSpan, { status: 'error', error: err });
      this.logger.warn({ err }, '[critique] LLM 调用失败，跳过审校');
      return null;
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
