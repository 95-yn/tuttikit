import type { ToolSpec } from '../types.js';

interface KBEntry {
  title: string;
  url: string;
  snippet: string;
  tags: string[];
}

const KB: KBEntry[] = [
  {
    title: 'pgvector：在 Postgres 内做向量检索',
    url: 'https://github.com/pgvector/pgvector',
    snippet:
      'pgvector 提供 vector 数据类型，支持 L2、内积、余弦距离索引（HNSW / IVFFlat），是 RAG 场景中最常用的 Postgres 扩展之一。',
    tags: ['pgvector', 'rag', 'postgres', '向量', 'vector'],
  },
  {
    title: '多 Agent 架构常见模式',
    url: 'https://example.com/multi-agent-patterns',
    snippet:
      '常见模式：Orchestrator-Worker、Planner-Executor、Hierarchical Team、Group Chat。多 Agent 系统的关键是消息协议与故障恢复策略。',
    tags: ['agent', 'orchestrator', 'planner', '多 agent'],
  },
  {
    title: 'Node.js 18+ Fetch & Streams',
    url: 'https://nodejs.org/api/globals.html#fetch',
    snippet:
      'Node 18 内置 fetch；配合 Readable.fromWeb 可在 Express/Fastify 中实现 SSE/流式响应转发。',
    tags: ['nodejs', 'fetch', 'stream', 'sse'],
  },
];

export const webSearchTool: ToolSpec<
  { query: string; topK?: number },
  { query: string; results: KBEntry[]; note?: string }
> = {
  name: 'web_search',
  description: '搜索外部资料（演示版离线知识库），返回若干条相关结果。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词' },
      topK: { type: 'integer', description: '返回结果条数', default: 3 },
    },
    required: ['query'],
  },
  allowedAgents: [],
  async handler({ query, topK = 3 }) {
    const q = String(query).toLowerCase();
    const scored = KB.map((doc) => {
      let s = 0;
      for (const tag of doc.tags) if (q.includes(tag.toLowerCase())) s += 2;
      if (doc.title.toLowerCase().includes(q)) s += 3;
      if (doc.snippet.toLowerCase().includes(q)) s += 1;
      return { doc, s };
    });
    const hits = scored.sort((a, b) => b.s - a.s).slice(0, topK).map((x) => x.doc);
    return {
      query,
      results: hits.length ? hits : KB.slice(0, topK),
      note: hits.length ? undefined : '未命中关键词，返回默认条目',
    };
  },
};
