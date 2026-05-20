import { config } from '../config.js';
import { MockProvider } from './mock.js';
import { AISDKProvider, createAISDKModel, type ProviderCfg } from './aisdk.js';
import type { LLMLike } from '../types.js';

export function createLLM(providerName?: string): LLMLike {
  const name = providerName || config.llm.provider;

  if (name === 'mock') return new MockProvider();

  // 类型层面拿到对应 provider 配置
  const cfg = (config.llm as unknown as Record<string, ProviderCfg | undefined>)[name];
  if (!cfg || !cfg.apiKey) return fallback(name);

  try {
    const { model } = createAISDKModel(name, cfg);
    return new AISDKProvider({ model, name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[llm] 初始化 ${name} 失败：${msg}，使用 MockProvider`);
    return new MockProvider();
  }
}

function fallback(requested: string): LLMLike {
  console.warn(`[llm] ${requested} 缺少 API Key，自动切换到 MockProvider`);
  return new MockProvider();
}
