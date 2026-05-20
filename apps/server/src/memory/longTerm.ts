import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import type { MemoryEntry } from '../types.js';

export interface RememberInput {
  tags?: string[];
  text: string;
  source?: string;
}

/**
 * 长期记忆：JSON 文件持久化 + 关键词打分检索。
 * 真生产换成向量检索：在 search() 里做 embedding 查询即可。
 */
export class LongTermMemory {
  filePath: string;
  items: MemoryEntry[];
  private _loaded: boolean;

  constructor({ filePath = config.memory.longTermPath }: { filePath?: string } = {}) {
    this.filePath = path.resolve(filePath);
    this.items = [];
    this._loaded = false;
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

  remember({ tags = [], text, source = 'unknown' }: RememberInput): MemoryEntry {
    this._ensureLoaded();
    const item: MemoryEntry = {
      source,
      text,
      createdAt: Date.now(),
      id: nanoid(8),
      tags,
    };
    this.items.push(item);
    this._persist();
    return item;
  }

  /**
   * 关键词命中数 * 2 + tag 命中 + 时间衰减加权
   */
  search(query: string, k = 5): MemoryEntry[] {
    this._ensureLoaded();
    if (!query || !this.items.length) return [];

    const q = query.toLowerCase();
    const terms = q.split(/[\s,，。、]+/).filter((t) => t.length > 1);

    const now = Date.now();
    const scored = this.items.map((item) => {
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
      .slice(0, k)
      .map((s) => s.item);
  }

  all(): MemoryEntry[] {
    this._ensureLoaded();
    return [...this.items];
  }
}

export const longTermMemory = new LongTermMemory();
