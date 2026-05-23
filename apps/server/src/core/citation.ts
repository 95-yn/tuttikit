/**
 * Citation / source tracking（W1.3 Y4）。
 *
 * 流程：
 *   1. 一次 turn 开始时给 conductor 一个 fresh CitationCollector
 *   2. RAG 召回 / webSearch / 任何提供"外部信息"的工具调用都 register(source) 拿到 [N] 编号
 *   3. system prompt 里加一段："你的回答里引用某条 source 时写 [ref:N]"
 *   4. turn 结束把 collector.export() 写到最后一条 assistant message 的 meta.citations
 *   5. 前端把 [ref:N] 解析成可点击 footnote（第二版 UI 做）
 *
 * 设计选择：
 *   - per-turn 实例（不跨 session 复用编号）—— 简单清晰
 *   - register 返回的 ref 是 1-based（更像论文引用习惯）
 *   - dedup：同 URL / 同 hash 复用同一 [N]
 */
import crypto from 'node:crypto';

export interface CitationSource {
  /** 1-based ref 编号 */
  n: number;
  /** 显示给用户的标题 */
  title: string;
  /** 可选 url（外部 source）或 archive entry id（内部 RAG）*/
  url?: string;
  /** 内容片段，给 UI tooltip / footnote 用（最多 200 字）*/
  snippet?: string;
  /** 来源类别 */
  kind: 'rag' | 'web' | 'tool' | 'other';
}

export class CitationCollector {
  private _items: CitationSource[] = [];
  /** dedup：(url || hash(title+snippet)) → n */
  private _index = new Map<string, number>();

  register(args: Omit<CitationSource, 'n'>): number {
    const key = args.url ?? this._hashKey(args.title, args.snippet);
    const existing = this._index.get(key);
    if (existing) return existing;
    const n = this._items.length + 1;
    const item: CitationSource = { n, ...args };
    this._items.push(item);
    this._index.set(key, n);
    return n;
  }

  private _hashKey(title: string, snippet?: string): string {
    return crypto.createHash('sha1').update(title + '\n' + (snippet ?? '')).digest('hex');
  }

  /** 给 LLM system prompt 用：列出当前所有 source 的 [N] + 标题 + 内容 */
  formatForPrompt(): string {
    if (this._items.length === 0) return '';
    const lines = this._items.map((s) =>
      `[${s.n}] (${s.kind}) ${s.title}${s.url ? ` <${s.url}>` : ''}\n    ${s.snippet?.slice(0, 200) ?? ''}`,
    );
    return [
      '可引用的资料（回答时用 [ref:N] 标注引用）：',
      ...lines,
    ].join('\n');
  }

  /** 写入 message meta 给前端 */
  export(): CitationSource[] {
    return [...this._items];
  }

  size(): number { return this._items.length; }
}

/** 提示 LLM 使用 [ref:N] 引用的 system prompt 片段 */
export const CITATION_INSTRUCTION =
  '\n\n## 引用规范\n' +
  '当你的回答基于上面提供的资料时，请在相应句子末尾用 `[ref:N]` 标注引用编号（N 是资料前的方括号数字）。\n' +
  '例如：「prompt cache 能省 90% input 成本 [ref:1][ref:3]」。\n' +
  '没有资料支持的话不要瞎标。';
