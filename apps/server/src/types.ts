// 后端共享类型：与 apps/web/src/lib/types.ts 对应（手工保持同步即可，量小）

export type Role = 'user' | 'assistant' | 'tool' | 'system';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface Attachment {
  id: string;
  kind: 'image' | 'pdf';
  mediaType: string;
  filename: string;
  sizeBytes: number;
  extractedText?: string;
  extractedChars?: number;
  extractError?: string | null;
  pages?: number;
  ocrConfidence?: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface Message {
  role: Role;
  content?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  attachments?: Attachment[];
  meta?: {
    id?: string;
    createdAt?: number | string;
    usage?: Usage;
    [k: string]: unknown;
  };
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  messages: Message[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  messageCount: number;
}

// ───── 工具规格 ─────
// 注意：input/output 默认 any，让具体工具的窄类型可以无障碍 register 进通用 Registry
export interface ToolSpec<TIn = any, TOut = any> {  // eslint-disable-line @typescript-eslint/no-explicit-any
  name: string;
  description: string;
  parameters: object;                 // JSON Schema
  allowedAgents: string[];            // 哪些 agent role 能用
  handler: (input: TIn, ctx: ToolCtx) => Promise<TOut> | TOut;
}

// Trace/Span/Tracer 的规范定义在 ./observability/tracer.ts，避免在两处维护
export interface ToolCtx {
  agent?: string;
  trace?: import('./observability/tracer.js').Trace;
  tracer?: import('./observability/tracer.js').Tracer;
  parentSpanId?: string;
  bus?: import('./core/messageBus.js').MessageBus;
  [k: string]: unknown;
}

// ───── LLM ─────
export interface LLMToolDef {
  name: string;
  description?: string;
  parameters: object;
}

export interface LLMCallArgs {
  system?: string;
  messages: Message[];
  tools?: LLMToolDef[];
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  role: 'assistant';
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  raw?: unknown;
}

export type LLMOnDelta = (chunk: string) => void;

export interface LLMLike {
  name: string;
  chat: (args: LLMCallArgs) => Promise<LLMResponse>;
  stream: (args: LLMCallArgs, onDelta?: LLMOnDelta) => Promise<LLMResponse>;
}

// ───── 长期记忆条目 ─────
export interface MemoryEntry {
  source: string;
  text: string;
  createdAt: number;
  [k: string]: unknown;
}

// ───── 上传元数据（落盘格式） ─────
export interface UploadMeta extends Attachment {
  storedAs: string;
  createdAt: string;
}
