/**
 * #6 Safety Guardrails 测试。
 * 注意：fileSystem.ts 的 ROOT 是 import 时 path.resolve('.') 锁定的，
 * 所以必须先 chdir 到临时目录，再 dynamic import。
 */
process.env.LOG_LEVEL ??= 'warn';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`);
}

async function expectThrow(fn: () => Promise<unknown>, pattern: RegExp, msg: string): Promise<void> {
  try {
    await fn();
    console.error(`✗ ${msg} — 期望抛错但成功了`);
    process.exit(1);
  } catch (err) {
    const m = (err as Error).message;
    if (!pattern.test(m)) {
      console.error(`✗ ${msg} — 抛错信息不匹配：${m}`);
      process.exit(1);
    }
    console.log(`✓ ${msg}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-test-'));
const oldCwd = process.cwd();
process.chdir(tmpRoot);
fs.mkdirSync('data', { recursive: true });
fs.mkdirSync('tmp', { recursive: true });

// chdir 之后再 dynamic import，让 fileSystem.ROOT = tmpRoot
const { fileWriteTool, fileReadTool } = await import('../src/tools/fileSystem.js');
const { ToolRegistry } = await import('../src/tools/registry.js');
const { ToolInputError } = await import('../src/tools/errors.js');
const { MAX_EXTRACTED_CHARS } = await import('../src/core/uploads.js');

const reg = new ToolRegistry();
reg.register(fileWriteTool);
reg.register(fileReadTool);

// ───── A. allowlist：data/ tmp/ ok ─────
{
  await reg.invoke('file_system_write', { path: 'data/ok.txt', content: 'hello' });
  assert(fs.existsSync('data/ok.txt'), '写 data/ok.txt 成功');
  await reg.invoke('file_system_write', { path: 'tmp/x.json', content: '{}' });
  assert(fs.existsSync('tmp/x.json'), '写 tmp/x.json 成功');
}

// ───── B. denylist：.env / package.json / .git / node_modules ─────
{
  await expectThrow(
    () => reg.invoke('file_system_write', { path: '.env', content: 'X=1' }),
    /denylist|受保护|只允许写入/,
    '写 .env → 拒绝',
  );
  await expectThrow(
    () => reg.invoke('file_system_write', { path: 'package.json', content: '{}' }),
    /denylist|受保护|只允许写入/,
    '写 package.json → 拒绝',
  );
  await expectThrow(
    () => reg.invoke('file_system_write', { path: '.git/HEAD', content: 'X' }),
    /denylist|受保护|只允许写入/,
    '写 .git/HEAD → 拒绝',
  );
}

// ───── C. 非 allowlist：apps/web/src/foo.ts、随便一个根目录文件 ─────
{
  await expectThrow(
    () => reg.invoke('file_system_write', { path: 'apps/web/src/foo.ts', content: 'X' }),
    /只允许写入|allowlist/,
    '写 apps/web/src/foo.ts → 拒绝（不在 allowlist）',
  );
  await expectThrow(
    () => reg.invoke('file_system_write', { path: 'random.md', content: 'X' }),
    /只允许写入|allowlist/,
    '写根目录 random.md → 拒绝',
  );
}

// ───── D. 路径越界 ─────
{
  await expectThrow(
    () => reg.invoke('file_system_write', { path: '../escape.txt', content: 'X' }),
    /越界|outside/,
    '写 ../escape.txt → 越界拒绝',
  );
  await expectThrow(
    () => reg.invoke('file_system_write', { path: 'data/../../../etc/passwd', content: 'X' }),
    /越界|outside/,
    '写 data/../../../etc/passwd → 越界拒绝',
  );
}

// ───── E. 入参校验 ─────
{
  let caught: unknown;
  try {
    await reg.invoke('file_system_write', { path: '', content: 'X' });
  } catch (err) { caught = err; }
  assert(caught instanceof ToolInputError, '空 path → ToolInputError');

  let caught2: unknown;
  try {
    await reg.invoke('file_system_write', { path: 'data/x.txt' });
  } catch (err) { caught2 = err; }
  assert(caught2 instanceof ToolInputError, '缺 content → ToolInputError');
}

// ───── F. 截断常量 ─────
{
  assert(MAX_EXTRACTED_CHARS === 60_000, `MAX_EXTRACTED_CHARS=${MAX_EXTRACTED_CHARS}（默认 60k）`);
}

process.chdir(oldCwd);
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('\n全部通过 ✅');
