/**
 * VectorStore 抽象：长期记忆里向量的存储 + 检索。
 *
 * 当前实现：InMemoryVectorStore（vec 直接挂在 MemoryEntry.vec 字段，随 long_term_memory.json 一起 fs 落盘）。
 * 升级路径：> 10k entries 时迁到 SqliteVecStore（见 docs/agent-roadmap/sqlite-vec-migration.md）。
 *
 * LongTermMemory 当前直接操作 items[].vec，没有走这个接口；这里先把接口定下来，
 * 下一次重构把 search/dedup/compact 收敛进 VectorStore 即可。
 */

export interface VectorRecord {
  id: string;
  vec: number[];
  /** 业务挂载数据，store 不解释 */
  meta?: Record<string, unknown>;
}

export interface VectorSearchResult {
  id: string;
  similarity: number;
  meta?: Record<string, unknown>;
}

export interface VectorStore {
  /** 名字 + 维度，用于切换 store 时校验 */
  readonly name: string;
  readonly dim: number;
  /** insert 或 update（按 id） */
  upsert(records: VectorRecord[]): Promise<void>;
  /** 删除一批 */
  remove(ids: string[]): Promise<void>;
  /** 余弦 top-k；同时支持下界过滤 */
  search(query: number[], k: number, minSim?: number): Promise<VectorSearchResult[]>;
  /** 总条目数（指标用） */
  count(): Promise<number>;
}

/** 内存实现：N 小（< 10k）时完全够用，>10k 推荐迁 sqlite-vec */
export class InMemoryVectorStore implements VectorStore {
  readonly name = 'in-memory';
  readonly dim: number;
  private records = new Map<string, VectorRecord>();

  constructor(dim: number) {
    this.dim = dim;
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const r of records) {
      if (r.vec.length !== this.dim) {
        throw new Error(`dim mismatch: expected ${this.dim}, got ${r.vec.length} for id=${r.id}`);
      }
      this.records.set(r.id, r);
    }
  }

  async remove(ids: string[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }

  async search(query: number[], k: number, minSim = 0): Promise<VectorSearchResult[]> {
    if (query.length !== this.dim) {
      throw new Error(`query dim mismatch: expected ${this.dim}, got ${query.length}`);
    }
    const out: VectorSearchResult[] = [];
    for (const r of this.records.values()) {
      let dot = 0;
      for (let i = 0; i < query.length; i++) dot += query[i] * r.vec[i];
      if (dot >= minSim) out.push({ id: r.id, similarity: dot, meta: r.meta });
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, k);
  }

  async count(): Promise<number> {
    return this.records.size;
  }
}
