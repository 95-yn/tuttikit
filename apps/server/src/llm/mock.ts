import { BaseLLM } from './base.js';
import type { LLMCallArgs, LLMResponse, LLMOnDelta, ToolCall } from '../types.js';

/**
 * Mock Provider — 不依赖外部 API，剧本化回复，给离线 demo 与单测用。
 */
export class MockProvider extends BaseLLM {
  private _callCounter: Map<string, number>;
  constructor() {
    super('mock');
    this._callCounter = new Map();
  }

  private _role(system = ''): string {
    if (/^你是\s*Conductor/i.test(system) || /Conductor[，,]\s*一个智能助手/i.test(system)) return 'conductor';
    const m = system.match(/你是\s*(Researcher|Coder|Reviewer)\s*Agent/i);
    if (m) return m[1].toLowerCase();
    return 'generic';
  }

  private _count(role: string): number {
    const n = (this._callCounter.get(role) || 0) + 1;
    this._callCounter.set(role, n);
    return n;
  }

  private _hasToolResultInHistory(messages: LLMCallArgs['messages']): boolean {
    return messages.some((m) => m.role === 'tool');
  }

  async chat({ system, messages, tools }: LLMCallArgs): Promise<LLMResponse> {
    const role = this._role(system);
    const userText = String(
      [...messages].reverse().find((m) => m.role === 'user')?.content || '',
    );
    const turn = this._count(role);
    const toolNames = (tools || []).map((t) => t.name);

    if (role === 'conductor') {
      const text = userText;
      const looksMath = /[\d.]+\s*[\+\-\*\/]\s*[\d.]+/.test(text);
      const looksResearch = /(调研|研究|什么是|介绍|对比|原理)/.test(text);
      const looksWriteFile = /(写|生成|创建|新建|放到).{0,15}(文件|\.md|\.txt|\.json|\.js|\.py)/.test(text)
        || /(?:^|\s)\.\/?[\w\-/]+\.(md|txt|json|js|py)/.test(text);
      const hasToolResult = this._hasToolResultInHistory(messages);

      if (hasToolResult) {
        return mockReply(
          `好的，我已经完成了相关工作。\n\n根据上游工具/子 Agent 的产出，给你最终答复（mock 模式下为模板化结果）。`,
        );
      }
      if (looksMath) {
        return mockReply('我来用计算器算一下。', [
          { id: `call_${turn}`, name: 'calculator', input: { expression: extractExpr(text) } },
        ]);
      }
      if (looksResearch && looksWriteFile && toolNames.includes('delegate_to_researcher')) {
        return mockReply(
          '这个任务需要先调研、再落地到文件，我会依次委派给两个子 Agent。',
          [{ id: `call_${turn}_a`, name: 'delegate_to_researcher', input: { goal: `调研：${text.slice(0, 60)}` } }],
        );
      }
      if (looksResearch && toolNames.includes('delegate_to_researcher')) {
        return mockReply('我把这个交给 Researcher。', [
          { id: `call_${turn}`, name: 'delegate_to_researcher', input: { goal: text } },
        ]);
      }
      if (looksWriteFile && toolNames.includes('delegate_to_coder')) {
        return mockReply('我让 Coder 把这个文件写出来。', [
          { id: `call_${turn}`, name: 'delegate_to_coder', input: { goal: text } },
        ]);
      }
      return mockReply(`你好，这里是 mock 模式的 Conductor。你说："${text}"`);
    }

    if (role === 'researcher') {
      if (toolNames.includes('web_search') && !this._hasToolResultInHistory(messages)) {
        return mockReply('我先搜索一下相关资料。', [
          { id: `call_${turn}`, name: 'web_search', input: { query: userText.slice(0, 80) } },
        ]);
      }
      return mockReply(
        `【调研结论】围绕"${userText.slice(0, 40)}"，关键点：\n` +
          `1. 概念清晰、生态成熟；\n2. 主要落地场景已知；\n3. 已收集 2-3 条权威资料（见工具结果）。`,
      );
    }

    if (role === 'coder') {
      if (toolNames.includes('file_system_write') && !this._hasToolResultInHistory(messages)) {
        const filename = /report\.md/i.test(userText) ? 'data/report.md' : 'data/output.txt';
        const content =
          `# 自动生成的产物\n\n基于上游 Agent 的产出。\n\n任务：${userText.slice(0, 80)}\n`;
        return mockReply('我把成果写到文件里。', [
          { id: `call_${turn}`, name: 'file_system_write', input: { path: filename, content } },
        ]);
      }
      return mockReply('代码/文档已写入指定文件。');
    }

    if (role === 'reviewer') {
      return mockReply('【评审】整体可用，评分 8/10。建议：补充错误处理、增加示例输入输出。');
    }

    return mockReply(`(mock) 收到："${userText}"`);
  }

  async stream(input: LLMCallArgs, onDelta?: LLMOnDelta): Promise<LLMResponse> {
    const res = await this.chat(input);
    for (const ch of res.content) {
      onDelta?.(ch);
      await new Promise((r) => setTimeout(r, 5));
    }
    return res;
  }
}

function extractExpr(text: string): string {
  const m = text.match(/[\d\s\+\-\*\/\(\)\.]+/g);
  if (!m) return '1+1';
  return m.filter((s) => /[\+\-\*\/]/.test(s)).sort((a, b) => b.length - a.length)[0] || '1+1';
}

function mockReply(content: string, toolCalls: ToolCall[] = []): LLMResponse {
  return {
    role: 'assistant',
    content,
    toolCalls,
    usage: { inputTokens: 50, outputTokens: 50 },
    raw: { mock: true },
  };
}
