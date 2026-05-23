import type { Response } from 'express';
import type { MessageBus } from '../core/messageBus.js';

const EVENTS = [
  'message:user',
  'message:start',
  'message:token',
  'message:end',
  'tool:start',
  'tool:end',
  'tool:error',
  'delegate:done',
  'turn:done',
  'turn:error',
  // #4 + #5：critique / budget / auto-review / plan
  'critique:revise',
  'critique:ok',
  'budget:warn',
  'review:needed',
  'plan:created',
  'plan:step:start',
  'plan:step:end',
  'plan:revised',
  // 上下文压缩 / 召回（C+D）
  'context:compacted',
  'context:recalled',
  // 安全拦截
  'safety:denied',
  // 动态审批
  'permission:requested',
  'permission:resolved',
  // 沙箱代码执行：matplotlib 图实时推
  'code:image',
  // Model routing 决策
  'router:routed',
  // Plan-level checkpoint 用户中止
  'plan:checkpoint:abort',
  // Reflexion 写下反思
  'reflexion:noted',
  // 自动 long-term memory 保存
  'memory:auto-saved',
] as const;

type EventName = (typeof EVENTS)[number];

export function attachSSE(bus: MessageBus, res: Response): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const handlers: Record<EventName, (payload: unknown) => void> =
    Object.fromEntries(EVENTS.map((evt) => [evt, (payload: unknown) => {
      res.write(`event: ${evt}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }])) as Record<EventName, (payload: unknown) => void>;
  for (const evt of EVENTS) bus.on(evt, handlers[evt]);

  const cleanup = (): void => {
    for (const evt of EVENTS) bus.off(evt, handlers[evt]);
    try { res.end(); } catch {/* ignore */}
  };
  res.on('close', cleanup);
  bus.on('turn:done', cleanup);
  bus.on('turn:error', cleanup);
  return cleanup;
}
