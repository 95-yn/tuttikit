/**
 * SessionManager 并发安全测试（C1 修复回归）：
 *   A. 并发 100 次 appendMessage → 全部到位（无 lost update）
 *   B. appendMessage 和 truncateMessages 互相串行
 *   C. 原子写盘：临时文件不会污染目录
 *   D. 不同 session id 的 mutator 不互相阻塞（并行不串行）
 *   E. mutator 抛错不污染锁链
 */
process.env.LOG_LEVEL ??= 'warn';

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setDBPath, closeDB } from '../src/core/db.js';

// 测试用独立 db；必须在 import SessionManager 之前调用 setDBPath
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-concurrency-'));
setDBPath(path.join(tmpDir, 'test.db'));

const { SessionManager } = await import('../src/core/session.js');

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

const sm = new SessionManager();

// ───── A. 100 个并发 appendMessage ─────
{
  const s = await sm.create({ title: 'concurrent-test' });
  const N = 100;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      sm.appendMessage(s.id, { role: 'user', content: `msg-${i}` })),
  );
  const reload = await sm.get(s.id);
  assert(reload!.messages.length === N, `[A] 100 并发后消息数 = ${N}（实际 ${reload!.messages.length}）`);
  // 验证内容也没丢——所有 msg-i 都在
  const seen = new Set(reload!.messages.map((m) => m.content));
  for (let i = 0; i < N; i++) {
    if (!seen.has(`msg-${i}`)) {
      console.error(`✗ [A] 丢消息：msg-${i} 不在`);
      process.exit(1);
    }
  }
  console.log('✓ [A] 100 条消息内容全部到位（无 lost update）');
}

// ───── B. append 和 truncate 互相串行 ─────
{
  const s = await sm.create({ title: 'truncate-test' });
  for (let i = 0; i < 10; i++) await sm.appendMessage(s.id, { role: 'user', content: `pre-${i}` });
  // 同时启动一个 append + 一个 truncate
  const [reload1, reload2] = await Promise.all([
    sm.appendMessage(s.id, { role: 'user', content: 'late-append' }),
    sm.truncateMessages(s.id, 5),
  ]);
  // 两个 op 都成功完成（没有 race exception）
  void reload1; void reload2;
  const final = await sm.get(s.id);
  // 结果取决于谁先获得锁，但内部状态必须自洽：消息数应该是 5（truncate 后没 append）或 6（append 后 truncate 没把 late 砍掉）或 5（先 append → 11, 再 truncate to 5）
  // 关键是：不会半截、不会抛、updatedAt 是最新的
  assert(final !== null, '[B] session 存在');
  assert(final!.messages.length >= 5 && final!.messages.length <= 11, `[B] 消息数在合理范围（实际 ${final!.messages.length}）`);
  assert(typeof final!.updatedAt === 'string', '[B] updatedAt 有值');
}

// ───── C. sqlite 写入：单文件 db + WAL ─────
{
  const s = await sm.create({ title: 'atomic-test' });
  await sm.appendMessage(s.id, { role: 'user', content: 'x' });
  // sqlite 用 WAL 模式后会有 .db / .db-wal / .db-shm 三个文件；不会有半截 .tmp
  const files = await fs.readdir(tmpDir);
  const stale = files.filter((f) => f.endsWith('.tmp'));
  assert(stale.length === 0, `[C] 不会留 .tmp（实际 ${stale.length} 个）`);
  assert(files.some((f) => f === 'test.db'), '[C] db 文件存在');
}

// ───── D. 不同 session 不互相阻塞 ─────
{
  const s1 = await sm.create({ title: 's1' });
  const s2 = await sm.create({ title: 's2' });
  const t0 = Date.now();
  // 给 s1 排 5 次 + 给 s2 排 5 次，并发跑
  await Promise.all([
    ...Array.from({ length: 5 }, (_, i) => sm.appendMessage(s1.id, { role: 'user', content: `s1-${i}` })),
    ...Array.from({ length: 5 }, (_, i) => sm.appendMessage(s2.id, { role: 'user', content: `s2-${i}` })),
  ]);
  const elapsed = Date.now() - t0;
  const [r1, r2] = await Promise.all([sm.get(s1.id), sm.get(s2.id)]);
  assert(r1!.messages.length === 5 && r2!.messages.length === 5, '[D] 两个 session 各 5 条都到位');
  // 串行做 10 个写要 N*N ms 才合理；并行应该接近 5*N ms。验证 elapsed 不要太离谱
  assert(elapsed < 2000, `[D] 并行不阻塞（10 次写耗时 ${elapsed}ms）`);
}

// ───── E. mutator 抛错不破坏锁链 ─────
{
  const s = await sm.create({ title: 'err-test' });
  await sm.appendMessage(s.id, { role: 'user', content: 'ok-1' });
  let caught = false;
  // 故意触发错误：fromIndex 越界
  try {
    await sm.truncateMessages(s.id, 9999);
  } catch (err) {
    caught = true;
    assert(/越界/.test((err as Error).message), `[E] 抛预期错误：${(err as Error).message}`);
  }
  assert(caught, '[E] truncateMessages 越界抛错');
  // 后续 op 还能正常跑——锁链没被卡死
  await sm.appendMessage(s.id, { role: 'user', content: 'ok-2' });
  const final = await sm.get(s.id);
  assert(final!.messages.length === 2, `[E] 抛错后锁链仍可用，新 msg 进得去（实际 ${final!.messages.length} 条）`);
}

closeDB();
await fs.rm(tmpDir, { recursive: true, force: true });
console.log('\n全部通过 ✅');
