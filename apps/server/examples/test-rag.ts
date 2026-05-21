/**
 * #2 RAG 测试：
 *   - MockEmbedding：同输入相同向量、归一化、cosine = 1
 *   - LongTermMemory.rememberAsync → vec 写盘
 *   - searchAsync：语义近的（即便词不重合）能排前
 *   - RRF：关键词 + 向量两路合并
 *   - 老 entries 无 vec → search 不挂、只走关键词
 *   - ensureEmbeddings backfill
 */
process.env.LOG_LEVEL ??= 'warn';
process.env.EMBEDDING_PROVIDER = 'mock';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MockEmbedding, cosineSim } from '../src/llm/embedding.js';
import { LongTermMemory } from '../src/memory/longTerm.js';
import { rrfMerge } from '../src/memory/hybridSearch.js';

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

// ───── A. MockEmbedding 自洽 ─────
{
  const ep = new MockEmbedding(384);
  const [v1, v2] = await ep.embed(['hello world', 'hello world']);
  assert(v1.length === 384, 'dim 正确 384');
  assert(v1.every((x, i) => x === v2[i]), '同输入 → 同向量');
  // cosine 自相似 = 1
  assert(Math.abs(cosineSim(v1, v2) - 1) < 1e-9, '自相似 cosine ≈ 1');
  // 归一化（||v|| = 1）
  let norm = 0;
  for (const x of v1) norm += x * x;
  assert(Math.abs(Math.sqrt(norm) - 1) < 1e-9, '向量归一化');
  // 不同输入不同向量
  const [v3] = await ep.embed(['totally different text']);
  assert(cosineSim(v1, v3) < 0.5, '不同输入 cosine 显著小于 1');
}

// ───── B. RRF 合并 ─────
{
  const a = [
    { item: 'x', score: 10 }, { item: 'y', score: 9 }, { item: 'z', score: 5 },
  ];
  const b = [
    { item: 'z', score: 100 }, { item: 'x', score: 80 }, { item: 'y', score: 60 },
  ];
  const out = rrfMerge([a, b], 3, (s) => s);
  // x 在两个 ranker 里都靠前 → top1
  assert(out[0] === 'x', `RRF top1 是 x（实际 ${out[0]}）`);
  assert(out.length === 3, '返回 3 条');
}

// ───── C. LongTermMemory 集成 ─────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-test-'));
  const file = path.join(tmpDir, 'lt.json');
  const mem = new LongTermMemory({ filePath: file });

  // 模拟老数据：手写 JSON，无 vec
  fs.writeFileSync(file, JSON.stringify([
    { id: 'old1', source: 'manual', text: 'pgvector 是 Postgres 的向量扩展', createdAt: Date.now() - 86400000, tags: ['db'] },
    { id: 'old2', source: 'manual', text: '小猫在睡觉', createdAt: Date.now() - 86400000, tags: ['pet'] },
  ]));

  // 老数据：关键词命中能搜出
  const r1 = mem.search('pgvector', 5);
  assert(r1.length === 1 && r1[0].id === 'old1', '关键词命中老数据：pgvector → old1');

  // 写新数据（rememberAsync 等 embedding）
  const a = await mem.rememberAsync({ text: 'vector database for embeddings', source: 'doc', tags: ['rag'] });
  const b = await mem.rememberAsync({ text: '我家小狗叫旺财', source: 'doc', tags: ['pet'] });
  assert(Array.isArray(a.vec) && a.vec.length === 384, '新条目带 vec（mock 384 维）');
  assert(a.vecModel === 'mock', 'vecModel 标 mock');

  // 异步检索（混合 ranker）：
  //   - "embeddings" 关键词命中 a（vector database for embeddings）
  //   - "向量" 关键词命中 old1（"pgvector ... 向量扩展"）
  //   - 都不沾 b（小狗），且 b 也走过 embedding，但 hash 派生向量与 query 几乎正交
  const r2 = await mem.searchAsync('embeddings 向量', 5);
  const ids = r2.map((it) => it.id);
  assert(ids.includes(a.id), 'searchAsync 含 a（关键词 embeddings 命中）');
  assert(ids.includes('old1'), 'searchAsync 含 old1（关键词 向量 命中）');
  assert(!ids.includes(b.id), 'searchAsync 不含无关条目 b（小狗）');

  // ensureEmbeddings backfill
  const back = await mem.ensureEmbeddings();
  assert(back.updated === 2, `backfill 更新 2 条老数据（实际 ${back.updated}）`);
  const reloaded = JSON.parse(fs.readFileSync(file, 'utf-8')) as Array<{ id: string; vec?: number[] }>;
  assert(reloaded.find((x) => x.id === 'old1')?.vec?.length === 384, '老数据 backfill 后带 vec');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ───── D-2. compact: stub LLM + stub embedding 合并 cluster ─────
//   绕开 rememberAsync 的向量 dedup（>=0.95 会被合掉），直接把 entries 写盘后再 compact。
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-compact-'));
  const file = path.join(tmpDir, 'lt.json');

  // 手写 4 条带 vec 的 entries：3 条同向量（cluster）+ 1 条不同（独立）
  const groupVec = [1, 0, 0];
  const otherVec = [0, 1, 0];
  fs.writeFileSync(file, JSON.stringify([
    { id: 'a1', source: 'doc', text: 'I love cat A',         createdAt: Date.now() - 4000, vec: groupVec, vecModel: 'cluster-stub' },
    { id: 'a2', source: 'doc', text: 'My cat B is fluffy',    createdAt: Date.now() - 3000, vec: groupVec, vecModel: 'cluster-stub' },
    { id: 'a3', source: 'doc', text: 'Chocolate cake recipe', createdAt: Date.now() - 2000, vec: groupVec, vecModel: 'cluster-stub' },
    { id: 'b1', source: 'doc', text: 'Totally unrelated note',createdAt: Date.now() - 1000, vec: otherVec, vecModel: 'cluster-stub' },
  ]));

  class ClusterEmbedding {
    name = 'cluster-stub';
    dim = 3;
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => /cat|cake/i.test(t) ? [...groupVec] : [...otherVec]);
    }
  }
  const mem = new LongTermMemory({ filePath: file, maxEntries: 10, embedding: new ClusterEmbedding() as never });

  class StubLLM {
    name = 'stub-summarizer';
    async chat() {
      return { role: 'assistant' as const, content: '【摘要】关于 cat 和 cake 的合并', toolCalls: [], usage: { inputTokens: 50, outputTokens: 30 } };
    }
    async stream() { return this.chat(); }
  }
  const before = mem.all().length;
  const r = await mem.compact({ llm: new StubLLM() as never, triggerAt: 2, similarityThreshold: 0.95 });
  const after = mem.all().length;
  assert(r.mergedClusters === 1, `compact 合并 1 个 cluster（实际 ${r.mergedClusters}）`);
  assert(after === before - 2, `4 条压缩到 2 条（before=${before}, after=${after}）`);
  assert(mem.all().some((it) => it.text.includes('【摘要】')), '能找到摘要条目');
  assert(mem.all().some((it) => it.text.includes('Totally unrelated')), '无关条目仍保留');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ───── D. dedup + evict ─────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-dedup-'));
  const file = path.join(tmpDir, 'lt.json');
  const mem = new LongTermMemory({ filePath: file, maxEntries: 3 });

  // exact dedup：同文本 remember 两次只剩一条
  const a1 = await mem.rememberAsync({ text: '完全相同的文本', source: 'a', tags: ['t1'] });
  const a2 = await mem.rememberAsync({ text: '完全相同的文本', source: 'b', tags: ['t2'] });
  assert(a1.id === a2.id, 'exact dedup：同 text 返回同 id');
  assert(mem.all().length === 1, 'all 长度 = 1');
  assert((a2.tags ?? []).includes('t1') && (a2.tags ?? []).includes('t2'), 'tags 合并');

  // evict：超出 maxEntries=3，第 4 条进来时最老的被丢
  await mem.rememberAsync({ text: '第二条不同文本', source: 'x' });
  await mem.rememberAsync({ text: '第三条不同文本', source: 'x' });
  assert(mem.all().length === 3, '凑齐 3 条');
  const fourth = await mem.rememberAsync({ text: '第四条触发 evict', source: 'x' });
  assert(mem.all().length === 3, 'evict 后还是 3 条（最老的被丢）');
  const ids = mem.all().map((it) => it.id);
  assert(ids.includes(fourth.id), '第四条还在');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ───── E. VectorStore 接口（InMemory 实现） ─────
{
  const { InMemoryVectorStore } = await import('../src/memory/vectorStore.js');
  const s = new InMemoryVectorStore(3);
  await s.upsert([
    { id: 'a', vec: [1, 0, 0], meta: { text: 'apple' } },
    { id: 'b', vec: [0, 1, 0], meta: { text: 'banana' } },
    { id: 'c', vec: [0.9, 0.1, 0], meta: { text: 'apricot' } },
  ]);
  assert(await s.count() === 3, 'VectorStore: count = 3');
  const r = await s.search([1, 0, 0], 2);
  assert(r[0].id === 'a' && Math.abs(r[0].similarity - 1) < 1e-9, 'VectorStore: 完全匹配 a，sim=1');
  assert(r[1].id === 'c', 'VectorStore: 次近是 c');
  assert(r.length === 2, 'VectorStore: top-k 限制生效');
  await s.remove(['a']);
  assert(await s.count() === 2, 'VectorStore: remove 后 count = 2');
  const r2 = await s.search([1, 0, 0], 5, 0.95);
  assert(r2.length === 0, 'VectorStore: minSim=0.95 过滤后无结果（c 只有 0.9）');
  let caught: unknown;
  try { await s.upsert([{ id: 'x', vec: [1, 2] }]); } catch (e) { caught = e; }
  assert(caught instanceof Error && /dim mismatch/.test((caught as Error).message), 'VectorStore: dim 不一致抛错');
}

console.log('\n全部通过 ✅');
