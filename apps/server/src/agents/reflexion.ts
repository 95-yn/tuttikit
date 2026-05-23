/**
 * Reflexion（W2.1 R2）：失败后让 LLM 写一段反思日志，附到下次 prompt。
 *
 * 来源：Shinn et al. 2023 "Reflexion: Language Agents with Verbal Reinforcement Learning"。
 * 经验：让 agent 用自然语言"反思上次为啥失败 + 这次该改什么"，下次成功率显著提升。
 *
 * 在 TuttiKit 里的接入：
 *   - plan-execute 的 step 失败 → re-plan 之前先调 reflect()
 *   - re-plan prompt 里附上反思日志
 *   - cheap LLM 即可（一句话反思，不需要主 model）
 */
import type { LLMLike } from '../types.js';
import { logger } from '../observability/logger.js';

const REFLECT_PROMPT = `你刚刚执行一个 step 失败了。用 2-3 句话简短反思：
1. 失败的根因是什么（不要复述 traceback）
2. 下次该如何调整方案

只输出反思正文，不要前缀。`;

export async function reflect(args: {
  llm: LLMLike;
  taskDescription: string;
  failureReason: string;
  /** 之前已经成功的 step 简要（让反思有上下文） */
  completedSummary?: string;
}): Promise<string | null> {
  if (args.llm.name === 'mock') {
    return `[mock 反思] step "${args.taskDescription.slice(0, 30)}" 失败，建议拆得更小再试`;
  }
  try {
    const res = await args.llm.chat({
      system: REFLECT_PROMPT,
      messages: [{
        role: 'user',
        content:
          `任务：${args.taskDescription}\n\n` +
          (args.completedSummary ? `已完成：${args.completedSummary}\n\n` : '') +
          `失败原因：${args.failureReason}`,
      }],
      temperature: 0.3,    // 给一点温度让反思不死板
      maxTokens: 200,
    });
    const text = (res.content || '').trim();
    return text || null;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[reflexion] LLM 失败，跳过反思');
    return null;
  }
}

/** 把反思日志格式化进 re-plan prompt */
export function formatReflectionForReplan(reflection: string): string {
  return `\n\n## 上次失败的反思\n${reflection}\n\n请在新的 plan 里避免这条问题。`;
}
