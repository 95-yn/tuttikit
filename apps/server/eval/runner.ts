/**
 * Eval Runner —— 跑 golden task set，跟踪每条任务的 tool / steps / tokens / 最终答案，
 * 跑完打分 + 写 report.json + 控制台彩色摘要。
 *
 *   pnpm -C apps/server eval --provider=mock
 *   pnpm -C apps/server eval --provider=anthropic --filter=math
 *   pnpm -C apps/server eval --provider=mock --concurrency=4
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConductorAgent } from '../src/agents/index.js';
import { MessageBus } from '../src/core/messageBus.js';
import { SessionManager } from '../src/core/session.js';
import { buildToolRegistryWithSubAgents } from '../src/tools/index.js';
import { LongTermMemory } from '../src/memory/longTerm.js';
import { tracer } from '../src/observability/tracer.js';
import { createLLM } from '../src/llm/index.js';
import { loadTasks } from './loader.js';
import { scoreTaskAsync, allPass } from './score.js';
import type { EvalTask, TaskRun, RunReport } from './types.js';

interface CLI {
  provider: string;
  filter?: string;
  concurrency: number;
  outDir: string;
  judgeProvider?: string;
  failOnRegression: boolean;
}

function parseCLI(): CLI {
  const args = process.argv.slice(2);
  const get = (k: string, fallback?: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : fallback;
  };
  const flag = (k: string): boolean => args.includes(`--${k}`);
  return {
    provider: get('provider', 'mock')!,
    filter: get('filter'),
    concurrency: Number(get('concurrency', '1')) || 1,
    outDir: get('out-dir', path.resolve('data/eval-runs'))!,
    judgeProvider: get('judge-provider'),
    failOnRegression: flag('fail-on-regression'),
  };
}

const COLORS = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

async function runOneTask(task: EvalTask, provider: string, judgeProvider?: string): Promise<TaskRun> {
  const startedAt = Date.now();
  // 每个任务一个临时 sessions 目录，避免互相污染
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-sessions-'));
  // 同样隔离长期记忆
  const tmpMem = path.join(tmpDir, 'long-term.json');

  try {
    const bus = new MessageBus();
    const llm = createLLM(provider);
    const sessions = new SessionManager({ dir: tmpDir });
    const longTerm = new LongTermMemory({ filePath: tmpMem });
    const toolRegistry = buildToolRegistryWithSubAgents({ llm, longTermMemory: longTerm, bus });
    const conductor = new ConductorAgent({ llm, toolRegistry, sessionManager: sessions, bus });

    const s = await sessions.create({});
    const trace = tracer.startTrace('eval.turn', { taskId: task.id });
    const result = await conductor.respond({
      sessionId: s.id,
      userMessage: task.input,
      stream: false,
      trace,
      tracer,
    });
    tracer.endTrace(trace);

    const session = await sessions.get(s.id);
    const lastAssistant = [...(session?.messages ?? [])].reverse().find((m) => m.role === 'assistant');
    const finalAnswer = (lastAssistant?.content as string) ?? '';

    // 工具调用列表：从 trace 里所有 kind===tool 的 span 拿
    const toolsCalled = trace.spans
      .filter((sp) => sp.kind === 'tool')
      .map((sp) => sp.name);

    const assertions = await scoreTaskAsync(task, {
      finalAnswer,
      toolsCalled,
      steps: result.steps,
      tokensIn: result.usage.inputTokens || 0,
      tokensOut: result.usage.outputTokens || 0,
    }, { judgeProvider });

    return {
      task,
      ok: allPass(assertions),
      finalAnswer,
      toolsCalled,
      steps: result.steps,
      tokensIn: result.usage.inputTokens || 0,
      tokensOut: result.usage.outputTokens || 0,
      durationMs: Date.now() - startedAt,
      assertions,
      traceId: trace.traceId,
    };
  } catch (err) {
    return {
      task,
      ok: false,
      finalAnswer: '',
      toolsCalled: [],
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: Date.now() - startedAt,
      assertions: [],
      error: (err as Error).message,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function runAll(tasks: EvalTask[], cli: CLI): Promise<RunReport> {
  const startedAt = new Date();
  const results: TaskRun[] = [];

  // 简单并发：N 个 worker 轮询任务
  let cursor = 0;
  const total = tasks.length;
  const workers = Array.from({ length: Math.max(1, cli.concurrency) }, async () => {
    while (cursor < total) {
      const i = cursor++;
      const t = tasks[i];
      process.stdout.write(`${COLORS.dim}[${i + 1}/${total}] ${t.id}…${COLORS.reset}\r`);
      const r = await runOneTask(t, cli.provider, cli.judgeProvider);
      results.push(r);
      printTaskLine(r);
    }
  });
  await Promise.all(workers);

  // 按 task.id 字典序输出，方便对比
  results.sort((a, b) => a.task.id.localeCompare(b.task.id));

  const endedAt = new Date();
  const totals = {
    total: results.length,
    pass: results.filter((r) => r.ok && !r.error).length,
    fail: results.filter((r) => !r.ok && !r.error).length,
    error: results.filter((r) => !!r.error).length,
  };
  const byCategory: Record<string, { pass: number; fail: number; total: number }> = {};
  for (const r of results) {
    const c = r.task.category;
    byCategory[c] ??= { pass: 0, fail: 0, total: 0 };
    byCategory[c].total++;
    if (r.ok && !r.error) byCategory[c].pass++;
    else byCategory[c].fail++;
  }

  return {
    runId: `${startedAt.toISOString().slice(0, 10)}-${cli.provider}-${Date.now() % 1e6}`,
    provider: cli.provider,
    judgeProvider: cli.judgeProvider,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    totals,
    byCategory,
    tasks: results,
  };
}

/**
 * 对比基线，找出回归 = 上一轮 pass 这一轮 fail 的任务（按 task.id 配对）。
 * baseline 不存在 / 解析失败 → 返回 null，让 runner 知道首次跑。
 */
function diffAgainstBaseline(baselinePath: string, current: RunReport): {
  regressions: Array<{ id: string; wasPass: boolean; nowPass: boolean }>;
  newPasses: Array<{ id: string }>;
  baselineRunId: string;
} | null {
  if (!fs.existsSync(baselinePath)) return null;
  let baseline: RunReport;
  try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as RunReport; }
  catch { return null; }
  const prev = new Map<string, boolean>();
  for (const t of baseline.tasks) prev.set(t.task.id, t.ok && !t.error);
  const regressions: Array<{ id: string; wasPass: boolean; nowPass: boolean }> = [];
  const newPasses: Array<{ id: string }> = [];
  for (const t of current.tasks) {
    const wasPass = prev.get(t.task.id);
    const nowPass = t.ok && !t.error;
    if (wasPass === true && !nowPass) {
      regressions.push({ id: t.task.id, wasPass: true, nowPass: false });
    } else if (wasPass === false && nowPass) {
      newPasses.push({ id: t.task.id });
    }
  }
  return { regressions, newPasses, baselineRunId: baseline.runId };
}

function printTaskLine(r: TaskRun): void {
  const tag = r.error
    ? `${COLORS.red}ERROR${COLORS.reset}`
    : r.ok
    ? `${COLORS.green}PASS${COLORS.reset} `
    : `${COLORS.red}FAIL${COLORS.reset} `;
  const meta = `${COLORS.gray}[${r.task.category}] ${r.steps}步 ${r.tokensIn + r.tokensOut}tok ${r.durationMs}ms${COLORS.reset}`;
  console.log(`${tag} ${r.task.id.padEnd(28)} ${meta}`);
  if (r.error) {
    console.log(`     ${COLORS.red}error:${COLORS.reset} ${r.error}`);
    return;
  }
  for (const a of r.assertions) {
    if (a.pass) continue;
    console.log(`     ${COLORS.red}✗${COLORS.reset} ${a.name}${a.detail ? ` — ${a.detail}` : ''}`);
  }
}

function printSummary(report: RunReport): void {
  console.log('\n' + '═'.repeat(60));
  const { pass, fail, error, total } = report.totals;
  const passRate = total === 0 ? 0 : (pass / total) * 100;
  const color = passRate === 100 ? COLORS.green : passRate >= 80 ? COLORS.yellow : COLORS.red;
  console.log(`${COLORS.bold}总计${COLORS.reset}  ${color}${pass}/${total}${COLORS.reset} 通过 · ${COLORS.red}${fail}${COLORS.reset} 失败 · ${COLORS.red}${error}${COLORS.reset} 异常 · ${COLORS.dim}${report.durationMs}ms${COLORS.reset}`);
  for (const [cat, v] of Object.entries(report.byCategory)) {
    console.log(`  ${COLORS.cyan}${cat.padEnd(20)}${COLORS.reset} ${v.pass}/${v.total}`);
  }
  // 回归 / 新通过
  if (report.regressions !== undefined) {
    if (report.regressions.length === 0 && (report.newPasses?.length ?? 0) === 0) {
      console.log(`${COLORS.dim}vs baseline ${report.baselineRunId}: 无变化${COLORS.reset}`);
    } else {
      console.log(`${COLORS.dim}vs baseline ${report.baselineRunId}:${COLORS.reset}`);
      if (report.regressions.length > 0) {
        console.log(`  ${COLORS.red}↓ 回归 ${report.regressions.length}${COLORS.reset}`);
        for (const r of report.regressions) {
          console.log(`    ${COLORS.red}✗${COLORS.reset} ${r.id}`);
        }
      }
      if (report.newPasses && report.newPasses.length > 0) {
        console.log(`  ${COLORS.green}↑ 新通过 ${report.newPasses.length}${COLORS.reset}`);
        for (const n of report.newPasses) {
          console.log(`    ${COLORS.green}✓${COLORS.reset} ${n.id}`);
        }
      }
    }
  }
  console.log('═'.repeat(60));
}

async function main(): Promise<void> {
  const cli = parseCLI();
  console.log(`${COLORS.bold}TuttiKit Eval${COLORS.reset}  provider=${COLORS.cyan}${cli.provider}${COLORS.reset}  filter=${cli.filter || '<all>'}  concurrency=${cli.concurrency}`);
  const tasks = await loadTasks(cli.filter);
  if (tasks.length === 0) {
    console.error(`${COLORS.red}没有任务匹配 filter=${cli.filter}${COLORS.reset}`);
    process.exit(2);
  }
  console.log(`${COLORS.dim}加载 ${tasks.length} 条任务${COLORS.reset}\n`);

  const report = await runAll(tasks, cli);

  // 在 print 之前算 diff：baseline 是上一次同 provider 的 latest-*.json
  const latestPath = path.join(cli.outDir, `latest-${cli.provider}.json`);
  const diff = diffAgainstBaseline(latestPath, report);
  if (diff) {
    report.regressions = diff.regressions;
    report.newPasses = diff.newPasses;
    report.baselineRunId = diff.baselineRunId;
  }
  printSummary(report);

  // 写报表
  fs.mkdirSync(cli.outDir, { recursive: true });
  const reportPath = path.join(cli.outDir, `${report.runId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  // 写完后再覆盖 latest，下一轮的 baseline = 这一轮
  fs.writeFileSync(latestPath, JSON.stringify(report, null, 2));
  console.log(`${COLORS.dim}报表已写入 ${reportPath}${COLORS.reset}`);

  // 退出码：
  //   有 fail/error      → 1
  //   --fail-on-regression 且有回归 → 2
  //   其他                → 0
  if (cli.failOnRegression && report.regressions && report.regressions.length > 0) {
    process.exit(2);
  }
  process.exit(report.totals.fail + report.totals.error > 0 ? 1 : 0);
}

void main();
