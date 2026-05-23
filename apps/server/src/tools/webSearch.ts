import { z } from 'zod';
import type { ToolSpec, ToolCtx } from '../types.js';
import { logger } from '../observability/logger.js';

const Input = z.object({
  query: z.string().min(1, 'query 不能为空'),
  topK: z.number().int().positive().max(20).optional(),
});

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  tags?: string[];
}

// ───── 离线 KB backend（默认 / 演示用）─────
const KB: SearchResult[] = [
  {
    title: 'pgvector：在 Postgres 内做向量检索',
    url: 'https://github.com/pgvector/pgvector',
    snippet: 'pgvector 提供 vector 数据类型，支持 L2、内积、余弦距离索引（HNSW / IVFFlat），是 RAG 场景中最常用的 Postgres 扩展之一。',
    tags: ['pgvector', 'rag', 'postgres', '向量', 'vector'],
  },
  {
    title: '多 Agent 架构常见模式',
    url: 'https://example.com/multi-agent-patterns',
    snippet: '常见模式：Orchestrator-Worker、Planner-Executor、Hierarchical Team、Group Chat。多 Agent 系统的关键是消息协议与故障恢复策略。',
    tags: ['agent', 'orchestrator', 'planner', '多 agent'],
  },
  {
    title: 'Node.js 18+ Fetch & Streams',
    url: 'https://nodejs.org/api/globals.html#fetch',
    snippet: 'Node 18 内置 fetch；配合 Readable.fromWeb 可在 Express/Fastify 中实现 SSE/流式响应转发。',
    tags: ['nodejs', 'fetch', 'stream', 'sse'],
  },
];

function searchKB(query: string, topK: number): SearchResult[] {
  const q = query.toLowerCase();
  const scored = KB.map((doc) => {
    let s = 0;
    for (const tag of doc.tags ?? []) if (q.includes(tag.toLowerCase())) s += 2;
    if (doc.title.toLowerCase().includes(q)) s += 3;
    if (doc.snippet.toLowerCase().includes(q)) s += 1;
    return { doc, s };
  });
  const hits = scored.sort((a, b) => b.s - a.s).filter((x) => x.s > 0).slice(0, topK).map((x) => x.doc);
  return hits.length ? hits : KB.slice(0, topK);
}

// ───── Tavily backend（要 TAVILY_API_KEY）─────
// Tavily 是 LLM 友好的 search API，返回干净的 snippet + url；2026 年最常用的 agent search backend
// 拿 key: https://tavily.com（每月 1000 次免费）
async function searchTavily(query: string, topK: number): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY 未设置');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: key, query,
      max_results: topK,
      include_answer: false,
      search_depth: 'basic',
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json() as { results?: Array<{ title: string; url: string; content: string }> };
  return (data.results ?? []).map((r) => ({
    title: r.title, url: r.url, snippet: r.content?.slice(0, 400) ?? '',
  }));
}

// ───── Brave Search backend（要 BRAVE_API_KEY）─────
async function searchBrave(query: string, topK: number): Promise<SearchResult[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error('BRAVE_API_KEY 未设置');
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(topK));
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Brave ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
  return (data.web?.results ?? []).slice(0, topK).map((r) => ({
    title: r.title, url: r.url, snippet: r.description?.slice(0, 400) ?? '',
  }));
}

/**
 * 主入口：根据 WEB_SEARCH_BACKEND env 选 backend；失败自动回落 kb
 */
async function search(query: string, topK: number): Promise<{ results: SearchResult[]; backend: string }> {
  const backend = (process.env.WEB_SEARCH_BACKEND || 'kb').toLowerCase();
  try {
    if (backend === 'tavily') return { results: await searchTavily(query, topK), backend };
    if (backend === 'brave')  return { results: await searchBrave(query, topK),  backend };
  } catch (err) {
    logger.warn({ err: (err as Error).message, backend }, '[webSearch] 后端失败，回落 kb');
  }
  return { results: searchKB(query, topK), backend: 'kb' };
}

export const webSearchTool: ToolSpec<
  z.infer<typeof Input>,
  { query: string; backend: string; results: Array<SearchResult & { ref?: number }>; note?: string }
> = {
  name: 'web_search',
  description: '搜索网页（Tavily / Brave 任选，或本地 KB 演示）；返回 [{title, url, snippet, ref?}]，ref 是引用编号让你后续用 [ref:N] 标注引用。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词' },
      topK: { type: 'integer', description: '返回结果条数', default: 3 },
    },
    required: ['query'],
  },
  inputSchema: Input,
  allowedAgents: [],
  async handler({ query, topK = 3 }, ctx: ToolCtx = {}) {
    const { results, backend } = await search(query, topK);
    // 把每条结果 register 到 citations（W1.3 集成）；ref 编号塞进 result 给 LLM
    const withRef = results.map((r) => {
      const ref = ctx.citations?.register({
        title: r.title, url: r.url, snippet: r.snippet, kind: 'web',
      });
      return { ...r, ref };
    });
    return {
      query, backend,
      results: withRef,
      note: backend === 'kb' && results.length === 0 ? '未命中关键词' : undefined,
    };
  },
};
