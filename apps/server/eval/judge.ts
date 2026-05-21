/**
 * LLM-as-judge：用一个 "裁判 LLM" 给开放性答案打 0-5 分。
 *
 * 用法（在 task.yaml 里）：
 *   expect:
 *     judge_prompt: |
 *       回答必须包含：1) RAG 的定义 2) 与 fine-tuning 的区别 3) 一个真实场景
 *     judge_min_score: 3
 *
 * Runner 命中 judge_prompt 时调本模块；mock provider 或缺 API key 时跳过（视为 pass，trace 里标 deferred）。
 */
import type { LLMLike } from '../src/types.js';
import { createLLM } from '../src/llm/index.js';

const JUDGE_SYSTEM = `你是一个评测裁判，严格按 rubric 给候选答案打 0-5 分。

打分规则：
  5 = 完全满足 rubric 所有要点，准确、清晰、无误。
  4 = 基本满足，遗漏 1 个次要点 / 有 1 处可忽略的小问题。
  3 = 主要要点都有但有 1 处明显问题（事实错、漏关键点）。
  2 = 半数要点缺失 / 多处问题。
  1 = 只有 1-2 个相关碎片，质量很差。
  0 = 完全跑题 / 拒答 / 空回答。

只输出严格 JSON：{"score": 0-5 的整数, "reason": "一句话说明扣分点；满分则空字符串"}。
不要 markdown 包裹、不要代码围栏（三个反引号）、不要前后空话。`;

export interface JudgeResult {
  score: number;
  reason: string;
  /** judge 自己也可能失败（API 抖、JSON 解析挂） */
  error?: string;
  /** 用了哪个 provider 判（写报表用） */
  provider?: string;
}

let _judge: LLMLike | null = null;
function getJudge(providerName?: string): LLMLike {
  if (_judge) return _judge;
  const name = providerName || process.env.LLM_JUDGE_PROVIDER || 'mock';
  _judge = createLLM(name);
  return _judge;
}

export function isJudgeAvailable(providerName?: string): boolean {
  const name = providerName || process.env.LLM_JUDGE_PROVIDER || 'mock';
  if (name === 'mock') return false;
  return true;
}

/** 重置（测试用） */
export function resetJudge(): void { _judge = null; }

export async function judgeAnswer(args: {
  task: string;
  rubric: string;
  draft: string;
  providerName?: string;
}): Promise<JudgeResult> {
  const judge = getJudge(args.providerName);
  if (judge.name === 'mock') {
    return { score: 0, reason: '', error: 'judge provider 不可用（mock）；本轮跳过', provider: 'mock' };
  }
  try {
    const res = await judge.chat({
      system: JUDGE_SYSTEM,
      messages: [{
        role: 'user',
        content: `任务：${args.task}\n\n打分 rubric：${args.rubric}\n\n候选答案：\n${args.draft}`,
      }],
      temperature: 0,
      maxTokens: 256,
    });
    const text = (res.content || '').trim();
    const parsed = parseJudgeJSON(text);
    if (!parsed) return { score: 0, reason: '', error: `JSON 解析失败：${text.slice(0, 100)}`, provider: judge.name };
    return { ...parsed, provider: judge.name };
  } catch (err) {
    return { score: 0, reason: '', error: (err as Error).message, provider: judge.name };
  }
}

/** 容错解析裁判输出：先严格 JSON，失败回退抓 score 数字 */
function parseJudgeJSON(text: string): { score: number; reason: string } | null {
  // 去掉可能的 markdown fence
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const obj = JSON.parse(cleaned) as { score?: number; reason?: string };
    if (typeof obj.score !== 'number' || obj.score < 0 || obj.score > 5) return null;
    return { score: Math.round(obj.score), reason: String(obj.reason || '') };
  } catch { /* fallthrough */ }
  // 回退：从文本里抓 "score": N
  const m = cleaned.match(/score['"]?\s*[:=]\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const n = Math.max(0, Math.min(5, Math.round(Number(m[1]))));
    return { score: n, reason: '(JSON 解析失败，从文本回退抓 score)' };
  }
  return null;
}
