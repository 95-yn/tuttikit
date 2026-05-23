/**
 * Artifact 持久化 + tool 测试：
 *   A. saveArtifact 新建 + 取回
 *   B. 同 id 重复 save = 更新（updatedAt 变、createdAt 不变）
 *   C. listArtifactsForSession 按 updatedAt 降序
 *   D. HTML 超 200KB 抛错
 *   E. 通过 ToolRegistry.invoke 走完整 tool 路径 + SSE emit
 *   F. delete
 *   G. sqlite v3 schema 迁移：v1 → v3 全程不破坏现有 sessions / memory 数据
 */
process.env.LOG_LEVEL ??= 'warn';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setDBPath, closeDB } from '../src/core/db.js';

// 必须在 import artifact 模块前切 db
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
setDBPath(path.join(tmpDir, 'test.db'));

const { saveArtifact, getArtifact, listArtifactsForSession, deleteArtifact, MAX_HTML_BYTES }
  = await import('../src/core/artifact.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { renderArtifactTool } = await import('../src/tools/artifact.js');
const { MessageBus } = await import('../src/core/messageBus.js');

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

// ───── A. 新建 + 取回 ─────
{
  const a = saveArtifact({ sessionId: 's1', kind: 'html', title: 'hello', html: '<h1>hi</h1>' });
  assert(typeof a.id === 'string' && a.id.length > 0, '[A] 自动生成 id');
  assert(a.createdAt === a.updatedAt, '[A] 新建时 createdAt = updatedAt');
  const fetched = getArtifact(a.id);
  assert(fetched?.html === '<h1>hi</h1>', '[A] 取回 html 内容');
  assert(fetched?.title === 'hello', '[A] title 持久化');
}

// ───── B. 同 id 重复 save = 更新 ─────
{
  const v1 = saveArtifact({ sessionId: 's-update', kind: 'html', html: '<p>v1</p>' });
  // 睡 5ms 确保 updatedAt 不同
  await new Promise((r) => setTimeout(r, 5));
  const v2 = saveArtifact({ id: v1.id, sessionId: 's-update', kind: 'html', html: '<p>v2</p>' });
  assert(v2.id === v1.id, '[B] id 不变');
  assert(v2.createdAt === v1.createdAt, '[B] createdAt 保留');
  assert(v2.updatedAt > v1.updatedAt, `[B] updatedAt 增长（${v1.updatedAt} → ${v2.updatedAt}）`);
  const fetched = getArtifact(v1.id);
  assert(fetched?.html === '<p>v2</p>', '[B] 内容已更新');
}

// ───── C. list 按 updatedAt 降序 ─────
{
  saveArtifact({ id: 'old', sessionId: 's-list', kind: 'html', html: 'old' });
  await new Promise((r) => setTimeout(r, 5));
  saveArtifact({ id: 'new', sessionId: 's-list', kind: 'svg', html: '<svg/>' });
  const items = listArtifactsForSession('s-list');
  assert(items.length === 2, `[C] list 返回 2 条（实际 ${items.length}）`);
  assert(items[0].id === 'new', '[C] 最新 (new) 在前');
  assert(items[1].id === 'old', '[C] 最老 (old) 在后');
}

// ───── D. HTML 超上限抛错 ─────
{
  const big = 'x'.repeat(MAX_HTML_BYTES + 1);
  let caught: unknown;
  try { saveArtifact({ sessionId: 's-big', kind: 'html', html: big }); }
  catch (err) { caught = err; }
  assert(caught instanceof Error, '[D] 超上限抛错');
  assert(/200000|上限/.test((caught as Error).message), `[D] 错误信息提到上限（${(caught as Error).message}）`);
}

// ───── E. ToolRegistry.invoke 走完整路径 + SSE emit ─────
{
  const registry = new ToolRegistry();
  registry.register({ ...renderArtifactTool, allowedAgents: ['conductor'] });
  const bus = new MessageBus();
  let emitted: { artifactId?: string; html?: string } | null = null;
  bus.on('artifact:rendered', (p) => { emitted = p as typeof emitted; });

  const result = await registry.invoke(
    'render_artifact',
    { html: '<button>click</button>', kind: 'html', title: 'btn' },
    { agent: 'conductor', sessionId: 's-tool', bus },
  ) as { id: string; html: string };

  assert(typeof result.id === 'string', '[E] tool 返回 artifact id');
  assert(result.html === '<button>click</button>', '[E] tool 返回正确 html');
  assert(emitted !== null, '[E] bus.emit artifact:rendered 被触发');
  assert(emitted!.artifactId === result.id, '[E] emit payload artifactId 匹配');
  assert(emitted!.html === '<button>click</button>', '[E] emit payload 含 html');
}

// ───── F. delete ─────
{
  const a = saveArtifact({ sessionId: 's-del', kind: 'html', html: 'tmp' });
  const ok = deleteArtifact(a.id);
  assert(ok === true, '[F] delete 返回 true');
  assert(getArtifact(a.id) === null, '[F] delete 后取不到');
  const okAgain = deleteArtifact(a.id);
  assert(okAgain === false, '[F] 二次 delete 返回 false');
}

// ───── G. cross-session 隔离 ─────
{
  saveArtifact({ sessionId: 's-iso-a', kind: 'html', html: 'A' });
  saveArtifact({ sessionId: 's-iso-b', kind: 'html', html: 'B' });
  const aOnly = listArtifactsForSession('s-iso-a');
  const bOnly = listArtifactsForSession('s-iso-b');
  assert(aOnly.length === 1 && aOnly[0].html === 'A', '[G] session A 只看到自己的');
  assert(bOnly.length === 1 && bOnly[0].html === 'B', '[G] session B 只看到自己的');
}

closeDB();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n全部通过 ✅');
