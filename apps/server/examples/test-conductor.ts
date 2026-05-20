/**
 * 端到端测试：ConductorAgent + delegate 工具 + 多轮对话。
 * 强制走 MockProvider，不依赖 .env。
 */
import { ConductorAgent } from '../src/agents/index.js';
import { MessageBus } from '../src/core/messageBus.js';
import { SessionManager } from '../src/core/session.js';
import { buildToolRegistryWithSubAgents } from '../src/tools/index.js';
import { longTermMemory } from '../src/memory/longTerm.js';
import { tracer } from '../src/observability/tracer.js';
import { createLLM } from '../src/llm/index.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function assert(cond, msg) {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

// 用独立临时目录，避免污染主 data/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-agent-test-'));
const sessions = new SessionManager({ dir: tmpDir });

async function setupConductor() {
  const bus = new MessageBus();
  const llm = createLLM('mock');
  const toolRegistry = buildToolRegistryWithSubAgents({ llm, longTermMemory, bus });
  const conductor = new ConductorAgent({ llm, toolRegistry, sessionManager: sessions, bus });
  const events = [];
  bus.on('message:user', e => events.push({ type: 'user', ...e }));
  bus.on('tool:start', e => events.push({ type: 'tool:start', ...e }));
  bus.on('tool:end', e => events.push({ type: 'tool:end', ...e }));
  bus.on('turn:done', e => events.push({ type: 'turn:done', ...e }));
  return { conductor, bus, events };
}

async function turn(conductor, sid, msg) {
  const trace = tracer.startTrace('test.turn');
  await conductor.respond({ sessionId: sid, userMessage: msg, stream: false, trace, tracer });
  tracer.endTrace(trace);
}

// ── 用例 1：算数学 → conductor 调 calculator ──
{
  const { conductor, events } = await setupConductor();
  const s = await sessions.create({});
  await turn(conductor, s.id, '帮我算 (1 + 2) * 3');
  const calls = events.filter(e => e.type === 'tool:start');
  assert(calls.length === 1 && calls[0].name === 'calculator', '数学：调了一次 calculator');
  const result = events.find(e => e.type === 'tool:end');
  assert(result?.result?.value === 9, '数学：calculator 返回 9');
}

// ── 用例 2：调研 → conductor delegate 给 researcher ──
{
  const { conductor, events } = await setupConductor();
  const s = await sessions.create({});
  await turn(conductor, s.id, '调研一下 pgvector');
  const calls = events.filter(e => e.type === 'tool:start');
  assert(
    calls.some(c => c.name === 'delegate_to_researcher'),
    '调研：调了 delegate_to_researcher',
  );
}

// ── 用例 3：写文件 → conductor delegate 给 coder ──
{
  const { conductor, events } = await setupConductor();
  const s = await sessions.create({});
  await turn(conductor, s.id, '在 ./data/test-hello.txt 里写一句 hello');
  const calls = events.filter(e => e.type === 'tool:start');
  assert(
    calls.some(c => c.name === 'delegate_to_coder'),
    '写文件：调了 delegate_to_coder',
  );
}

// ── 用例 4：闲聊 → conductor 直接答 ──
{
  const { conductor, events } = await setupConductor();
  const s = await sessions.create({});
  await turn(conductor, s.id, '你好');
  const calls = events.filter(e => e.type === 'tool:start');
  assert(calls.length === 0, '闲聊：不调用任何工具');
}

// ── 用例 5：多轮对话 → 上下文持久化 ──
{
  const { conductor } = await setupConductor();
  const s = await sessions.create({});
  await turn(conductor, s.id, '你好');
  await turn(conductor, s.id, '帮我算 1 + 2');
  const reloaded = await sessions.get(s.id);
  assert(reloaded.messages.length >= 4, '多轮：session 累计至少 4 条消息');
  assert(reloaded.messages[0].role === 'user', '多轮：第一条是 user');
  assert(reloaded.title.startsWith('你好'), '多轮：title 取自首条 user 消息');
}

// ── 用例 6：Session CRUD ──
{
  const a = await sessions.create({});
  const b = await sessions.create({});
  const list = await sessions.list();
  assert(list.length >= 2, 'CRUD：list 至少 2 条');
  await sessions.rename(a.id, '重命名后');
  const reloaded = await sessions.get(a.id);
  assert(reloaded.title === '重命名后', 'CRUD：rename 生效');
  const ok = await sessions.delete(b.id);
  assert(ok, 'CRUD：delete 返回 true');
  const after = await sessions.get(b.id);
  assert(after === null, 'CRUD：删除后再 get 返回 null');
}

// 清理临时目录
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n全部通过 ✅');
