import { nanoid } from 'nanoid';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';
import { config } from '../config.js';
import type { Usage } from '../types.js';

const TRACE_DIR = path.resolve('./data/traces');

// 内存 + 磁盘双层 retention（修 T1/T2/M4）—— 配置来自 config.tracer
const MEMORY_MAX_TRACES = config.tracer.maxInMemory;
const DISK_RETENTION_DAYS = config.tracer.diskRetentionDays;

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
  /** 写盘任务记账：用于 graceful shutdown 等所有写完 */
  private _writeQueue = new Set<Promise<void>>();

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
    this._evictIfOver();
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
    // 不再 await 写盘——fire-and-forget 让 turn 立即结束
    this._persistAsync(trace);
    logger.info(
      { traceId: trace.traceId, duration: trace.duration, totals: trace.totals },
      `[trace] ${trace.name} 完成`,
    );
    return trace;
  }

  get(traceId: string): Trace | undefined {
    // 内存没有 → 试着从磁盘读（trace 详情页打开历史 trace 也走这里）
    const inMem = this.traces.get(traceId);
    if (inMem) return inMem;
    try {
      const p = path.join(TRACE_DIR, `${traceId}.json`);
      if (!fs.existsSync(p)) return undefined;
      const raw = fs.readFileSync(p, 'utf-8');
      return JSON.parse(raw) as Trace;
    } catch (err) {
      logger.warn({ err, traceId }, '[tracer] 从磁盘读 trace 失败');
      return undefined;
    }
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

  /** 测试 / 优雅退出：等所有 in-flight 写盘完成 */
  async flushPersistQueue(): Promise<void> {
    if (this._writeQueue.size > 0) {
      await Promise.all([...this._writeQueue]);
    }
  }

  /** LRU evict：超过上限时丢最老的（已 ended 的优先丢；running 中的保留） */
  private _evictIfOver(): void {
    if (this.traces.size <= MEMORY_MAX_TRACES) return;
    const overflow = this.traces.size - MEMORY_MAX_TRACES;
    // 优先 evict 已 ended 的；按插入顺序（Map 保证顺序）取最老的
    const candidates: string[] = [];
    for (const [id, t] of this.traces) {
      if (t.endedAt !== null) candidates.push(id);
      if (candidates.length >= overflow) break;
    }
    for (const id of candidates) this.traces.delete(id);
  }

  /** fire-and-forget 异步写盘：不阻塞 caller，失败只 log */
  private _persistAsync(trace: Trace): void {
    const snapshot = JSON.stringify(trace, null, 2);    // 在当前微任务序列化，避免 trace 后续被 mutate
    const task = (async () => {
      try {
        await fsp.mkdir(TRACE_DIR, { recursive: true });
        const tmp = path.join(TRACE_DIR, `${trace.traceId}.json.tmp`);
        const final = path.join(TRACE_DIR, `${trace.traceId}.json`);
        await fsp.writeFile(tmp, snapshot);
        await fsp.rename(tmp, final);    // 原子，不留半截
      } catch (err) {
        logger.warn({ err: (err as Error).message, traceId: trace.traceId }, '[tracer] 持久化失败');
      }
    })();
    this._writeQueue.add(task);
    void task.finally(() => this._writeQueue.delete(task));
  }
}

/**
 * 启动时清理超过 retention 期的磁盘 trace 文件（M4）。
 * 单独 export 让 server.ts boot 调一次；返回清理数量便于日志。
 */
export async function pruneOldTraces(retentionDays: number = DISK_RETENTION_DAYS): Promise<number> {
  if (!fs.existsSync(TRACE_DIR) || retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 86400_000;
  let removed = 0;
  try {
    const files = await fsp.readdir(TRACE_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(TRACE_DIR, f);
      try {
        const stat = await fsp.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fsp.unlink(full);
          removed++;
        }
      } catch {/* 单文件失败跳过 */}
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[tracer] prune 失败');
  }
  return removed;
}

export const tracer = new TracerImpl();
export type Tracer = TracerImpl;
