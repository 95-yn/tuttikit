#!/usr/bin/env tsx
/**
 * 并发 test runner（H1 优化）：
 *   - 原串行 `npm run a && b && c` 13 个 test 跑下来要等很久，每个 tsx 都要冷启动
 *   - 这里用 child_process.spawn 并发跑，限制并行度（默认 CPU 核数 - 1）
 *   - 任一失败：保留其余完成后再汇总 + 非 0 退出码，方便看哪几个挂了
 *
 * 用法：
 *   node scripts/test-all.mjs                # 默认并发
 *   node scripts/test-all.mjs --concurrency=4
 *   node scripts/test-all.mjs --filter=safety # 只跑名字含 safety 的
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(__dirname, '..', 'examples');

// 全部 13 个 test 文件
const TESTS = [
  'test-aisdk-integration.ts',
  'test-conductor.ts',
  'test-markdown.ts',
  'test-skills.ts',
  'test-mcp.ts',
  'test-resilience.ts',
  'test-safety.ts',
  'test-budget.ts',
  'test-rag.ts',
  'test-planner.ts',
  'test-compact.ts',
  'test-safety-hooks.ts',
  'test-approval.ts',
  'test-session-concurrency.ts',
  'test-sqlite-migration.ts',
  'test-code-exec.ts',
  'test-artifact.ts',
  'test-ade-tools.ts',
  'test-run-command.ts',
];

// 解析参数
const args = process.argv.slice(2);
let concurrency = Math.max(1, os.cpus().length - 1);
let filter = '';
for (const a of args) {
  if (a.startsWith('--concurrency=')) concurrency = Number(a.slice('--concurrency='.length));
  else if (a.startsWith('--filter=')) filter = a.slice('--filter='.length);
}

const toRun = filter ? TESTS.filter((f) => f.includes(filter)) : TESTS;

if (toRun.length === 0) {
  console.error(`没有匹配 --filter=${filter} 的 test`);
  process.exit(1);
}

console.log(`并发跑 ${toRun.length} 个 test（concurrency=${concurrency}）`);
const t0 = Date.now();

/**
 * 简单的 promise pool：维护 inFlight set，达到 concurrency 上限时 await race。
 * 不引入 p-limit / p-queue 依赖。
 */
interface TestResult {
  file: string;
  ok: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  code: number | null;
}

const queue: string[] = [...toRun];
const results: TestResult[] = [];
const inFlight: Set<Promise<void>> = new Set();

async function run(file: string): Promise<TestResult> {
  const t = Date.now();
  return await new Promise<TestResult>((resolve) => {
    const child = spawn('npx', ['tsx', path.join(examplesDir, file)], {
      env: { ...process.env, LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      resolve({
        file,
        ok: code === 0,
        durationMs: Date.now() - t,
        stdout, stderr, code,
      });
    });
  });
}

while (queue.length > 0 || inFlight.size > 0) {
  while (inFlight.size < concurrency && queue.length > 0) {
    const file = queue.shift()!;
    const p = run(file).then((r) => {
      inFlight.delete(p);
      results.push(r);
      const tag = r.ok ? '✓' : '✗';
      console.log(`  ${tag} ${r.file.padEnd(34)} ${(r.durationMs/1000).toFixed(1)}s`);
    });
    inFlight.add(p);
  }
  if (inFlight.size > 0) await Promise.race(inFlight);
}

const failed = results.filter((r) => !r.ok);
const totalMs = Date.now() - t0;
console.log(`\n完成：${results.length} 个 test 用了 ${(totalMs/1000).toFixed(1)}s（串行原本约 ${results.reduce((s, r) => s + r.durationMs, 0)/1000 | 0}s）`);

if (failed.length > 0) {
  console.error(`\n✗ ${failed.length} 个 test 失败：`);
  for (const r of failed) {
    console.error(`\n--- ${r.file} (exit ${r.code}) ---`);
    if (r.stdout) console.error(r.stdout.trim().split('\n').slice(-30).join('\n'));
    if (r.stderr) console.error('[stderr]', r.stderr.trim().split('\n').slice(-10).join('\n'));
  }
  process.exit(1);
}

console.log('\n全部通过 ✅');
