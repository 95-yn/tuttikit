/**
 * sessionCompact（C+D）测试：
 *   A. estimateTokens 单调（长文本 token 多）
 *   B. compactIfNeeded：未超阈值 → triggered=false
 *   C. compactIfNeeded：超阈值 → 老消息进 archive、新 messages 只剩 [摘要们 + 最近 K]
 *   D. recallRelevant：query 能匹配到语义相关的 archive 老消息
 *   E. 可逆性（Manus 原则）：被压缩的消息全文 + role 完整存在 archive 里
 *
 * 用 MockEmbedding + mock LLM 跑，全程不打外网。
 */
process.env.LOG_LEVEL ??= 'warn';
process.env.EMBEDDING_PROVIDER = 'mock';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 必须在 import 任何 TuttiKit 模块前 setDBPath，否则会污染 ./data/tuttikit.db
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-test-db-'));
const { setDBPath, closeDB } = await import('../src/core/db.js');
setDBPath(path.join(tmpDir, 'test.db'));
const { SessionManager } = await import('../src/core/session.js');
const {
  estimateTokens, compactIfNeeded, persistCompact, recallRelevant, getArchive,
  gcArchive,
} = await import('../src/core/sessionCompact.js');
type LLMLike = import('../src/types.js').LLMLike;
type LLMCallArgs = import('../src/types.js').LLMCallArgs;
type LLMResponse = import('../src/types.js').LLMResponse;

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

// Mock LLM：name='mock' → sessionCompact 内部不真调 chat
const mockLLM: LLMLike = {
  name: 'mock',
  async chat(_args: LLMCallArgs): Promise<LLMResponse> {
    return { role: 'assistant', content: '[mock]', toolCalls: [], usage: {} };
  },
} as unknown as LLMLike;

// ───── A. estimateTokens 单调 ─────
{
  const t1 = estimateTokens([{ role: 'user', content: 'hi' }]);
  const t2 = estimateTokens([{ role: 'user', content: 'hi'.repeat(1000) }]);
  assert(t2 > t1, 'estimateTokens 单调：长消息 token 数更大');
  assert(t1 < 10, '短消息估算合理（< 10）');
}

const sm = new SessionManager();    // db path 已通过 setDBPath 切到 tmp

// ───── B. 未超阈值 → 不压 ─────
{
  const s = await sm.create({ title: 't1' });
  await sm.appendMessage(s.id, { role: 'user', content: '你好' });
  await sm.appendMessage(s.id, { role: 'assistant', content: '你好，有什么可以帮你' });
  // 给一个超大的 ctx window，肯定不会触发
  const r = await compactIfNeeded({ sessionId: s.id, contextWindow: 100_000, llm: mockLLM, sessionManager: sm });
  assert(r.triggered === false, '少量消息 + 大窗口 → 不触发压缩');
  assert(r.archivedCount === 0 && r.summariesCreated === 0, '不触发时 archived/summaries=0');
}

// ───── C. 超阈值 → 压缩 + archive ─────
{
  const s = await sm.create({ title: 't2' });
  // 灌 30 条消息，每条 ~500 char → 总 ~15000 char ≈ 5000 token
  for (let i = 0; i < 30; i++) {
    await sm.appendMessage(s.id, {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第 ${i} 条消息：` + 'x'.repeat(500),
    });
  }
  // 用 1000 的小窗口（threshold = 600），确保触发
  const before = await sm.get(s.id);
  const beforeCount = before!.messages.length;
  const r = await compactIfNeeded({
    sessionId: s.id, contextWindow: 1_000, llm: mockLLM,
    keepRecentN: 8, batchSize: 8, sessionManager: sm,
  });
  assert(r.triggered === true, '小窗口 + 多消息 → 触发压缩');
  assert(r.archivedCount === beforeCount - 8, `archive 数 = 总 ${beforeCount} - keep 8 = ${beforeCount - 8}（实际 ${r.archivedCount}）`);
  assert(r.summariesCreated > 0, `生成 ${r.summariesCreated} 段摘要`);
  assert(r.afterTokens < r.beforeTokens, `压缩后 token 变少（${r.beforeTokens} → ${r.afterTokens}）`);
  assert(r.newMessages!.length < beforeCount, `messages 变短：${beforeCount} → ${r.newMessages!.length}`);

  // persist 后磁盘上的 session 真的更新
  await persistCompact(s.id, r, sm);
  const after = await sm.get(s.id);
  assert(after!.messages.length === r.newMessages!.length, 'persist 后磁盘 session.messages 与 result 一致');

  const archive = getArchive(after!);
  assert(archive.archive.length === r.archivedCount, 'archive 中条数与 result 一致');
  assert(archive.summaries.length === r.summariesCreated, 'summaries 中条数与 result 一致');

  // ───── E. 可逆性：被压缩的内容全文保留在 archive ─────
  const first = archive.archive[0];
  assert(first.content.includes('第 0 条消息'), 'archive[0] 保留原始全文（找到"第 0 条"标记）');
  assert(first.role === 'user', 'archive[0] role 保留为 user');
  assert(typeof first.summaryId === 'string' && first.summaryId.length > 0, 'archive 条目关联到 summaryId');
}

// ───── D. recallRelevant：相关历史能被召回 ─────
{
  const s = await sm.create({ title: 't3' });
  // 灌 16 条带"主题"的消息，便于校验召回
  const topics = ['React 函数组件', '数据库索引优化', 'TCP 三次握手', 'Python decorator'];
  for (let i = 0; i < 16; i++) {
    const t = topics[i % topics.length];
    await sm.appendMessage(s.id, { role: 'user',      content: `关于 ${t} 我想问一下` });
    await sm.appendMessage(s.id, { role: 'assistant', content: `${t} 的核心要点是…` });
  }
  const r = await compactIfNeeded({
    sessionId: s.id, contextWindow: 100, llm: mockLLM, keepRecentN: 4, batchSize: 8, sessionManager: sm,
  });
  assert(r.triggered, 't3 触发压缩');
  await persistCompact(s.id, r, sm);

  const recalled = await recallRelevant({
    sessionId: s.id,
    query: 'React 函数组件 hook 的写法',
    topK: 4,
    minSim: 0.0,    // mock embedding 相关度有限，先关闭 sim 阈值
    sessionManager: sm,
  });
  assert(recalled.length > 0, `召回到 ${recalled.length} 条相关历史`);
  // mock embedding 是确定性的：query 中含 "React 函数组件" 字符串时，cosineSim 应当让相关 archive 排前
  // 我们只 assert "存在含 React 关键词的命中"
  const hasReactHit = recalled.some((m) => m.content.includes('React'));
  assert(hasReactHit, '召回结果包含 React 相关消息（语义命中）');
}

// ───── F. archive 分层 GC（M3） ─────
{
  const t0 = 1_000_000;
  const mkSummary = (idx: number) => ({
    id: `sum-${idx}`,
    rangeStart: idx * 10, rangeEnd: idx * 10 + 9,
    text: `summary ${idx}`,
    createdAt: t0 + idx,    // 升序时间戳，便于 GC 排序
  });
  const mkArchive = (sumId: string, idx: number) => ({
    id: `a-${sumId}-${idx}`, role: 'user' as const,
    content: `archive ${sumId} ${idx}`,
    originalIndex: idx,
    summaryId: sumId,
  });

  // 50 段 summary × 每段 10 条 archive = 500 条；阈值 100，保留最近 5 段
  const summaries = Array.from({ length: 50 }, (_, i) => mkSummary(i));
  const archive = summaries.flatMap((s) =>
    Array.from({ length: 10 }, (_, j) => mkArchive(s.id, j)));
  const initial = { summaries, archive, cursorOriginalIndex: 0 };

  // F.1 不超阈值不动
  const res1 = gcArchive(initial, 1000, 5);
  assert(res1.evicted === 0, '[F.1] archive 未超阈值时不动');
  assert(res1.newArchive === initial, '[F.1] 返回的是原对象引用（零拷贝优化）');

  // F.2 超阈值时：保留最近 5 段 summary × 10 = 50 条 archive；evict 45 段 × 10 = 450 条
  const res2 = gcArchive(initial, 100, 5);
  assert(res2.evicted === 450, `[F.2] evict 450 条（实际 ${res2.evicted}）`);
  assert(res2.newArchive.archive.length === 50, `[F.2] 剩 50 条（实际 ${res2.newArchive.archive.length}）`);
  assert(res2.newArchive.summaries.length === 50, '[F.2] summaries 不动（仍保留全部 50 段精华）');
  // 保留的应该是最新的 5 段
  const keptSumIds = new Set(res2.newArchive.archive.map((a) => a.summaryId));
  assert(keptSumIds.has('sum-49'), '[F.2] 最新 sum-49 的 archive 被保留');
  assert(keptSumIds.has('sum-45'), '[F.2] 第 5 新 sum-45 的 archive 被保留');
  assert(!keptSumIds.has('sum-44'), '[F.2] 第 6 新 sum-44 的 archive 被 evict');
  assert(!keptSumIds.has('sum-0'),  '[F.2] 最老 sum-0 的 archive 被 evict');

  // F.3 keepSummaryCount > 实际 summary 数：什么都不 evict
  const res3 = gcArchive({ summaries: summaries.slice(0, 3), archive: archive.slice(0, 30), cursorOriginalIndex: 0 }, 10, 100);
  assert(res3.evicted === 0, '[F.3] keepCount > summary 数 → 不 evict');
}

closeDB();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n全部通过 ✅');
