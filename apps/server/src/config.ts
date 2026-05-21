import 'dotenv/config';
import { z } from 'zod';

export interface AppConfig {
  llm: {
    provider: string;
    /**
     * Provider 降级链：主 provider 出现限流 / 5xx / 网络层错误时，按顺序尝试链上的下一个。
     * 留空 → 不降级。会自动跳过未配置 apiKey 的项。
     * 通过环境变量 `LLM_FALLBACK_CHAIN=openai,deepseek,mock` 配置。
     */
    fallbackChain: string[];
    anthropic: { apiKey?: string; model: string };
    openai:    { apiKey?: string; model: string; baseURL: string };
    deepseek:  { apiKey?: string; model: string; baseURL: string };
  };
  server: {
    port: number;
    logLevel: string;
    corsOrigins: string[];
  };
  memory: {
    longTermPath: string;
    shortTermMaxTurns: number;
  };
  budget: {
    enabled: boolean;
    /** 单会话累计 USD 上限；超过 beforeTurn 抛 BudgetExceededError */
    perSessionMaxUSD: number;
    /** 单会话累计 token 上限（input + output） */
    perSessionMaxTokens: number;
    /** 全局当日 USD 上限（跨会话） */
    perDayMaxUSD: number;
  };
  llmCache: {
    /** LLM 响应缓存：仅开发 / eval 用，prod 默认关 */
    enabled: boolean;
    ttlMs: number;
    maxEntries: number;
  };
  agent: {
    /** Self-Critique：终答前用 LLM 做一次审校，REVISE 触发再跑一轮 */
    selfCritique: boolean;
    /** 检测到 file_system_write 写代码文件时自动调 reviewer 评审 */
    autoReviewCode: boolean;
    /** Plan-and-Execute：复杂任务先调 planner 拆步骤，把计划注入 conductor system */
    planAndExecute: boolean;
    /** V2 模式：显式逐步执行（plan:step:start/end 事件），代价是慢 N 倍 */
    planExplicitSteps: boolean;
  };
}

export const config: AppConfig = {
  llm: {
    provider: process.env.LLM_PROVIDER || 'mock',
    fallbackChain: (process.env.LLM_FALLBACK_CHAIN || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    },
  },
  server: {
    port: Number(process.env.PORT || 3001),
    logLevel: process.env.LOG_LEVEL || 'info',
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },
  memory: {
    longTermPath: process.env.LONG_TERM_MEMORY_PATH || './data/long_term_memory.json',
    shortTermMaxTurns: Number(process.env.SHORT_TERM_MAX_TURNS || 20),
  },
  budget: {
    enabled: (process.env.BUDGET_ENABLED ?? 'true') !== 'false',
    perSessionMaxUSD:    Number(process.env.BUDGET_SESSION_MAX_USD    || 2.0),
    perSessionMaxTokens: Number(process.env.BUDGET_SESSION_MAX_TOKENS || 1_000_000),
    perDayMaxUSD:        Number(process.env.BUDGET_DAY_MAX_USD        || 20.0),
  },
  llmCache: {
    enabled: process.env.LLM_CACHE === 'true',
    ttlMs: Number(process.env.LLM_CACHE_TTL_MS || 3_600_000),
    maxEntries: Number(process.env.LLM_CACHE_MAX_ENTRIES || 500),
  },
  agent: {
    selfCritique:   process.env.AGENT_SELF_CRITIQUE === 'true',
    autoReviewCode: process.env.AGENT_AUTO_REVIEW_CODE === 'true',
    planAndExecute: process.env.AGENT_PLAN_AND_EXECUTE === 'true',
    planExplicitSteps: process.env.AGENT_PLAN_EXPLICIT_STEPS === 'true',
  },
};

/**
 * Boot 期 env 校验：根据 LLM_PROVIDER 选项校验必要的 API key。
 * 校验失败抛 ZodError；server.ts 在 listen 之前调用，让进程在第一次请求 *之前* 就挂掉。
 */
// dotenv 读 `KEY=`（空值）会得到 ''，业务上视为"未设置"。
const optKey = z.string().optional().transform((v) => (v && v.length > 0 ? v : undefined));

const BootEnv = z.object({
  PORT: z.string().regex(/^\d+$/).optional(),
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'deepseek', 'mock']).default('mock'),
  ANTHROPIC_API_KEY: optKey,
  OPENAI_API_KEY: optKey,
  DEEPSEEK_API_KEY: optKey,
}).superRefine((v, ctx) => {
  if (v.LLM_PROVIDER === 'anthropic' && !v.ANTHROPIC_API_KEY) {
    ctx.addIssue({ code: 'custom', message: 'LLM_PROVIDER=anthropic 但缺 ANTHROPIC_API_KEY' });
  }
  if (v.LLM_PROVIDER === 'openai' && !v.OPENAI_API_KEY) {
    ctx.addIssue({ code: 'custom', message: 'LLM_PROVIDER=openai 但缺 OPENAI_API_KEY' });
  }
  if (v.LLM_PROVIDER === 'deepseek' && !v.DEEPSEEK_API_KEY) {
    ctx.addIssue({ code: 'custom', message: 'LLM_PROVIDER=deepseek 但缺 DEEPSEEK_API_KEY' });
  }
});

export function validateEnvOnBoot(): { ok: true } | { ok: false; errors: string[] } {
  const result = BootEnv.safeParse(process.env);
  if (result.success) return { ok: true };
  const errors = result.error.issues.map((i) => i.message);
  return { ok: false, errors };
}
