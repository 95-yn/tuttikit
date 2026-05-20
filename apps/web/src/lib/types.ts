// 与 apps/server/src/streaming/sse.js 的事件协议一一对应

export type Role = 'user' | 'assistant' | 'tool';

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
  // 服务端上传时同步抽取的元信息
  extractedChars?: number;        // 抽到的字符数（0 = 没抽到）
  extractError?: string | null;   // 解析失败原因
  pages?: number;                 // PDF 页数
  ocrConfidence?: number;         // OCR 置信度（0-100）
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
    createdAt?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  };
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  messageCount?: number;
  messages: Message[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  messageCount: number;
}

// ───── SSE event payloads ─────
export interface MessageStartEvt { sessionId: string; id: string; role: 'assistant'; }
export interface MessageTokenEvt { sessionId: string; id: string; chunk: string; }
export interface MessageEndEvt {
  sessionId: string; id: string; content: string;
  toolCalls?: ToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
}
export interface ToolStartEvt { sessionId: string; toolCallId: string; name: string; input: unknown; }
export interface ToolEndEvt   { sessionId: string; toolCallId: string; result: unknown; }
export interface ToolErrorEvt { sessionId: string; toolCallId: string; error: string; }
export interface TurnDoneEvt  { sessionId: string; usage?: unknown; steps?: number; }
export interface TurnErrorEvt { sessionId: string; error: string; }
