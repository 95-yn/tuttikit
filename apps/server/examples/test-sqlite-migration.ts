/**
 * SQLite 迁移测试：
 *   A. 老 session JSON → sessions 表，原文件改名 .migrated
 *   B. 老 long_term_memory.json → memory 表，原文件改名 .migrated
 *   C. 第二次 boot 跳过 .migrated（幂等）
 *   D. 损坏的 JSON 文件不阻塞其他文件迁移
 */
process.env.LOG_LEVEL ??= 'warn';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setDBPath, closeDB, prepare } from '../src/core/db.js';

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

// 临时工作目录：测试切到这里，让 migration 看见我们准备的 data/
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-'));
const origCwd = process.cwd();
process.chdir(tmpRoot);

// 准备 data/sessions/*.json + data/long_term_memory.json
fs.mkdirSync('data/sessions', { recursive: true });
fs.writeFileSync('data/sessions/sess-a.json', JSON.stringify({
  id: 'sess-a', title: '老 session', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ],
}));
fs.writeFileSync('data/sessions/sess-b.json', JSON.stringify({
  id: 'sess-b', title: '带 archive 的 session',
  createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-02T00:00:00Z',
  messages: [{ role: 'user', content: 'test archive' }],
  archive: { archive: [], summaries: [{ id: 'sum-1', text: 'old summary', rangeStart: 0, rangeEnd: 5, createdAt: 1000 }], cursorOriginalIndex: 0 },
}));
fs.writeFileSync('data/sessions/broken.json', '{"this is not valid json');   // 故意损坏

fs.writeFileSync('data/long_term_memory.json', JSON.stringify([
  { id: 'mem1', text: '记忆 1', source: 'a', tags: ['tag1'], createdAt: 1700000000000 },
  { id: 'mem2', text: '记忆 2', source: 'b', tags: [], createdAt: 1700000001000, vec: [0.1, 0.2], vecModel: 'mock' },
]));

// 切 sqlite path 到临时目录，import migration（注意：必须在 setDBPath 之后）
setDBPath(path.join(tmpRoot, 'test.db'));
const { migrateJSONToSQLite } = await import('../src/core/migration.js');

// ───── A + B: 第一次迁移 ─────
{
  const r = migrateJSONToSQLite();
  assert(r.sessionsImported === 2, `[A] 2 个 session 文件被迁移（实际 ${r.sessionsImported}）`);
  assert(r.memoryImported === 2, `[B] 2 条 memory 被迁移（实际 ${r.memoryImported}）`);

  // sessions 表里有数据
  const rows = prepare('SELECT id, title FROM sessions ORDER BY id').all() as Array<{ id: string; title: string }>;
  assert(rows.length === 2, `[A] sessions 表 2 行（实际 ${rows.length}）`);
  assert(rows[0].id === 'sess-a' && rows[0].title === '老 session', '[A] sess-a 字段正确');

  // sess-b 的 archive 也带过去了
  const archiveRow = prepare('SELECT archive FROM sessions WHERE id = ?').get('sess-b') as { archive: string };
  const parsed = JSON.parse(archiveRow.archive);
  assert(parsed.summaries?.length === 1 && parsed.summaries[0].id === 'sum-1', '[A] archive 字段完整迁移');

  // memory 表
  const mRows = prepare('SELECT id, vec FROM memory ORDER BY id').all() as Array<{ id: string; vec: string | null }>;
  assert(mRows.length === 2, `[B] memory 表 2 行（实际 ${mRows.length}）`);
  assert(mRows[1].vec !== null && JSON.parse(mRows[1].vec!).length === 2, '[B] mem2 的 vec 完整迁移');

  // 文件被改名
  assert(fs.existsSync('data/sessions/sess-a.json.migrated'), '[A] sess-a.json → .migrated');
  assert(!fs.existsSync('data/sessions/sess-a.json'), '[A] 原 .json 已不在');
  assert(fs.existsSync('data/long_term_memory.json.migrated'), '[B] long_term .json → .migrated');
}

// ───── C: 第二次 boot 幂等（已迁移文件被跳过）─────
{
  const r2 = migrateJSONToSQLite();
  assert(r2.sessionsImported === 0, '[C] 第二次跑：没有新 session 文件被迁移');
  assert(r2.memoryImported === 0, '[C] 第二次跑：没有新 memory 被迁移');
}

// ───── D: 损坏文件不阻塞 ─────
{
  // broken.json 被跳过，但其他两个仍迁移成功了（A 已经验证）
  // 检查 broken.json 文件**还在**（没改名为 .migrated）
  assert(fs.existsSync('data/sessions/broken.json'), '[D] 损坏文件保留原名（没被改 .migrated）');
}

closeDB();
process.chdir(origCwd);
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('\n全部通过 ✅');
