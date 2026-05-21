/**
 * Embedding Provider 抽象。
 *   - OpenAI text-embedding-3-small（默认 1536 维）
 *   - MockEmbedding（hash 派生，确定性、零成本，开发 / 测试 / mock provider 用）
 *
 * 用法：
 *   const ep = createEmbedding();  // 按 EMBEDDING_PROVIDER 选 provider
 *   const [v] = await ep.embed(['hello world']);
 */
import crypto from 'node:crypto';
import { createOpenAI } from '@ai-sdk/openai';
import { embedMany } from 'ai';
import { withRetry } from './retry.js';
import { logger } from '../observability/logger.js';

export interface EmbeddingProvider {
  name: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** MockEmbedding：用 sha256 → 取前 dim*4 字节，按 32-bit 切，规约到 [-1, 1] 区间。
 *  仅用于测试 / mock provider；同输入恒输出同向量。 */
export class MockEmbedding implements EmbeddingProvider {
  readonly name = 'mock';
  readonly dim: number;
  constructor(dim = 384) {
    this.dim = dim;
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this._vec(t));
  }
  private _vec(text: string): number[] {
    const h = crypto.createHash('sha256').update(text).digest();
    // 反复 hash 直到凑够 dim*4 字节
    const buf = Buffer.alloc(this.dim * 4);
    let cur = h;
    for (let i = 0; i < buf.length; i += 32) {
      cur = crypto.createHash('sha256').update(cur).digest();
      cur.copy(buf, i, 0, Math.min(32, buf.length - i));
    }
    const out = new Array<number>(this.dim);
    for (let i = 0; i < this.dim; i++) {
      const v = buf.readInt32LE(i * 4);
      out[i] = v / 2_147_483_648; // [-1, 1)
    }
    // 归一化到单位向量（cosine = dot product）
    let norm = 0;
    for (const v of out) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return out.map((v) => v / norm);
  }
}

/** OpenAI text-embedding-3-small（1536 维） */
export class OpenAIEmbedding implements EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  private model;

  constructor({ apiKey, model = 'text-embedding-3-small', dim }: { apiKey: string; model?: string; dim?: number }) {
    const oa = createOpenAI({ apiKey });
    this.model = oa.textEmbeddingModel(model);
    this.name = `openai:${model}`;
    this.dim = dim ?? (model.includes('-large') ? 3072 : 1536);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return withRetry(async () => {
      const { embeddings } = await embedMany({
        model: this.model as never,
        values: texts,
      });
      return embeddings as number[][];
    }, {
      onRetry: (err, attempt, delay) =>
        logger.warn({ provider: this.name, attempt, delay, err: (err as Error)?.message }, '[embedding] 重试'),
    });
  }
}

/** 工厂：按 EMBEDDING_PROVIDER 环境变量决定。无 key → mock */
export function createEmbedding(): EmbeddingProvider {
  const name = process.env.EMBEDDING_PROVIDER || 'auto';
  if (name === 'mock') return new MockEmbedding();
  if (name === 'openai' || (name === 'auto' && process.env.OPENAI_API_KEY)) {
    if (!process.env.OPENAI_API_KEY) {
      logger.warn('[embedding] EMBEDDING_PROVIDER=openai 但缺 OPENAI_API_KEY，回落 mock');
      return new MockEmbedding();
    }
    return new OpenAIEmbedding({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    });
  }
  return new MockEmbedding();
}

/** 余弦相似度（输入需归一化）。 */
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`dim mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
