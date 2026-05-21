import { config } from '../config.js';
import { MockProvider } from './mock.js';
import { AISDKProvider, createAISDKModel, type ProviderCfg } from './aisdk.js';
import { FallbackLLM } from './fallback.js';
import type { LLMLike } from '../types.js';

/**
 * 创建一个 LLM 实例。
 *   - 若提供了 providerName → 单一 provider（不走 fallback chain），失败照旧降到 mock。
 *   - 不传 providerName → 主 provider 由 config.llm.provider 决定；
 *     若同时配置了 config.llm.fallbackChain 且至少有一个可用项，
 *     返回 FallbackLLM 包装：限流/5xx 时按链上顺序切到下一个。
 */
export function createLLM(providerName?: string): LLMLike {
  if (providerName) return _createSingle(providerName);

  const primary = _createSingle(config.llm.provider);
  const altNames = config.llm.fallbackChain.filter((n) => n !== config.llm.provider);
  if (altNames.length === 0) return primary;

  const alternates: LLMLike[] = [];
  for (const name of altNames) {
    const llm = _createSingleIfReady(name);
    if (llm) alternates.push(llm);
  }
  if (alternates.length === 0) return primary;
  return new FallbackLLM({ primary, alternates });
}

/** 单一 provider 工厂：未配置 key 时落到 mock（保留旧行为，便于本地开发） */
function _createSingle(name: string): LLMLike {
  if (name === 'mock') return new MockProvider();
  const cfg = (config.llm as unknown as Record<string, ProviderCfg | undefined>)[name];
  if (!cfg || !cfg.apiKey) {
    console.warn(`[llm] ${name} 缺少 API Key，自动切换到 MockProvider`);
    return new MockProvider();
  }
  try {
    const { model } = createAISDKModel(name, cfg);
    return new AISDKProvider({ model, name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[llm] 初始化 ${name} 失败：${msg}，使用 MockProvider`);
    return new MockProvider();
  }
}

/**
 * Fallback 链上用的「严格」工厂：缺 key / 初始化失败时返回 null（让链跳过这一项）。
 * 不能像 _createSingle 那样回落到 mock —— 否则 anthropic 限流时全链最终都是 mock 接住，看似 ok 实则错误。
 */
function _createSingleIfReady(name: string): LLMLike | null {
  if (name === 'mock') return new MockProvider();
  const cfg = (config.llm as unknown as Record<string, ProviderCfg | undefined>)[name];
  if (!cfg || !cfg.apiKey) return null;
  try {
    const { model } = createAISDKModel(name, cfg);
    return new AISDKProvider({ model, name });
  } catch {
    return null;
  }
}
