/**
 * Model routing（W1.2 Y2）：根据 user message 复杂度自动选 model。
 *
 * 思路：
 *   1. 拿一个最便宜的 LLM（haiku / deepseek-chat / mock）跑一句话分类：low / medium / high
 *   2. 映射到具体 provider：low → 便宜（haiku / mock），medium → 主 provider，high → 旗舰
 *   3. caller 拿到对应 LLM 实例直接用
 *
 * 节流：分类调用本身要钱（虽然 haiku 几乎免费）。所以提供 quick heuristic：
 *   - 短消息 + 含问候词 → 直接 low，不调 LLM
 *   - 含 "写代码 / 设计 / debug" 等关键词 → 直接 high
 *   - 介于中间才调 LLM 分类
 *
 * 这样大多数请求免分类开销。
 */
import { config } from '../config.js';
import { createLLM } from './index.js';
import { logger } from '../observability/logger.js';
import type { LLMLike } from '../types.js';

export type Complexity = 'low' | 'medium' | 'high';

/** 复杂度 → provider 名（env 可覆盖；为空走 config.llm.provider） */
const COMPLEXITY_PRESETS: Record<Complexity, string> = {
  low:    process.env.ROUTER_LOW    || 'mock',
  medium: process.env.ROUTER_MEDIUM || '',
  high:   process.env.ROUTER_HIGH   || '',
};

const HIGH_KEYWORDS = [
  '写代码', '实现', '设计', '架构', '重构', '优化', 'debug', 'refactor',
  '分析', '比较', '评估', '为什么', 'why', 'design', 'analy',
  '多步', '规划', '拆解', '复杂',
];
const LOW_KEYWORDS = ['你好', 'hi', 'hello', '谢谢', 'thx', '好的', 'ok', '继续'];

/** 启发式：无法判断时返回 null（caller 应调 LLM 兜底） */
export function quickClassify(message: string): Complexity | null {
  const m = message.toLowerCase().trim();
  if (m.length === 0) return 'low';
  if (m.length < 80 && LOW_KEYWORDS.some((k) => m.includes(k.toLowerCase()))) return 'low';
  if (HIGH_KEYWORDS.some((k) => m.includes(k.toLowerCase()))) return 'high';
  if (m.includes('```') || /\bcode\b|\bbug\b/.test(m)) return 'high';
  if (m.length < 40) return 'low';
  return null;
}

const CLASSIFY_PROMPT = `判断下面这个用户请求的复杂度，只回三个字母之一：

low    = 简单问候 / 单句问答 / 不需要工具就能答
medium = 需要 1-2 个工具或多步思考
high   = 涉及代码 / 多步规划 / 深度分析 / 写文档

只回一个单词 low / medium / high，不要解释。`;

/** LLM 兜底分类（quick 没命中时调） */
export async function classifyWithLLM(message: string, classifier?: LLMLike): Promise<Complexity> {
  const llm = classifier ?? createLLM();
  if (llm.name === 'mock') return 'medium';
  try {
    const res = await llm.chat({
      system: CLASSIFY_PROMPT,
      messages: [{ role: 'user', content: message.slice(0, 1000) }],
      temperature: 0,
      maxTokens: 5,
    });
    const text = (res.content || '').toLowerCase().trim();
    if (text.startsWith('low')) return 'low';
    if (text.startsWith('high')) return 'high';
    if (text.startsWith('medium')) return 'medium';
    logger.warn({ text }, '[router] 分类输出意外，退 medium');
    return 'medium';
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[router] 分类失败，退 medium');
    return 'medium';
  }
}

export async function routeForMessage(message: string): Promise<{ llm: LLMLike; complexity: Complexity; provider: string }> {
  let complexity = quickClassify(message);
  if (!complexity) complexity = await classifyWithLLM(message);
  const provider = COMPLEXITY_PRESETS[complexity] || config.llm.provider;
  const llm = createLLM(provider);
  logger.info({ complexity, provider, msgLen: message.length }, '[router] 路由');
  return { llm, complexity, provider };
}
