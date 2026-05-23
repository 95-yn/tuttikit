/**
 * D + E + B 后端测试：
 *   - D fetch_and_summarize：mock-fetch（不真打外网）+ URL 白名单
 *   - E estimateTaskCost / compareActualVsEstimate
 *   - B debate mock 短路
 *   - C share create / get / delete / expire
 */
process.env.LOG_LEVEL ??= 'warn';
// 强制 mock provider 避免调真 LLM 烧钱；必须在 import config / createLLM 前设
process.env.LLM_PROVIDER = 'mock';
process.env.EMBEDDING_PROVIDER = 'mock';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 所有 TuttiKit 模块都走 dynamic import，让上面的 process.env 改动先生效
// （ESM 静态 import 会 hoist 到 process.env 赋值之前，config 拿到的还是 .env 里的真 LLM_PROVIDER）
const { setDBPath, closeDB } = await import('../src/core/db.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-test-'));
setDBPath(path.join(tmpDir, 'test.db'));

const { ToolRegistry } = await import('../src/tools/registry.js');
const { fetchAndSummarizeTool } = await import('../src/tools/fetchUrl.js');
const { debateTool } = await import('../src/tools/debate.js');
const { estimateTaskCost } = await import('../src/llm/costEstimator.js');
const { createShare, getSharedSessionAsync, deleteShare, listSharesForSession }
  = await import('../src/core/share.js');
const { sessionManager } = await import('../src/core/session.js');

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

// ───── D-1. URL 白名单（SSRF 防御） ─────
{
  const registry = new ToolRegistry();
  registry.register({ ...fetchAndSummarizeTool, allowedAgents: ['conductor'] });

  const bads = [
    'http://localhost:3001/health',
    'http://127.0.0.1/x',
    'http://10.0.0.1/x',
    'http://192.168.1.1/x',
    'http://172.16.0.1/x',
    'file:///etc/passwd',
  ];
  for (const url of bads) {
    let caught = false;
    try {
      await registry.invoke('fetch_and_summarize', { url }, { agent: 'conductor', sessionId: 's' });
    } catch (err) {
      caught = /URL 不允许|invalid URL|只接受/.test((err as Error).message);
    }
    assert(caught, `[D-1] 拒绝 ${url}`);
  }
}

// ───── E. estimateTaskCost ─────
{
  const low = estimateTaskCost('你好', 'mock');
  assert(low.complexity === 'low', `[E] "你好" → low（实际 ${low.complexity}）`);
  assert(low.estimatedSteps === 1, '[E] low 估 1 step');
  assert(low.estimatedUSD === 0, '[E] mock provider 估 $0');

  const high = estimateTaskCost('写一个完整的多 Agent 系统设计，包含错误处理和监控', 'anthropic');
  assert(high.complexity === 'high', `[E] 写代码任务 → high（实际 ${high.complexity}）`);
  assert(high.estimatedTokens > low.estimatedTokens, '[E] high tokens > low tokens');
  assert(high.estimatedUSD > 0, '[E] anthropic 估 USD > 0');
}

// ───── B. debate mock 短路 ─────
{
  const registry = new ToolRegistry();
  registry.register({ ...debateTool, allowedAgents: ['conductor'] });
  const result = await registry.invoke(
    'debate',
    { question: '该用 React 还是 Vue', n: 3 },
    { agent: 'conductor', sessionId: 's' },
  ) as { winner: string; replies: Array<{ persona: string; answer: string }>; judgeReasoning: string };
  assert(result.replies.length === 3, '[B] 3 个 debater');
  assert(/mock/i.test(result.winner), '[B] mock 短路 winner 含 mock 标记');
}

// ───── C. share create / get / delete / expire ─────
{
  const s = await sessionManager.create({ title: 'share-test' });
  await sessionManager.appendMessage(s.id, { role: 'user', content: 'hi' });

  // 创建无 TTL
  const r1 = createShare(s.id);
  assert(r1.token.length === 32, '[C] token 32 字符');
  assert(r1.expiresAt === undefined, '[C] 默认无 TTL');

  // 拿回
  const fetched = await getSharedSessionAsync(r1.token);
  assert(fetched !== null, '[C] 能取回');
  assert(fetched!.session.id === s.id, '[C] session 匹配');
  assert(fetched!.session.messages.length === 1, '[C] 含消息');

  // 不存在 token
  const none = await getSharedSessionAsync('not-exist');
  assert(none === null, '[C] 不存在 token 返回 null');

  // 创建带短 TTL 测试过期
  const r2 = createShare(s.id, 50); // 50ms 后过期
  await new Promise((r) => setTimeout(r, 80));
  const expired = await getSharedSessionAsync(r2.token);
  assert(expired === null, '[C] 过期 token 返回 null');

  // list shares
  const list = listSharesForSession(s.id);
  assert(list.length === 2, `[C] list 2 个（实际 ${list.length}）`);

  // delete
  const ok = deleteShare(r1.token);
  assert(ok === true, '[C] delete 返回 true');
  const afterDel = await getSharedSessionAsync(r1.token);
  assert(afterDel === null, '[C] delete 后取不到');
}

closeDB();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n全部通过 ✅');
