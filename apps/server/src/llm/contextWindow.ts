/**
 * Provider × model 的 context window 上限查表。
 * 服务端两个地方用：
 *   - GET /health → 暴露给前端 CtxMeter
 *   - sessionCompact → 决定何时触发压缩
 * 维护时和 apps/web/src/lib/tokens.ts 同步。
 */
const TABLE: Record<string, number> = {
  // Claude Opus 4.7（2026-04）原生 1M token，无长上下文溢价；前缀匹配让 4-7 优先于 4
  'anthropic:claude-opus-4-7':   1_000_000,
  'anthropic:claude-opus-4':     200_000,
  'anthropic:claude-sonnet-4':   200_000,
  'anthropic:claude-haiku-4':    200_000,
  'anthropic:claude-3-5-sonnet': 200_000,
  'anthropic:claude-3-5-haiku':  200_000,
  // Codex CLI（2026 年）默认走 gpt-5-5；旧 API 端点也保留
  'openai:gpt-5-5':            1_000_000,
  'openai:gpt-5':                400_000,
  'openai:gpt-5-codex':          400_000,
  'openai:gpt-4o':               128_000,
  'openai:gpt-4o-mini':          128_000,
  'openai:gpt-4.1':            1_047_576,
  'openai:gpt-4.1-mini':       1_047_576,
  'openai:o1':                   200_000,
  'openai:o3-mini':              200_000,
  // DeepSeek V4（2026-04-24 发布，1M）；老 deepseek-chat 2026-07-24 退役但目前仍可用
  'deepseek:deepseek-v4-pro':   1_000_000,
  'deepseek:deepseek-v4-flash': 1_000_000,
  'deepseek:deepseek-chat':       128_000,
  'deepseek:deepseek-reasoner':    64_000,
  // 通义：Qwen 3.7-Max（2026-05-21）/ 3.6-Max-Preview（262K）/ 3.5-Plus（1M）
  'qwen:qwen3.7-max':          1_000_000,   // 旗舰；窗口按官方公布的 1M 估
  'qwen:qwen3.6-max':            262_144,
  'qwen:qwen3.5-plus':         1_000_000,
  'qwen:qwen-max':                32_000,
  'qwen:qwen-plus':              131_072,
  'qwen:qwen-turbo':           1_000_000,
  'qwen:qwen3':                  262_144,
  // 豆包：Seed 2.0（2026-02）/ Seed 1.6 都是 256K；老 1.5 系列 32K
  'doubao:doubao-seed-2':         256_000,
  'doubao:doubao-seed-1.6':       256_000,
  'doubao:doubao-1-5-pro-32k':     32_000,
  'doubao:doubao-1-5-pro-256k':   256_000,
  'doubao:doubao-1-5-lite':        32_000,
  // 腾讯混元：TurboS / T1（2026 主力，Mamba-Transformer MoE）都是 256K
  'hunyuan:hunyuan-turbos':       256_000,
  'hunyuan:hunyuan-t1':           256_000,
  'hunyuan:hunyuan-large':        32_000,
  'hunyuan:hunyuan-standard':     32_000,
  // 智谱：GLM-5 / 5.1（2026-02 / 04 发布，200K）；老 glm-4 系列保留
  'glm:glm-5':                   200_000,
  'glm:glm-5.1':                 200_000,
  'glm:glm-4-plus':              128_000,
  'glm:glm-4-flash':             128_000,
  'glm:glm-4':                   128_000,
  // Moonshot/Kimi：K2.6（2026-04）262K；老 moonshot-v1 系列保留
  'kimi:kimi-k2.6':              262_144,
  'kimi:kimi-k2':                262_144,
  'kimi:moonshot-v1-8k':           8_000,
  'kimi:moonshot-v1-32k':         32_000,
  'kimi:moonshot-v1-128k':       128_000,
  'mock:mock':                     8_000,
};

// provider 兜底窗口：未知 model 时保守取该 provider 较通用的一档
const PROVIDER_DEFAULT: Record<string, number> = {
  anthropic: 200_000,    // 未知 model 保守 200k（4 系基线），4-7 在表里精确命中 1M
  openai: 128_000,
  deepseek: 128_000,
  qwen: 131_072, doubao: 256_000, hunyuan: 256_000, glm: 200_000, kimi: 262_144,
  mock: 8_000,
};

/** 查 `provider × model` 的窗口大小；先精确，再前缀（如 `claude-sonnet-4-6` → `claude-sonnet-4`），最后 provider 兜底。 */
export function contextWindowOf(provider: string, model: string): number {
  const exact = TABLE[`${provider}:${model}`];
  if (exact) return exact;
  const prefix = `${provider}:`;
  let best: string | null = null;
  for (const k of Object.keys(TABLE)) {
    if (!k.startsWith(prefix)) continue;
    const tail = k.slice(prefix.length);
    if (model.startsWith(tail) && (!best || tail.length > best.length)) best = tail;
  }
  if (best) return TABLE[`${provider}:${best}`];
  return PROVIDER_DEFAULT[provider] ?? 32_000;
}
