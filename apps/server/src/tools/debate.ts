/**
 * Multi-agent debate（B）：让 N 个 sub-agent 用不同 persona 各给一份答案 → judge 选 winner。
 *
 * 参考：Multi-Agent Debate (Du et al. 2023)、Society of Mind。实测对开放问题（设计权衡 /
 * 哪个方案好）能得到更平衡的答案；对单一事实问题没用（直接 fetch_and_summarize 就行）。
 *
 * 节流：
 *   - N 默认 3（最少 2 个 debater + 1 judge）；最多 5（再多就贵且 judge 也判不动）
 *   - mock provider 时退化成单 sub-agent 响应（不真 debate）
 *   - 调用方应该明白：1 次 debate ≈ N+1 次 LLM 调用
 */
import { z } from 'zod';
import type { ToolSpec, ToolCtx, LLMLike } from '../types.js';
import { createLLM } from '../llm/index.js';
import { logger } from '../observability/logger.js';

const Input = z.object({
  question: z.string().min(5).max(2000).describe('要 debate 的问题；越是"权衡 / 设计 / 哪个更好"类越合适'),
  n: z.number().int().min(2).max(5).optional().describe('debater 数量；默认 3'),
  /** 让 caller 注入特定 persona；不传 LLM 自己生成 N 个不同立场 */
  personas: z.array(z.string().max(200)).optional(),
});

interface Reply {
  persona: string;
  answer: string;
}

const DEBATER_PROMPT = (persona: string): string => `你是一个 debater，立场：${persona}

按你的立场对用户问题给出 100-200 字的清晰答案。强调你这一派的核心论点，不要骑墙。
直接输出答案正文，不要前缀。`;

const JUDGE_PROMPT = `下面 N 个 debater 对同一个问题给出不同答案。你是 judge：

1. 综合各方观点，给出 200-300 字最终答复
2. 明确指出你**采纳了哪几个 debater 的核心观点**（编号）
3. 如果某个 debater 明显错了，简要说明并排除

输出格式：
最终答复：<200-300 字>

采纳：debater #1 / #3 的核心
排除：debater #2（理由：xxx）`;

async function debater(llm: LLMLike, question: string, persona: string): Promise<Reply> {
  if (llm.name === 'mock') {
    return { persona, answer: `[mock ${persona}] 关于"${question.slice(0, 30)}"，我的立场是 ${persona}` };
  }
  const res = await llm.chat({
    system: DEBATER_PROMPT(persona),
    messages: [{ role: 'user', content: question }],
    temperature: 0.6,    // 给点温度让答案有差异
    maxTokens: 400,
  });
  return { persona, answer: (res.content || '').trim() };
}

const DEFAULT_PERSONAS = [
  '激进派：优先创新和速度，可以容忍 30% 风险',
  '保守派：优先稳定和可维护性，反对未经验证的方案',
  '工程实用派：只看 ROI 和落地难度，理论先放一边',
  '架构师：长期视角，看十年后的兼容性',
  '用户视角：只看用户体感，不在乎技术细节',
];

export const debateTool: ToolSpec<
  z.infer<typeof Input>,
  { winner: string; replies: Reply[]; judgeReasoning: string }
> = {
  name: 'debate',
  description:
    '让 N 个不同 persona 的 sub-agent 对同一问题各给答案，再由 judge sub-agent 选 / 综合 winner。\n' +
    '适用：开放权衡题（哪个方案好？该选 A 还是 B？）。**不适用**单一事实题（直接 web_search 就行）。\n' +
    '代价：1 次 debate ≈ N+1 次 LLM 调用，比直接答贵 N 倍。\n' +
    '默认 N=3，最多 5。',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要 debate 的问题' },
      n:        { type: 'integer', description: 'debater 数量（默认 3）' },
      personas: { type: 'array', items: { type: 'string' }, description: '自定义 persona' },
    },
    required: ['question'],
  },
  inputSchema: Input,
  allowedAgents: ['conductor'],
  async handler({ question, n, personas }, ctx: ToolCtx = {}) {
    void ctx;
    const count = n ?? 3;
    const list = personas?.length ? personas.slice(0, count) : DEFAULT_PERSONAS.slice(0, count);
    const llm = createLLM();

    // mock 短路（避免真 spawn N 次 mock 没意义的回答）
    if (llm.name === 'mock') {
      const replies = list.map((p) => ({ persona: p, answer: `[mock ${p}] 关于"${question.slice(0, 30)}"...` }));
      return { winner: `[mock] judge 综合 ${replies.length} 派`, replies, judgeReasoning: '[mock]' };
    }

    // 并发 debate
    const replies = await Promise.all(list.map((p) => debater(llm, question, p).catch((err) => ({
      persona: p, answer: `(debater 失败：${(err as Error).message})`,
    }))));

    // judge
    let judgeOut: { content: string };
    try {
      const judgeInput = replies.map((r, i) => `[debater #${i + 1} ${r.persona}]\n${r.answer}`).join('\n\n');
      judgeOut = await llm.chat({
        system: JUDGE_PROMPT,
        messages: [{ role: 'user', content: `问题：${question}\n\n${judgeInput}` }],
        temperature: 0,
        maxTokens: 600,
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[debate] judge 失败，退最长答案');
      const longest = replies.reduce((a, b) => a.answer.length > b.answer.length ? a : b);
      return { winner: longest.answer, replies, judgeReasoning: `(judge 失败：${(err as Error).message})` };
    }

    const judgeText = (judgeOut.content || '').trim();
    // 简单切分：「最终答复：xxx」前的为 winner、后的为 reasoning
    const winnerMatch = judgeText.match(/最终答复[：:]\s*([\s\S]+?)(?:\n\n|采纳[：:])/);
    const winner = winnerMatch ? winnerMatch[1].trim() : judgeText.split('\n\n')[0];
    return { winner, replies, judgeReasoning: judgeText };
  },
};
