# 02 · RAG 与长期记忆升级

> **核心论点**：当前 `longTerm.search` 是关键词命中数 × 2 + tag 加权 + 时间衰减，本质是 BM25 没做完。换成向量后能召回 "意思相近但不同词" 的记忆，多轮上下文质量阶跃。

## 现状

`apps/server/src/memory/longTerm.ts`：

```ts
search(query: string, k = 5): MemoryEntry[] {
  const terms = q.split(/[\s,，。、]+/).filter((t) => t.length > 1);
  for (const t of terms) {
    if (text.includes(t)) score += 2;       // 关键词命中
    if (tags?.some(...)) score += 1;        // tag 加权
  }
  // + 时间衰减
}
```

问题：
- "查一下我之前问的关于向量数据库的笔记" → 用户原话是 "embedding"，命中失败。
- 中文分词依赖 split，"上海" 拆不出。
- 知识量大了之后 O(N) 全扫，无索引。

`apps/server/src/tools/webSearch.ts` 是个写死 3 条的离线 KB，**不是真搜索**。

## 设计

分两块：

### A. 向量化长期记忆

#### A.1 Embedding provider 抽象

新增 `apps/server/src/llm/embedding.ts`：

```ts
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;   // batch
  dim: number;                                    // 维度
  name: string;                                   // 'openai-text-embedding-3-small' / 'voyage-3' / 'bge-m3-local'
}
```

实现三个：
- `OpenAIEmbedding` —— `text-embedding-3-small` (1536 维)，便宜稳定
- `VoyageEmbedding` —— Claude 官方推荐，中文召回好
- `MockEmbedding` —— 测试用，hash(text) → 固定向量

#### A.2 向量存储

**初版用 sqlite-vec**（不引入 Postgres，部署简单）：

- 依赖：`better-sqlite3` + `sqlite-vec`
- 表结构：`memory(id, text, tags JSON, source, created_at, vec BLOB)`
- 检索：`SELECT * FROM memory ORDER BY vec_distance_cosine(vec, ?) LIMIT k`

升级路径文档化：当 entries > 100K 时迁到 pgvector / qdrant。

#### A.3 Chunking 策略

记忆 `remember()` 时：
- 若 `text.length > 800`，按段落切（双换行优先，再按句号）。
- 每 chunk 单独 embed，但保留 parent_id 指回原条目，召回时去重。

#### A.4 Hybrid Search

向量召回 top-20 + 关键词召回 top-20 → RRF (Reciprocal Rank Fusion) 合并 → 取 top-k。

```ts
function rrf(rankings: number[][], k = 60): number[] {
  // 经典 RRF：score = sum(1 / (k + rank))
}
```

中文/混合场景下混合检索几乎总比纯向量好。

### B. 真 Web 搜索

`webSearch.ts` 改为 provider 模式：

- `MockWebSearch` —— 当前离线 KB（测试用）
- `BraveSearch` / `TavilySearch` / `BingSearch` —— 真 API（环境变量决定用哪个）

```ts
const provider = process.env.WEB_SEARCH_PROVIDER || 'mock';
```

`tavily` 是给 Agent 用的搜索 API（返回 snippet + content），最适合做 RAG。

## 改哪些文件

新增：
- `apps/server/src/llm/embedding.ts`
- `apps/server/src/memory/vectorStore.ts` —— sqlite-vec 封装
- `apps/server/src/memory/chunker.ts`
- `apps/server/src/memory/hybridSearch.ts` —— RRF 合并
- `apps/server/src/tools/webSearch/tavily.ts` / `brave.ts` / `mock.ts`

改：
- `apps/server/src/memory/longTerm.ts` —— `remember()` 加 embedding + chunk；`search()` 走 hybrid
- `apps/server/src/tools/webSearch.ts` —— 改成 provider 路由
- `apps/server/src/config.ts` —— 加 `embedding.provider` / `webSearch.provider` 配置
- `apps/server/package.json` —— 加 `better-sqlite3`、`sqlite-vec`
- `.env.example` —— 加 `EMBEDDING_PROVIDER` / `TAVILY_API_KEY` 等

## 数据迁移

老的 `data/longTerm.json` 写一个 `scripts/migrate-memory-to-vec.ts`：扫一遍、调 embedding、写进 sqlite。一次性脚本，不进主流程。

## 验收

1. `remember({ text: '向量数据库 pgvector 文档' })` + `search('embedding')` 能召回该条（关键词法做不到）。
2. 长文（2000 字）remember 后被 chunk 成 3+ 条但 search 只返回 1 条（去重）。
3. webSearch tool 切到 `provider=tavily` 后能返回真实当下的搜索结果。
4. eval harness（见 [01](./01-eval-harness.md)）里加一组 `rag-*.yaml` 任务，跑通。

## 风险

- **embedding 调用成本**：每次 `remember` 都要调 API。对策：批量 / 本地模型（`@xenova/transformers` + bge-small）做 fallback。
- **sqlite-vec 在某些平台编译不过**：M 系列 Mac、Linux x64 已验证；Windows 不保证。文档里写清楚。
