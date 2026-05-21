# 迁移：内存 VectorStore → sqlite-vec

> 当 long_term_memory.json 累积超过 ~10k 条时，每次 search 都 O(N) 全扫，开始有 50-200ms 延迟。该上 sqlite-vec。

## 为什么不默认装 sqlite-vec

`better-sqlite3` + `sqlite-vec` 都需要原生编译，在 macOS Apple Silicon、Linux ARM、Windows 上的兼容性参差。直接进 `dependencies` 会让 `pnpm install` 在某些环境直接挂。当前架构（`memory/vectorStore.ts` 接口 + `InMemoryVectorStore` 实现）已经预留好替换点，需要时再装。

## 触发条件

任一满足就该考虑迁：

- `apps/server/data/long_term_memory.json` > 5 MB
- 单次 search 耗时 > 200ms（trace 里的 llm span attrs.searchDurationMs）
- 用户主诉 "记忆查不准"——很可能是 N 大了导致 noise

## 步骤

### 1. 装依赖

```bash
pnpm -C apps/server add better-sqlite3 sqlite-vec
pnpm -C apps/server add -D @types/better-sqlite3
```

如果 macOS Apple Silicon 装不上 `better-sqlite3`，先确认：
- Xcode CLT 装了：`xcode-select --install`
- Node 版本 ≥ 18（pre-built binary 有；老 node 要 source build）
- 还不行：`pnpm -C apps/server rebuild better-sqlite3`

### 2. 实现 `SqliteVecStore`

`apps/server/src/memory/sqliteVecStore.ts`（新建）：

```ts
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { VectorStore, VectorRecord, VectorSearchResult } from './vectorStore.js';

export class SqliteVecStore implements VectorStore {
  readonly name = 'sqlite-vec';
  readonly dim: number;
  private db: Database.Database;

  constructor(path: string, dim: number) {
    this.dim = dim;
    this.db = new Database(path);
    sqliteVec.load(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, payload JSON);
      CREATE VIRTUAL TABLE IF NOT EXISTS vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${dim}]
      );
    `);
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    const insertMeta = this.db.prepare('INSERT OR REPLACE INTO meta(id, payload) VALUES (?, json(?))');
    const delVec = this.db.prepare('DELETE FROM vec WHERE id = ?');
    const insVec = this.db.prepare('INSERT INTO vec(id, embedding) VALUES (?, ?)');
    const tx = this.db.transaction((batch: VectorRecord[]) => {
      for (const r of batch) {
        insertMeta.run(r.id, JSON.stringify(r.meta ?? {}));
        delVec.run(r.id);
        insVec.run(r.id, Buffer.from(new Float32Array(r.vec).buffer));
      }
    });
    tx(records);
  }

  async remove(ids: string[]): Promise<void> {
    const d1 = this.db.prepare('DELETE FROM meta WHERE id = ?');
    const d2 = this.db.prepare('DELETE FROM vec  WHERE id = ?');
    const tx = this.db.transaction((arr: string[]) => {
      for (const id of arr) { d1.run(id); d2.run(id); }
    });
    tx(ids);
  }

  async search(query: number[], k: number, minSim = 0): Promise<VectorSearchResult[]> {
    const rows = this.db.prepare(`
      SELECT vec.id AS id, vec_distance_cosine(embedding, ?) AS dist, meta.payload AS payload
      FROM vec JOIN meta ON vec.id = meta.id
      ORDER BY dist ASC
      LIMIT ?
    `).all(Buffer.from(new Float32Array(query).buffer), k) as Array<{ id: string; dist: number; payload: string }>;
    return rows
      .map((r) => ({
        id: r.id,
        similarity: 1 - r.dist,        // cosine distance → similarity
        meta: JSON.parse(r.payload || '{}'),
      }))
      .filter((r) => r.similarity >= minSim);
  }

  async count(): Promise<number> {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM vec').get() as { n: number }).n;
  }

  close(): void { this.db.close(); }
}
```

### 3. 在 `LongTermMemory` 里切换

把 `LongTermMemory` 里直接操作 `items[].vec` 的逻辑（`_findVectorDup`、`searchAsync` 的向量分支、`compact` 的 cluster 搜索）改成调 `VectorStore`。

具体：构造函数加 `store?: VectorStore` 参数；默认 `new InMemoryVectorStore(ep.dim)`；遇到 `process.env.VECTOR_STORE=sqlite` 时 `new SqliteVecStore(config.memory.longTermPath.replace('.json', '.sqlite'), ep.dim)`。

`remember` 写盘后追一行 `await this.store.upsert([{ id, vec, meta: { text } }])`。

`searchAsync` 的向量分支改成 `await this.store.search(qvec, k * 4, VEC_MIN_SIM)`，再用返回的 id 去 items 找完整 entry。

### 4. 一次性迁移脚本

```bash
pnpm -C apps/server tsx scripts/migrate-to-sqlite-vec.ts
```

脚本逻辑：读 long_term_memory.json → 逐条 upsert 到 sqlite → 备份 .json 后改名 .json.bak。完工后 `ls -la data/` 应该看到 `long_term_memory.sqlite`。

### 5. 验收

- `count()` 等于 .json.bak 里的 entries 数
- `eval --provider=mock` 仍然 35/35
- 跑一次 search 性能对比：1000 条数据 search → 内存 ~50ms，sqlite-vec ~5ms

## 不迁的成本

- 内存版每次 search 全扫 + 持久化整个 JSON，> 50MB 时 fs.writeFile 抖动明显（同步阻塞 100ms+）。
- 进程重启会 fs.readFile 整个 JSON 解析；冷启动慢。
- 多进程部署时多个 worker 共用 JSON 文件会写覆盖，必须迁 sqlite/redis 才能解决。

## 备选：pgvector / qdrant / chroma

如果已有 Postgres 集群、想做集中存储 + 跨服务共享，直接 pgvector 比 sqlite 更值：

```ts
class PgvectorStore implements VectorStore { /* CREATE EXTENSION vector; */ }
```

接口和 `SqliteVecStore` 一致，换实现即可。但本机开发体验是 sqlite 远胜 pg（无需起服务）。

## TL;DR

接口已经定好（`memory/vectorStore.ts`），照葫芦画瓢加 `SqliteVecStore` + 切换 longTerm 就能用。本次没默认装是避免砸到没装 native build toolchain 的用户。
