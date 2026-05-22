import type { Express } from 'express';
import { tracer } from '../observability/tracer.js';
import { sessionManager } from '../core/session.js';
import { ConductorAgent } from '../agents/index.js';
import { createLLM } from '../llm/index.js';
import { MessageBus } from '../core/messageBus.js';
import { buildToolRegistryWithSubAgents } from '../tools/index.js';
import { longTermMemory } from '../memory/longTerm.js';

/**
 * Trace 查询 + Replay。
 *   GET  /traces
 *   GET  /traces/:id
 *   POST /traces/:id/replay
 */
export function register(app: Express): void {
  // ───── Trace 查询 ─────
  app.get('/traces', (_req, res) => res.json(tracer.list()));
  app.get('/traces/:id', (req, res) => {
    const t = tracer.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  });

  /**
   * Trace Replay：用 1 个或多个 provider 把原始 user message 各重跑一次，
   * 每次写入独立 trace（标记 replayOf）。多 provider 用于 A/B 对比。
   *
   *   POST /traces/:id/replay
   *   body: { provider?: string }                   ← 单 provider（向后兼容）
   *   body: { providers: string[] }                 ← 多 provider 并发 replay
   *
   * 返回：
   *   { replayTraceId, forkedSessionId, provider }                    （单 provider，老调用方）
   *   { replays: [{ replayTraceId, forkedSessionId, provider, error? }, ...] }   （多 provider）
   */
  app.post('/traces/:id/replay', async (req, res) => {
    const original = tracer.get(req.params.id);
    if (!original) return res.status(404).json({ error: 'trace not found' });
    const originalMessage = (original.meta as { message?: string })?.message;
    if (!originalMessage) {
      return res.status(400).json({ error: 'trace 缺 meta.message，无法 replay' });
    }

    // 入参归一化：providers 数组优先；否则用单 provider；都没传走默认
    let providers: Array<string | undefined>;
    let multiMode = false;
    if (Array.isArray(req.body?.providers) && req.body.providers.length > 0) {
      providers = req.body.providers.map((p: unknown) => p ? String(p) : undefined);
      multiMode = true;
    } else {
      providers = [req.body?.provider ? String(req.body.provider) : undefined];
    }

    // 并发跑所有 replay；每个独立的 forked session + trace
    const tasks = providers.map(async (providerName) => {
      try {
        const forked = await sessionManager.create({
          title: `replay of ${req.params.id}${providerName ? ` (${providerName})` : ''}`,
        });
        const bus = new MessageBus();
        const llm = createLLM(providerName);
        const toolRegistry = buildToolRegistryWithSubAgents({ llm, longTermMemory, bus });
        const conductor = new ConductorAgent({ llm, toolRegistry, sessionManager, bus });

        const replayTrace = tracer.startTrace('conductor.replay', {
          sessionId: forked.id,
          message: originalMessage,
          replayOf: req.params.id,
          provider: providerName || 'default',
        });
        try {
          await conductor.respond({
            sessionId: forked.id, userMessage: originalMessage,
            stream: false, trace: replayTrace, tracer,
          });
        } finally {
          tracer.endTrace(replayTrace);
        }
        return {
          replayTraceId: replayTrace.traceId,
          forkedSessionId: forked.id,
          provider: providerName || 'default',
        };
      } catch (err) {
        return {
          provider: providerName || 'default',
          error: (err as Error).message,
        };
      }
    });
    const results = await Promise.all(tasks);

    if (multiMode) {
      return res.json({ replays: results });
    }
    // 单 provider 向后兼容：拿第一个；如果出错也返 200（兼容旧前端）
    const first = results[0];
    if ('error' in first) return res.status(500).json({ error: first.error });
    return res.json(first);
  });
}
