import { nanoid } from 'nanoid';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import type { Usage } from '../types.js';

const TRACE_DIR = path.resolve('./data/traces');

export interface Span {
  spanId: string;
  parentId: string | null;
  kind: 'agent' | 'llm' | 'tool' | string;
  name: string;
  attrs: Record<string, unknown>;
  startedAt: number;
  endedAt: number | null;
  duration: number;
  status: 'running' | 'ok' | 'error';
  error: string | null;
  usage: Usage | null;
  output?: unknown;
}

export interface TraceTotals {
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  toolCalls: number;
}

export interface Trace {
  traceId: string;
  name: string;
  meta: Record<string, unknown>;
  startedAt: number;
  endedAt: number | null;
  spans: Span[];
  totals: TraceTotals;
  duration?: number;
}

export interface EndSpanOpts {
  status?: 'ok' | 'error';
  error?: unknown;
  usage?: Usage | null;
  output?: unknown;
}

class TracerImpl {
  traces: Map<string, Trace>;
  constructor() {
    this.traces = new Map();
  }

  startTrace(name: string, meta: Record<string, unknown> = {}): Trace {
    const traceId = nanoid(10);
    const trace: Trace = {
      traceId,
      name,
      meta,
      startedAt: Date.now(),
      endedAt: null,
      spans: [],
      totals: { inputTokens: 0, outputTokens: 0, llmCalls: 0, toolCalls: 0 },
    };
    this.traces.set(traceId, trace);
    return trace;
  }

  startSpan(trace: Trace, kind: string, name: string, attrs: Record<string, unknown> = {}): Span {
    const span: Span = {
      spanId: nanoid(8),
      parentId: (attrs.parentId as string | undefined) || null,
      kind,
      name,
      attrs,
      startedAt: Date.now(),
      endedAt: null,
      duration: 0,
      status: 'running',
      error: null,
      usage: null,
    };
    trace.spans.push(span);
    return span;
  }

  endSpan(trace: Trace, span: Span, { status = 'ok', error = null, usage = null, output = null }: EndSpanOpts = {}): void {
    span.endedAt = Date.now();
    span.duration = span.endedAt - span.startedAt;
    span.status = status;
    span.error = error ? String((error as { message?: string })?.message || error) : null;
    span.usage = usage;
    if (output !== null) span.output = output;
    if (usage) {
      trace.totals.inputTokens += usage.inputTokens || 0;
      trace.totals.outputTokens += usage.outputTokens || 0;
    }
    if (span.kind === 'llm') trace.totals.llmCalls += 1;
    if (span.kind === 'tool') trace.totals.toolCalls += 1;
    logger.debug(
      { traceId: trace.traceId, spanId: span.spanId, kind: span.kind, duration: span.duration, status },
      `[span] ${span.name}`,
    );
  }

  endTrace(trace: Trace): Trace {
    trace.endedAt = Date.now();
    trace.duration = trace.endedAt - trace.startedAt;
    this._persist(trace);
    logger.info(
      { traceId: trace.traceId, duration: trace.duration, totals: trace.totals },
      `[trace] ${trace.name} 完成`,
    );
    return trace;
  }

  get(traceId: string): Trace | undefined {
    return this.traces.get(traceId);
  }

  list(): Array<Pick<Trace, 'traceId' | 'name' | 'startedAt' | 'totals'> & { duration: number; spanCount: number }> {
    return [...this.traces.values()].map((t) => ({
      traceId: t.traceId,
      name: t.name,
      startedAt: t.startedAt,
      duration: t.duration ?? (Date.now() - t.startedAt),
      totals: t.totals,
      spanCount: t.spans.length,
    }));
  }

  private _persist(trace: Trace): void {
    try {
      if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(TRACE_DIR, `${trace.traceId}.json`),
        JSON.stringify(trace, null, 2),
      );
    } catch (err) {
      logger.warn({ err }, '[tracer] 持久化失败');
    }
  }
}

export const tracer = new TracerImpl();
export type Tracer = TracerImpl;
