import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import { createEmbedding, cosineSim, type EmbeddingProvider } from '../llm/embedding.js';
import { rrfMerge, type RankedItem } from './hybridSearch.js';
import type { LLMLike, MemoryEntry } from '../types.js';

export interface RememberInput {
  tags?: string[];
  text: string;
  source?: string;
}

/** dedup 配置 */
const DEDUP_VEC_SIM_THRESHOLD = 0.95;   // 向量相似度超此值视为重复
const DEFAULT_MAX_ENTRIES = 500;         // 超出后 evict 最老的

/**
 * 长期记忆：JSON 文件持久化 + 关键词 + 向量混合检索（RRF 合并）。
 *
 * 兼容性：
 *   - 老的 long_term_memory.json 不带 vec —— 加载后正常，关键词路径照搜，
 *     `ensureEmbeddings()` 可一次性 backfill。
 *   - 新写入的 entry 自动算 embedding；失败不阻塞 remember（写盘不带 vec 也行）。
 *   - mock embedding 是 hash 派生确定性向量，离线场景 / 测试也能跑。
 */
export class LongTermMemory {
  filePath: string;
  items: MemoryEntry[];
  maxEntries: number;
  private _loaded: boolean;
  private _embedding: EmbeddingProvider | null;

  constructor({
    filePath = config.memory.longTermPath,
    embedding,
    maxEntries = DEFAULT_MAX_ENTRIES,
  }: { filePath?: string; embedding?: EmbeddingProvider; maxEntries?: number } = {}) {
    this.filePath = path.resolve(filePath);
    this.items = [];
    this.maxEntries = maxEntries;
    this._loaded = false;
    // 测试 / 嵌入式场景可以注入；默认从环境变量推断
    this._embedding = embedding ?? null;
  }

  private _getEmbedding(): EmbeddingProvider {
    if (!this._embedding) this._embedding = createEmbedding();
    return this._embedding;
  }

  private _ensureLoaded(): void {
    if (this._loaded) return;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.items = JSON.parse(raw);
      }
    } catch (err) {
      logger.warn({ err }, '[longTerm] 加载失败，使用空记忆');
      this.items = [];
    }
    this._loaded = true;
  }

  private _persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.items, null, 2));
  }

  /** 同步版（向后兼容）：不算 embedding，下次 search 时再 lazy backfill */
  remember({ tags = [], text, source = 'unknown' }: RememberInput): MemoryEntry {
    this._ensureLoaded();
    // exact dedup：完全相同文本直接返回已有，刷新 createdAt 提升优先级（用 LRU 语义）
    const exact = this._findExact(text);
    if (exact) {
      exact.createdAt = Date.now();
      // 合并 tags（去重）
      const merged = new Set([...(exact.tags ?? []), ...tags]);
      exact.tags = [...merged];
      this._persist();
      return exact;
    }
    const item: MemoryEntry = {
      source,
      text,
      createdAt: Date.now(),
      id: nanoid(8),
      tags,
    };
    this.items.push(item);
    this._evictIfOver();
    this._persist();
    // 异步算 embedding（不 await，不阻塞 remember 返回；失败 swallow）
    void this._computeVecAsync(item);
    return item;
  }

  /** 异步版：等 embedding 算完再返回；带向量 dedup */
  async rememberAsync(input: RememberInput): Promise<MemoryEntry> {
    this._ensureLoaded();
    // exact dedup 走 sync 路径
    const exact = this._findExact(input.text);
    if (exact) {
      exact.createdAt = Date.now();
      const merged = new Set([...(exact.tags ?? []), ...(input.tags ?? [])]);
      exact.tags = [...merged];
      this._persist();
      return exact;
    }
    // 算一次新文本 embedding；若与现有条目 cosine ≥ 阈值 → 复用（refresh + 合并 tags）
    const ep = this._getEmbedding();
    let newVec: number[] | undefined;
    try {
      const [v] = await ep.embed([input.text]);
      newVec = v;
      const similar = this._findVectorDup(v, ep.name);
      if (similar) {
        similar.createdAt = Date.now();
        const merged = new Set([...(similar.tags ?? []), ...(input.tags ?? [])]);
        similar.tags = [...merged];
        this._persist();
        return similar;
      }
    } catch (err) {
      logger.warn({ err }, '[longTerm] dedup 期间 embedding 失败，跳过向量 dedup');
    }
    const item: MemoryEntry = {
      source: input.source ?? 'unknown',
      text: input.text,
      createdAt: Date.now(),
      id: nanoid(8),
      tags: input.tags ?? [],
    };
    if (newVec) {
      item.vec = newVec;
      item.vecModel = ep.name;
    }
    this.items.push(item);
    this._evictIfOver();
    this._persist();
    return item;
  }

  private _findExact(text: string): MemoryEntry | null {
    const h = crypto.createHash('sha1').update(text).digest('hex');
    return this.items.find((it) => crypto.createHash('sha1').update(it.text).digest('hex') === h) ?? null;
  }

  private _findVectorDup(qvec: number[], modelName: string): MemoryEntry | null {
    let best: MemoryEntry | null = null;
    let bestSim = -Infinity;
    for (const it of this.items) {
      if (!Array.isArray(it.vec) || it.vecModel !== modelName) continue;
      if (it.vec.length !== qvec.length) continue;
      const sim = cosineSim(qvec, it.vec);
      if (sim > bestSim) { bestSim = sim; best = it; }
    }
    return bestSim >= DEDUP_VEC_SIM_THRESHOLD ? best : null;
  }

  /** 超过 maxEntries → 按 createdAt 升序丢最老的（已经被 dedup 刷过的会自动幸存） */
  private _evictIfOver(): void {
    if (this.items.length <= this.maxEntries) return;
    this.items.sort((a, b) => a.createdAt - b.createdAt);
    const evictCount = this.items.length - this.maxEntries;
    const evicted = this.items.splice(0, evictCount);
    logger.info({ evictCount, kept: this.items.length }, '[longTerm] 超过 maxEntries，evict 最老的');
    void evicted;
  }

  private async _computeVecAsync(item: MemoryEntry): Promise<void> {
    try {
      const ep = this._getEmbedding();
      const [vec] = await ep.embed([item.text]);
      item.vec = vec;
      item.vecModel = ep.name;
      this._persist();
    } catch (err) {
      logger.warn({ err, id: item.id }, '[longTerm] embedding 计算失败，跳过（仍可关键词检索）');
    }
  }

  /** 给历史 entries 一次性 backfill embedding；幂等 */
  async ensureEmbeddings(): Promise<{ updated: number; skipped: number }> {
    this._ensureLoaded();
    const ep = this._getEmbedding();
    const pending = this.items.filter((it) => !it.vec || it.vecModel !== ep.name);
    if (pending.length === 0) return { updated: 0, skipped: this.items.length };
    const BATCH = 32;
    let updated = 0;
    for (let i = 0; i < pending.length; i += BATCH) {
      const slice = pending.slice(i, i + BATCH);
      try {
        const vecs = await ep.embed(slice.map((it) => it.text));
        slice.forEach((it, j) => {
          it.vec = vecs[j];
          it.vecModel = ep.name;
          updated++;
        });
      } catch (err) {
        logger.warn({ err, batchStart: i }, '[longTerm] 批量 embedding 失败，跳过该批');
      }
    }
    this._persist();
    return { updated, skipped: this.items.length - updated };
  }

  /**
   * 混合检索：关键词 ranker + 向量 ranker → RRF 合并 → top-k。
   * 老数据 / mock 环境下，没 vec 的条目走纯关键词；行为对老调用者向后兼容。
   */
  search(query: string, k = 5): MemoryEntry[] {
    this._ensureLoaded();
    if (!query || !this.items.length) return [];

    const keywordRanked = this._keywordSearch(query, this.items, k * 4);
    // 向量检索：只在已有 ep 实例 + 至少一条 vec 时跑（避免每次 search 都吃 embedding 调用费）
    let vectorRanked: RankedItem<MemoryEntry>[] = [];
    const hasVec = this.items.some((it) => Array.isArray(it.vec));
    if (hasVec && this._embedding) {
      vectorRanked = this._vectorSearchSync(query, k * 4);
    }
    if (vectorRanked.length === 0) return keywordRanked.map((r) => r.item).slice(0, k);
    return rrfMerge(
      [keywordRanked, vectorRanked],
      k,
      (it) => String((it as MemoryEntry).id || it.text),
    );
  }

  /** 异步混合搜索：一定走 embedding（远端 / 本地）；推荐对外用这个 */
  async searchAsync(query: string, k = 5): Promise<MemoryEntry[]> {
    this._ensureLoaded();
    if (!query || !this.items.length) return [];

    const ep = this._getEmbedding();
    const keywordRanked = this._keywordSearch(query, this.items, k * 4);

    let vectorRanked: RankedItem<MemoryEntry>[] = [];
    try {
      const [qvec] = await ep.embed([query]);
      const VEC_MIN_SIM = 0.15;        // 低于这个相似度的当噪声丢掉，避免 RRF 把无关项混进 top-k
      vectorRanked = this.items
        .filter((it) => Array.isArray(it.vec) && it.vecModel === ep.name)
        .map((it) => ({ item: it, score: cosineSim(qvec, it.vec!) }))
        .filter((r) => r.score >= VEC_MIN_SIM)
        .sort((a, b) => b.score - a.score)
        .slice(0, k * 4);
    } catch (err) {
      logger.warn({ err }, '[longTerm] 查询 embedding 失败，回退纯关键词');
    }

    if (vectorRanked.length === 0) return keywordRanked.map((r) => r.item).slice(0, k);
    return rrfMerge(
      [keywordRanked, vectorRanked],
      k,
      (it) => String((it as MemoryEntry).id || it.text),
    );
  }

  private _keywordSearch(query: string, pool: MemoryEntry[], k: number): RankedItem<MemoryEntry>[] {
    const q = query.toLowerCase();
    const terms = q.split(/[\s,，。、]+/).filter((t) => t.length > 1);
    const now = Date.now();
    const scored = pool.map((item) => {
      const text = (item.text || '').toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (text.includes(t)) score += 2;
        const tags = (item as { tags?: string[] }).tags;
        if (tags?.some((tag) => tag.toLowerCase().includes(t))) score += 1;
      }
      const ageDays = (now - item.createdAt) / 86400000;
      score *= Math.max(0.3, 1 - ageDays / 60);
      return { item, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** sync 路径：当外部已经把 query embedding 喂进来时才能用；search() 拿不到 query vec，所以 sync 路径其实只跑关键词 */
  private _vectorSearchSync(_query: string, _k: number): RankedItem<MemoryEntry>[] {
    // 没法 sync 跑 embedding 调用 → 留空。如果有用 searchAsync 即可。
    return [];
  }

  all(): MemoryEntry[] {
    this._ensureLoaded();
    return [...this.items];
  }

  /**
   * Compact：超过阈值时按 cosine 相似度聚类，每个 cluster (≥2 条) 用 LLM 合并成一条摘要。
   * 失败安全：LLM 不可用 / 出错 → 退化成 _evictIfOver；mock provider 时也走 evict（避免无意义合并）。
   *
   *   - 入参 llm 可注入，便于测试用 mock；不传则用环境创建的 createLLM
   *   - similarityThreshold 默认 0.85，比 dedup（0.95）松
   *   - returns: { mergedClusters, summarizedItems }
   */
  async compact(opts: {
    llm: LLMLike;
    /** 触发压缩的最低条目数（达到则跑） */
    triggerAt?: number;
    similarityThreshold?: number;
  }): Promise<{ mergedClusters: number; summarizedItems: number }> {
    this._ensureLoaded();
    const trigger = opts.triggerAt ?? this.maxEntries;
    if (this.items.length < trigger) return { mergedClusters: 0, summarizedItems: 0 };
    const llm = opts.llm;
    const simT = opts.similarityThreshold ?? 0.85;

    // mock provider 没意义跑 LLM 合并，退化 evict
    if (llm.name === 'mock') {
      const before = this.items.length;
      this._evictIfOver();
      return { mergedClusters: 0, summarizedItems: before - this.items.length };
    }

    const ep = this._getEmbedding();
    // 先确保有 vec：未 backfill 的不进 cluster 候选
    await this.ensureEmbeddings();

    const haveVec = this.items.filter((it) => Array.isArray(it.vec) && it.vecModel === ep.name);
    const visited = new Set<string>();
    const clusters: MemoryEntry[][] = [];
    for (const seed of haveVec) {
      const seedId = String(seed.id);
      if (visited.has(seedId)) continue;
      const group: MemoryEntry[] = [seed];
      visited.add(seedId);
      for (const other of haveVec) {
        const oid = String(other.id);
        if (visited.has(oid)) continue;
        if (cosineSim(seed.vec!, other.vec!) >= simT) {
          group.push(other);
          visited.add(oid);
        }
      }
      if (group.length >= 2) clusters.push(group);
    }

    let summarized = 0;
    for (const cluster of clusters) {
      const merged = cluster.map((it) => `- ${it.text}`).join('\n');
      try {
        const res = await llm.chat({
          system: '把下面多条相似的记忆条目合并成一条简洁、不丢信息的摘要。直接输出摘要文本，不要前言。',
          messages: [{ role: 'user', content: merged }],
          temperature: 0,
          maxTokens: 256,
        });
        const summaryText = (res.content || '').trim();
        if (!summaryText) continue;
        const allTags = new Set<string>();
        for (const it of cluster) for (const t of it.tags ?? []) allTags.add(t);
        allTags.add('summary');
        const oldest = cluster.reduce((a, b) => a.createdAt < b.createdAt ? a : b).createdAt;
        const summaryItem: MemoryEntry = {
          source: 'compact',
          text: summaryText,
          createdAt: oldest,        // 沿用最早 createdAt，便于查找历史
          id: nanoid(8),
          tags: [...allTags],
        };
        // 替换 cluster：删旧 + 添新 + embedding
        const idsToRemove = new Set(cluster.map((it) => it.id));
        this.items = this.items.filter((it) => !idsToRemove.has(it.id));
        try {
          const [v] = await ep.embed([summaryText]);
          summaryItem.vec = v;
          summaryItem.vecModel = ep.name;
        } catch {/* 不带 vec 也行 */}
        this.items.push(summaryItem);
        summarized += cluster.length;
      } catch (err) {
        logger.warn({ err, clusterSize: cluster.length }, '[longTerm] 摘要 cluster 失败，跳过');
      }
    }
    this._persist();
    logger.info({ clusters: clusters.length, summarized, remaining: this.items.length }, '[longTerm] compact 完成');
    // 如果合并后仍超 maxEntries，再 evict 一刀
    this._evictIfOver();
    this._persist();
    return { mergedClusters: clusters.length, summarizedItems: summarized };
  }
}

export const longTermMemory = new LongTermMemory();
