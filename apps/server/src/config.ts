import 'dotenv/config';

export interface AppConfig {
  llm: {
    provider: string;
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
}

export const config: AppConfig = {
  llm: {
    provider: process.env.LLM_PROVIDER || 'mock',
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
};
