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
