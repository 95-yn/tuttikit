import { generateText, streamText, jsonSchema } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { BaseLLM } from './base.js';
import { readUploadBuffer } from '../core/uploads.js';
import type {
  LLMCallArgs, LLMResponse, LLMOnDelta, LLMToolDef, Message, ToolCall, Usage,
} from '../types.js';

// provider 多模态能力
const PROVIDER_CAPS: Record<string, { image: boolean; pdf: boolean }> = {
  anthropic: { image: true, pdf: true },
  openai:    { image: true, pdf: false },
  deepseek:  { image: false, pdf: false },
  mock:      { image: false, pdf: false },
};

export interface ProviderCfg {
  apiKey?: string;
  model: string;
  baseURL?: string;
}

export function createAISDKModel(providerName: string, providerCfg: ProviderCfg): {
  model: ReturnType<ReturnType<typeof createAnthropic>>; name: string;
} {
  switch (providerName) {
    case 'anthropic': {
      const anth = createAnthropic({ apiKey: providerCfg.apiKey });
      return { model: anth(providerCfg.model), name: 'anthropic' };
    }
    case 'openai': {
      const oa = createOpenAI({ apiKey: providerCfg.apiKey, baseURL: providerCfg.baseURL });
      return { model: oa.chat(providerCfg.model), name: 'openai' };
    }
    case 'deepseek': {
      const ds = createOpenAICompatible({
        name: 'deepseek',
        apiKey: providerCfg.apiKey,
        baseURL: providerCfg.baseURL || 'https://api.deepseek.com/v1',
      });
      return { model: ds(providerCfg.model), name: 'deepseek' };
    }
    default:
      throw new Error(`AI SDK 不支持的 provider: ${providerName}`);
  }
}

// 因为 AI SDK 各 model 类型复杂且各家不同，对外只用 unknown，内部不做静态校验
type AISDKModel = unknown;

export class AISDKProvider extends BaseLLM {
  model: AISDKModel;

  constructor({ model, name }: { model: AISDKModel; name: string }) {
    super(name);
    this.model = model;
  }

  private _toAITools(specs: LLMToolDef[] = []): Record<string, unknown> | undefined {
    if (!specs.length) return undefined;
    const out: Record<string, unknown> = {};
    for (const s of specs) {
      out[s.name] = {
        description: s.description,
        inputSchema: jsonSchema(s.parameters as Parameters<typeof jsonSchema>[0]),
      };
    }
    return out;
  }

  async _toModelMessages(messages: Message[]): Promise<unknown[]> {
    const caps = PROVIDER_CAPS[this.name] || { image: false, pdf: false };
    const out: unknown[] = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        out.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: m.toolCallId,
              toolName: m.toolName || 'unknown',
              output: { type: 'json', value: tryParseJson(m.content) },
            },
          ],
        });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const parts: unknown[] = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.input,
          });
        }
        out.push({ role: 'assistant', content: parts });
        continue;
      }
      if (m.role === 'user' && m.attachments?.length) {
        const parts: unknown[] = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        const extractedBlocks: string[] = [];
        for (const a of m.attachments) {
          const data = await readUploadBuffer(a.id);
          if (!data) continue;

          const supportsNative = (a.kind === 'image' && caps.image) || (a.kind === 'pdf' && caps.pdf);
          if (supportsNative) {
            if (a.kind === 'image') {
              parts.push({ type: 'image', image: data.buffer, mediaType: a.mediaType });
            } else {
              parts.push({
                type: 'file', data: data.buffer, mediaType: a.mediaType, filename: a.filename,
              });
            }
          }

          const txt = (data.extractedText || '').trim();
          if (txt) {
            const kindLabel = a.kind === 'pdf' ? 'PDF' : 'IMAGE';
            extractedBlocks.push(
              `<attachment kind="${kindLabel}" filename="${a.filename}">\n${txt}\n</attachment>`,
            );
          } else if (!supportsNative) {
            extractedBlocks.push(
              `<attachment kind="${a.kind}" filename="${a.filename}">[内容无法读取${data.extractError ? '：' + data.extractError : ''}]</attachment>`,
            );
          }
        }
        if (extractedBlocks.length) {
          parts.push({
            type: 'text',
            text:
              '\n[以下是用户上传附件的解析内容，作为上下文参考；引用时请指明来自哪个文件]\n' +
              extractedBlocks.join('\n\n'),
          });
        }
        out.push({ role: 'user', content: parts.length ? parts : (m.content || '') });
        continue;
      }
      out.push({ role: m.role, content: m.content });
    }
    return out;
  }

  private _normUsage(u?: { inputTokens?: number; outputTokens?: number } | null): Usage {
    return {
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
    };
  }

  private _normToolCalls(toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = []): ToolCall[] {
    return toolCalls.map((tc) => ({ id: tc.toolCallId, name: tc.toolName, input: tc.input }));
  }

  async chat({ system, messages, tools, temperature = 0.2, maxTokens = 2048 }: LLMCallArgs): Promise<LLMResponse> {
    const result = await generateText({
      model: this.model as never,
      system,
      messages: (await this._toModelMessages(messages)) as never,
      tools: this._toAITools(tools) as never,
      temperature,
      maxOutputTokens: maxTokens,
    });
    return {
      role: 'assistant',
      content: result.text || '',
      toolCalls: this._normToolCalls(result.toolCalls as never),
      usage: this._normUsage(result.usage),
      raw: result,
    };
  }

  async stream(input: LLMCallArgs, onDelta?: LLMOnDelta): Promise<LLMResponse> {
    const { system, messages, tools, temperature = 0.2, maxTokens = 2048 } = input;
    try {
      const mapped = await this._toModelMessages(messages);
      const result = streamText({
        model: this.model as never,
        system,
        messages: mapped as never,
        tools: this._toAITools(tools) as never,
        temperature,
        maxOutputTokens: maxTokens,
      });

      for await (const chunk of result.textStream) {
        onDelta?.(chunk);
      }

      const [text, toolCalls, usage] = await Promise.all([
        result.text, result.toolCalls, result.usage,
      ]);

      if (!text && !toolCalls?.length) {
        console.warn(`[aisdk:${this.name}] 流式返回空体，自动 fallback 到非流式 chat`);
        return this.chat(input);
      }

      return {
        role: 'assistant',
        content: text || '',
        toolCalls: this._normToolCalls(toolCalls as never),
        usage: this._normUsage(usage),
        raw: null,
      };
    } catch (err) {
      if (isFallbackableStreamError(err)) {
        const e = err as { name?: string; message?: string };
        console.warn(
          `[aisdk:${this.name}] 流式失败 (${e?.name || 'Error'}: ${e?.message}), fallback 到非流式 chat`,
        );
        return this.chat(input);
      }
      throw err;
    }
  }
}

function isFallbackableStreamError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string };
  const name = e.name || '';
  const msg = e.message || '';
  return (
    name === 'AI_NoOutputGeneratedError' ||
    name === 'NoOutputGeneratedError' ||
    msg.includes('No output generated') ||
    msg.includes('stream ended unexpectedly')
  );
}

function tryParseJson(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return { text: s }; }
}
