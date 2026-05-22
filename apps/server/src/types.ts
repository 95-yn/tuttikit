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
  extractedTruncated?: boolean;          // 提取文本被 MAX_EXTRACTED_CHARS 截断
  extractedOriginalChars?: number;       // 截断前的原始字符数
  pages?: number;
  ocrConfidence?: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Anthropic prompt cache：命中已缓存的 input token 数（按 10% 计费） */
  cacheReadInputTokens?: number;
  /** Anthropic prompt cache：写入缓存的 input token 数（按 125% 计费） */
  cacheCreationInputTokens?: number;
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
  parameters: object;                 // JSON Schema（给 LLM 看）
  /**
   * 运行时 zod 校验。LLM 返回的 args 不可信，传错类型时这里会拦下；
   * 配合 Conductor 自修复机制（见 agents/conductor.ts）把错误塞回 tool_result 让 LLM 自己改。
   * 未提供时跳过校验（保留旧工具兼容）。
   */
  inputSchema?: import('zod').ZodType<TIn>;
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
  /**
   * 当前 turn 所属的 session id。
   * 由 conductor 在 toolRegistry.invoke(...) 时注入；sub-agent 通过 delegate 走时由 ctx 透传下来。
   * hook 内（before:tool:call）用它实现 session-scoped 行为，如审批锁、SSE 路由。
   */
  sessionId?: string;
  /**
   * 用户 stop / 服务 drain 时会触发 abort。
   * 工具应在长操作（fetch / 子进程 / 大文件读）开始前检查 signal.aborted；
   * 调用支持 AbortSignal 的 API（fetch / child_process）时直接把 signal 传过去。
   */
  signal?: AbortSignal;
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
  id?: string;
  tags?: string[];
  /** 内存 / 持久化的 embedding（归一化后）。新写入的条目会带；老条目按需 lazy backfill */
  vec?: number[];
  /** 生成该 vec 用的 embedding provider 标识，避免不同模型混用 */
  vecModel?: string;
  [k: string]: unknown;
}

// ───── 上传元数据（落盘格式） ─────
export interface UploadMeta extends Attachment {
  storedAs: string;
  createdAt: string;
}
