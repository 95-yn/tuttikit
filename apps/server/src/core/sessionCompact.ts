/**
 * 上下文管理（C+D 混合策略）：长对话不再硬塞 LLM。
 *
 * 设计原则（综合 Claude Code / Manus / OpenHands 经验）：
 *   1) **稳定前缀**：system prompt 永远不动（让 Anthropic prompt cache 命中）
 *   2) **可逆压缩**：被压缩的老消息全文 + embedding 都进 archive，按 query 还能召回（Manus 原则）
 *   3) **触发提前**：到 contextWindow * 0.6 就开始压（Claude Code 推荐 60%）
 *   4) **保留尾部**：最近 K 条原样保留，质量不降（OpenHands condenser 思路）
 *   5) **批量摘要**：老消息每 N 条让便宜 LLM 合成 1 段 ~200 字摘要
 *   6) **召回（RAG）**：每轮把用户最新 query 拿去匹配 archive，top-K 拼回 prompt
 *
 * 数据结构：
 *   session.messages         保留：[system 不存这]、[summary 注入]、最近 K 条 user/assistant/tool
 *   session.meta.archive     新加：被压缩走的老消息全文 + embedding
 *
 * 触发时机（conductor._runReactSteps 入口）：
 *   estimatedTokens(messages) > contextWindow * COMPACT_TRIGGER_RATIO
 */
import crypto from 'node:crypto';
import { logger } from '../observability/logger.js';
import { config } from '../config.js';
import { sessionManager as defaultSessionManager, type SessionManager } from './session.js';
import { createEmbedding, cosineSim, type EmbeddingProvider } from '../llm/embedding.js';
import type { LLMLike, Message, Session } from '../types.js';

// ───── 配置（来自 config.compact，env 集中读）─────
// archive 分层降级：layer 1 = recent K（原样）、layer 2 = summaries + archive entries（可召回）、
// layer 3 = 仅 summaries（archive entries 已 GC，原文不可恢复）
export const COMPACT_TRIGGER_RATIO       = config.compact.triggerRatio;
export const COMPACT_KEEP_RECENT_N       = config.compact.keepRecentN;
export const COMPACT_BATCH_SIZE          = config.compact.batchSize;
export const RECALL_TOP_K                = config.compact.recallTopK;
export const RECALL_MIN_SIM              = config.compact.recallMinSim;
export const ARCHIVE_MAX_ENTRIES         = config.compact.archiveMaxEntries;
export const ARCHIVE_GC_KEEP_SUMMARIES   = config.compact.archiveGcKeepSummaries;

/** 粗略 token 估算：英文 ~4 char/token，中文 ~1.5 char/token；混合按 3 char/token 折中 */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content || '').length;
    chars += JSON.stringify(m.toolCalls ?? []).length;
  }
  return Math.ceil(chars / 3);
}

/** Archive 一条消息：存全文 + embedding，给后续 RAG 召回用 */
export interface ArchivedMessage {
  id: string;
  role: Message['role'];
  content: string;
  /** 原序号（在被压缩前 session 里的位置）；调试用 */
  originalIndex: number;
  /** 原始时间戳（如果有） */
  createdAt?: number | string;
  /** 文本 embedding；missing 时不参与 RAG */
  vec?: number[];
  vecModel?: string;
  /** 一同被压缩进哪段 summary（前端要展示「展开原文」时反查用） */
  summaryId?: string;
}

export interface CompactSummary {
  id: string;
  /** 原始 source messages 的 id 范围；调试 / "展开" 时用 */
  rangeStart: number;
  rangeEnd: number;
  /** LLM 生成的摘要文本 */
  text: string;
  /** 摘要本身的 embedding（让 summary 也参与 RAG，多一条召回路径） */
  vec?: number[];
  vecModel?: string;
  createdAt: number;
}

interface SessionArchiveMeta {
  archive: ArchivedMessage[];
  summaries: CompactSummary[];
  /** 当前 session.messages 中第一条原始消息对应的 originalIndex（>= 这个值的是"还没被压"的） */
  cursorOriginalIndex: number;
}

function emptyArchive(): SessionArchiveMeta {
  return { archive: [], summaries: [], cursorOriginalIndex: 0 };
}

export function getArchive(session: Session): SessionArchiveMeta {
  const raw = (session as Session & { archive?: SessionArchiveMeta }).archive;
  return raw ?? emptyArchive();
}

function shortId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/** 把一段 message[]（同一批要压缩的老消息）拼成给 LLM 看的文本 */
function joinForSummarize(batch: Message[]): string {
  return batch.map((m, i) => {
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? `[工具结果 ${m.toolName ?? ''}]` : `[${m.role}]`;
    const text = (m.content || '').slice(0, 1200);
    const tools = m.toolCalls?.length
      ? `\n  调用了工具: ${m.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.input).slice(0, 100)})`).join(', ')}`
      : '';
    return `${i + 1}. ${role}: ${text}${tools}`;
  }).join('\n');
}

const SUMMARY_PROMPT = `把下面这段多轮对话压缩成一段不超过 200 字的中文摘要。
要求：
  1. 保留事实性信息（决定了什么、写了什么文件、调用了什么工具的关键结果、用户的偏好）
  2. 删除寒暄、确认、重复
  3. 用一段话陈述，不要 1.2.3. 列表
  4. **不要总结成"用户问了 X，AI 答了 Y"这种废话**，直接把内容写出来
仅输出摘要正文，不要前后引号或解释。`;

/** 让 LLM 生成一段摘要 */
async function summarizeBatch(llm: LLMLike, batch: Message[]): Promise<string> {
  if (llm.name === 'mock') {
    // mock 不真翻；给一个可识别的占位
    return `[mock 摘要：合并了 ${batch.length} 条历史消息]`;
  }
  try {
    const res = await llm.chat({
      system: SUMMARY_PROMPT,
      messages: [{ role: 'user', content: joinForSummarize(batch) }],
      temperature: 0,
      maxTokens: 400,
    });
    return (res.content || '').trim() || `[摘要生成失败：合并了 ${batch.length} 条消息]`;
  } catch (err) {
    logger.warn({ err, batchSize: batch.length }, '[compact] summarize 失败，用占位');
    return `[摘要生成失败（${(err as Error).message.slice(0, 60)}）：合并了 ${batch.length} 条消息]`;
  }
}

let _embedding: EmbeddingProvider | null = null;
function getEmbedding(): EmbeddingProvider {
  if (!_embedding) _embedding = createEmbedding();
  return _embedding;
}

export interface CompactResult {
  triggered: boolean;
  archivedCount: number;
  summariesCreated: number;
  beforeTokens: number;
  afterTokens: number;
  /** session.messages 重写后的内容 */
  newMessages?: Message[];
  /** 新增的 archive 元数据；调用方负责 merge 写回 session */
  archiveDelta?: SessionArchiveMeta;
}

/**
 * 压缩流程：
 *   1. 估算当前 session.messages 的 tokens
 *   2. 如果 < contextWindow * 0.6，return triggered=false 不动
 *   3. 否则：
 *      - 保留最近 keepRecentN 条
 *      - 老的按 batchSize 一组喂给 LLM 摘要
 *      - 摘要本身作为新的 user 消息插入到 messages 头（保持时序），原老消息进 archive
 *      - 同时给 archived 消息和 summary 都算 embedding
 */
export async function compactIfNeeded(args: {
  sessionId: string;
  contextWindow: number;
  llm: LLMLike;
  keepRecentN?: number;
  batchSize?: number;
  /** 默认用全局 sessionManager；测试可注入本地 SessionManager */
  sessionManager?: SessionManager;
}): Promise<CompactResult> {
  const sm = args.sessionManager ?? defaultSessionManager;
  const session = await sm.get(args.sessionId);
  if (!session) return { triggered: false, archivedCount: 0, summariesCreated: 0, beforeTokens: 0, afterTokens: 0 };

  const beforeTokens = estimateTokens(session.messages);
  const threshold = Math.floor(args.contextWindow * COMPACT_TRIGGER_RATIO);
  if (beforeTokens <= threshold) {
    return { triggered: false, archivedCount: 0, summariesCreated: 0, beforeTokens, afterTokens: beforeTokens };
  }

  const keepN = args.keepRecentN ?? COMPACT_KEEP_RECENT_N;
  const batchN = args.batchSize ?? COMPACT_BATCH_SIZE;
  const totalCount = session.messages.length;
  if (totalCount <= keepN) {
    return { triggered: false, archivedCount: 0, summariesCreated: 0, beforeTokens, afterTokens: beforeTokens };
  }

  const oldMessages = session.messages.slice(0, totalCount - keepN);
  const recentMessages = session.messages.slice(totalCount - keepN);
  const archive = getArchive(session);
  const cursorBase = archive.cursorOriginalIndex;

  // 切批 + 摘要 + embedding（并发但限流）
  const ep = getEmbedding();
  const newSummaries: CompactSummary[] = [];
  const newArchived: ArchivedMessage[] = [];

  for (let i = 0; i < oldMessages.length; i += batchN) {
    const batch = oldMessages.slice(i, i + batchN);
    const sumId = shortId();
    const sumText = await summarizeBatch(args.llm, batch);

    // M1 优化：把 summary 的 embed 和 batch 全文的 embed **合并成一次 RTT**
    // OpenAI embedding API 接受数组，[summary, msg0, msg1, ...] 一次返回 N+1 个向量；
    // 减半 RTT，对大 batch / 远端 embedding provider 提速明显
    const archiveTexts = batch.map((m) => (m.content || '').slice(0, 4000));
    let sumVec: number[] | undefined;
    let vecs: number[][] = batch.map(() => []);
    try {
      const all = await ep.embed([sumText, ...archiveTexts]);
      sumVec = all[0];
      vecs = all.slice(1);
    } catch {/* 整批失败时各路都不带 vec；不影响功能（关键词路径仍可工作） */}

    newSummaries.push({
      id: sumId,
      rangeStart: cursorBase + i,
      rangeEnd: cursorBase + i + batch.length - 1,
      text: sumText,
      vec: sumVec,
      vecModel: sumVec ? ep.name : undefined,
      createdAt: Date.now(),
    });

    batch.forEach((m, j) => {
      newArchived.push({
        id: shortId(),
        role: m.role,
        content: m.content || '',
        originalIndex: cursorBase + i + j,
        createdAt: m.meta?.createdAt as number | string | undefined,
        vec: vecs[j]?.length ? vecs[j] : undefined,
        vecModel: vecs[j]?.length ? ep.name : undefined,
        summaryId: sumId,
      });
    });
  }

  // 新的 session.messages：[摘要们（按时间序）] + recent
  const summaryMessages: Message[] = newSummaries.map((s) => ({
    role: 'user',                              // 用 user role 让 LLM 看作 "system 给的额外上下文"
    content: `[压缩历史摘要 #${s.id}] ${s.text}`,
    meta: { createdAt: s.createdAt, summaryId: s.id, compacted: true },
  }));

  const newMessages = [...summaryMessages, ...recentMessages];
  const afterTokens = estimateTokens(newMessages);
  let updatedArchive: SessionArchiveMeta = {
    archive: [...archive.archive, ...newArchived],
    summaries: [...archive.summaries, ...newSummaries],
    cursorOriginalIndex: cursorBase + oldMessages.length,
  };

  // M3：本轮压缩后 archive 是否超阈值？是的话 evict 最老的几段 summary 对应的 archive entries
  const gcRes = gcArchive(updatedArchive, ARCHIVE_MAX_ENTRIES, ARCHIVE_GC_KEEP_SUMMARIES);
  if (gcRes.evicted > 0) {
    updatedArchive = gcRes.newArchive;
    logger.info(
      { evicted: gcRes.evicted, archiveSize: updatedArchive.archive.length },
      '[compact-gc] 老 archive 已 evict，summaries 保留',
    );
  }

  return {
    triggered: true,
    archivedCount: newArchived.length,
    summariesCreated: newSummaries.length,
    beforeTokens, afterTokens,
    newMessages,
    archiveDelta: updatedArchive,
  };
}

/**
 * 分层 GC：当 archive entries 超 maxEntries 时，按 summary createdAt 升序排出最老的几段，
 * 把它们关联的 archive entries 全部丢掉，但保留 summaries 本身。
 *
 * 行为契约：
 *   - 输入 archive 不修改（返回新对象，方便测试和事务）
 *   - keepSummaryCount = 保留最近 N 段 summary 的 archive entries；更老的 evict
 *   - 没指向 summaryId 的 archive entry（理论上不该有）也会跟着 evict
 *   - 不依赖 LLM / embedding —— 纯 in-memory 操作
 */
export function gcArchive(
  archive: SessionArchiveMeta,
  maxEntries: number,
  keepSummaryCount: number,
): { evicted: number; newArchive: SessionArchiveMeta } {
  if (archive.archive.length <= maxEntries) return { evicted: 0, newArchive: archive };

  // 按 createdAt 升序排所有 summary；保留最近 keepSummaryCount 段，更老的 id 进 evict set
  const sortedSummaries = [...archive.summaries].sort((a, b) => a.createdAt - b.createdAt);
  const evictCount = Math.max(0, sortedSummaries.length - keepSummaryCount);
  const evictSummaryIds = new Set(sortedSummaries.slice(0, evictCount).map((s) => s.id));

  const before = archive.archive.length;
  const newArchiveEntries = archive.archive.filter(
    (m) => m.summaryId && !evictSummaryIds.has(m.summaryId),
  );
  const evicted = before - newArchiveEntries.length;
  return {
    evicted,
    newArchive: {
      archive: newArchiveEntries,
      summaries: archive.summaries,    // summaries 不动，仍提供"那段时间发生过什么"的精华
      cursorOriginalIndex: archive.cursorOriginalIndex,
    },
  };
}

/**
 * D 部分：RAG 召回 —— 用最新 user query 在 archive 里找相关老消息，拼成可注入 prompt 的字符串。
 *   返回 [] 时 caller 应跳过注入（不污染 prompt）。
 */
export async function recallRelevant(args: {
  sessionId: string;
  query: string;
  topK?: number;
  minSim?: number;
  sessionManager?: SessionManager;
}): Promise<ArchivedMessage[]> {
  const sm = args.sessionManager ?? defaultSessionManager;
  const session = await sm.get(args.sessionId);
  if (!session) return [];
  const archive = getArchive(session);
  if (archive.archive.length === 0) return [];

  const ep = getEmbedding();
  let qvec: number[];
  try {
    const [v] = await ep.embed([args.query]);
    qvec = v;
  } catch (err) {
    logger.warn({ err }, '[recall] query embedding 失败');
    return [];
  }
  const minSim = args.minSim ?? RECALL_MIN_SIM;
  const k = args.topK ?? RECALL_TOP_K;

  const candidates = archive.archive
    .filter((m) => Array.isArray(m.vec) && m.vec.length === qvec.length && m.vecModel === ep.name)
    .map((m) => ({ m, sim: cosineSim(qvec, m.vec!) }))
    .filter((r) => r.sim >= minSim)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k);

  return candidates.map((c) => c.m);
}

/**
 * 把召回结果格式化成一段可注入 user message 的文本。
 * 可选 citations collector：传了就把每条 recall 注册成 source，块前缀换成 [N]，
 *   LLM 后续能用 [ref:N] 引用回这条召回历史。
 */
export function formatRecalled(
  items: ArchivedMessage[],
  citations?: import('./citation.js').CitationCollector,
): string {
  if (items.length === 0) return '';
  const blocks = items.map((m, i) => {
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : m.role;
    const snippet = m.content.slice(0, 600);
    const ref = citations?.register({
      title: `早期 ${role} 消息 #${m.originalIndex}`,
      kind: 'rag',
      snippet,
    });
    const prefix = ref !== undefined ? `[${ref}] (相关历史 · ${role})` : `[相关历史 ${i + 1} · ${role}]`;
    return `${prefix} ${snippet}`;
  });
  return [
    '以下是从早期对话里按当前问题召回的相关片段（仅供参考，不要复读）：',
    ...blocks,
  ].join('\n\n');
}

/** 调用方把 compact 结果写回 session（合并 messages + archive meta） */
export async function persistCompact(
  sessionId: string,
  result: CompactResult,
  sm: SessionManager = defaultSessionManager,
): Promise<void> {
  if (!result.triggered || !result.newMessages || !result.archiveDelta) return;
  const session = await sm.get(sessionId);
  if (!session) return;
  session.messages = result.newMessages;
  (session as Session & { archive?: SessionArchiveMeta }).archive = result.archiveDelta;
  await sm.replace(session);
}
