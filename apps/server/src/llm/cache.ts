/**
 * LLM 响应缓存：开发 / eval / debug 时反复跑相同输入不烧 API。
 *
 * Prod 默认关，因为：
 *   - 真实用户对 "同样问题每次答得一字不差" 感觉很诡异
 *   - tool 调用结果带时间戳/外部状态时，缓存对的答案会跟现实脱节
 *
 *   LLM_CACHE=true             启用
 *   LLM_CACHE_TTL_MS=3600000   单条 TTL（默认 1h）
 *   LLM_CACHE_MAX_ENTRIES=500
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import type { LLMCallArgs, LLMResponse } from '../types.js';

interface CacheEntry {
  response: LLMResponse;
  storedAt: number;
}

export class LLMCache {
  private entries = new Map<string, CacheEntry>();
  private ttlMs: number;
  private maxEntries: number;
  enabled: boolean;
  /** 调试统计：hit / miss / size */
  stats = { hits: 0, misses: 0 };

  constructor() {
    this.enabled = config.llmCache.enabled;
    this.ttlMs = config.llmCache.ttlMs;
    this.maxEntries = config.llmCache.maxEntries;
  }

  key(providerName: string, modelName: string, args: LLMCallArgs): string {
    // 缓存键：provider + model + 完整 messages + tool 定义。temperature/maxTokens 也算进去，
    // 因为同一 prompt 用不同 temp 期待不同输出。
    const payload = {
      provider: providerName, model: modelName,
      system: args.system || '',
      messages: args.messages,
      tools: (args.tools || []).map((t) => ({ name: t.name, description: t.description })),
      temperature: args.temperature ?? null,
      maxTokens: args.maxTokens ?? null,
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  get(key: string): LLMResponse | null {
    if (!this.enabled) return null;
    const entry = this.entries.get(key);
    if (!entry) { this.stats.misses++; return null; }
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      this.stats.misses++;
      return null;
    }
    // LRU bump
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.stats.hits++;
    return entry.response;
  }

  set(key: string, response: LLMResponse): void {
    if (!this.enabled) return;
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { response, storedAt: Date.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  size(): number { return this.entries.size; }
  clear(): void { this.entries.clear(); this.stats.hits = 0; this.stats.misses = 0; }
}

export const llmCache = new LLMCache();

if (llmCache.enabled) {
  logger.info({ ttlMs: config.llmCache.ttlMs, max: config.llmCache.maxEntries }, '[llm-cache] 已启用（仅开发 / eval 用）');
}
