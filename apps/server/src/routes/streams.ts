/**
 * SSE 流路由：
 *   - POST 不存在；GET /sessions/:id/stream?message=... 是 EventSource 接口
 *   - GET /events 全局事件广播（多设备同步用，跨 session）
 *
 * 拆自 server.ts 主体——逻辑保持原样，只是搬位置。
 */
import type { Express } from 'express';
import { sessionManager } from '../core/session.js';
import { getUpload } from '../core/uploads.js';
import { MessageBus } from '../core/messageBus.js';
import { attachSSE } from '../streaming/sse.js';
import { createLLM } from '../llm/index.js';
import { buildToolRegistryWithSubAgents } from '../tools/index.js';
import { longTermMemory } from '../memory/longTerm.js';
import { ConductorAgent } from '../agents/index.js';
import { tracer } from '../observability/tracer.js';
import { logger } from '../observability/logger.js';
import { broadcaster, type BroadcastEvent } from '../core/broadcaster.js';
import { sseLimiter } from '../middleware/sseLimiter.js';
import type { Attachment } from '../types.js';

export function register(app: Express): void {
  app.get('/sessions/:id/stream', sseLimiter, async (req, res) => {
    const sessionId = String(req.params.id);
    const message = String(req.query.message || '');
    const provider = req.query.provider ? String(req.query.provider) : undefined;
    const attachmentIds = String(req.query.attachmentIds || '')
      .split(',').map((s) => s.trim()).filter(Boolean);

    if (!message.trim() && attachmentIds.length === 0) {
      return res.status(400).end('message or attachments required');
    }

    const session = await sessionManager.get(sessionId);
    if (!session) return res.status(404).end('session not found');

    const attachments: Attachment[] = [];
    for (const id of attachmentIds) {
      const meta = await getUpload(id);
      if (meta) {
        attachments.push({
          id: meta.id, kind: meta.kind, mediaType: meta.mediaType,
          filename: meta.filename, sizeBytes: meta.sizeBytes,
        });
      }
    }

    const bus = new MessageBus();
    attachSSE(bus, res);

    // createLLM 现在带缓存（P1）：同 (provider, fallbackChain) 复用同一实例
    const llm = createLLM(provider);
    const toolRegistry = buildToolRegistryWithSubAgents({ llm, longTermMemory, bus });
    const conductor = new ConductorAgent({ llm, toolRegistry, sessionManager, bus });

    const turnAbort = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) {
        turnAbort.abort(new Error('client disconnected'));
      }
    });

    const trace = tracer.startTrace('conductor.turn', { sessionId, message });
    try {
      await conductor.respond({
        sessionId, userMessage: message, attachments,
        stream: true, trace, tracer,
        signal: turnAbort.signal,
      });
    } catch (err) {
      logger.error({ err }, 'turn failed');
      bus.emit('turn:error', { sessionId, error: (err as Error).message });
    } finally {
      tracer.endTrace(trace);
      broadcaster.sessionUpdated(sessionId);
      broadcaster.sessionsChanged('turn-done', sessionId);
    }
  });

  // 全局事件广播（多设备同步）
  app.get('/events', sseLimiter, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);

    const onEvent = (payload: BroadcastEvent): void => {
      res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    broadcaster.on('event', onEvent);

    const hb = setInterval(() => res.write(': hb\n\n'), 15_000);

    req.on('close', () => {
      clearInterval(hb);
      broadcaster.off('event', onEvent);
    });
  });
}
