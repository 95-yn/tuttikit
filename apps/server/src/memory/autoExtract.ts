/**
 * 自动从对话提炼"重要事实"写到 LongTermMemory（W2.2 Y3）。
 *
 * 思路（参考 Letta / ChatGPT 长期记忆）：
 *   - turn 结束后跑 cheap LLM
 *   - 输入最近一轮 user + assistant 对话
 *   - 让 LLM 提取 0-3 条"用户偏好 / 长期事实 / 应该记住的东西"
 *   - 每条 dedup（向量相似度 ≥ 0.95 的合并） → longTermMemory.rememberAsync
 *
 * 触发：MEMORY_AUTO_EXTRACT=true 才开（避免每次 turn 都额外调 LLM）
 * 节流：mock provider 不跑；user 消息 < 20 字也不跑（多半是寒暄）
 */
import type { LLMLike } from '../types.js';
import type { LongTermMemory } from './longTerm.js';
import { logger } from '../observability/logger.js';

const EXTRACT_PROMPT = `从下面这轮对话里提取 0-3 条"该长期记住的事实"。
原则：
- 只提**用户的偏好 / 身份 / 长期决定 / 项目约定**这类**未来仍有用**的信息
- 不提一次性问答、寒暄、debug 过程
- 每条一行，中文，30 字以内
- 没有可提的就输出 "NONE"

格式（每行一条，最多 3 行）：
- 事实1
- 事实2

例：
- 用户偏好 TypeScript over JavaScript
- 项目用 sqlite 不用 Postgres
- 用户的 GitHub 是 95-yn`;

export interface ExtractInput {
  userMessage: string;
  assistantResponse: string;
  llm: LLMLike;
  longTermMemory: LongTermMemory;
}

export async function extractAndRemember(input: ExtractInput): Promise<{ added: number; skipped: number }> {
  if (input.llm.name === 'mock') return { added: 0, skipped: 0 };
  if (input.userMessage.trim().length < 20) return { added: 0, skipped: 0 };

  try {
    const res = await input.llm.chat({
      system: EXTRACT_PROMPT,
      messages: [{
        role: 'user',
        content: `用户：${input.userMessage.slice(0, 1500)}\n\nAssistant：${input.assistantResponse.slice(0, 1500)}`,
      }],
      temperature: 0,
      maxTokens: 200,
    });
    const text = (res.content || '').trim();
    if (!text || /^NONE\b/i.test(text)) return { added: 0, skipped: 1 };

    const facts = text
      .split('\n')
      .map((l) => l.replace(/^[-*•]\s*/, '').trim())
      .filter((l) => l.length > 4 && l.length < 100 && !/^NONE\b/i.test(l));

    let added = 0;
    for (const fact of facts.slice(0, 3)) {
      try {
        // rememberAsync 自带向量 dedup（>= 0.95 相似度合并）
        await input.longTermMemory.rememberAsync({
          text: fact,
          source: 'auto-extract',
          tags: ['preference', 'auto'],
        });
        added++;
      } catch (err) {
        logger.warn({ err: (err as Error).message, fact }, '[auto-memory] 单条 remember 失败');
      }
    }
    if (added > 0) logger.info({ added, facts }, '[auto-memory] 提取并保存');
    return { added, skipped: 0 };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[auto-memory] 提取失败，跳过');
    return { added: 0, skipped: 1 };
  }
}

/** 已知短语：常见且不该记 */
export const _SKIP_PATTERNS = ['你好', 'hi', 'hello', '谢谢', 'thx'];
