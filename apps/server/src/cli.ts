/**
 * 终端聊天：与 Web UI 共享同一份 session 持久化。
 *   tsx src/cli.ts                                  # 新建会话
 *   tsx src/cli.ts --session <id>                   # 继续已有会话
 *   tsx src/cli.ts --provider mock "帮我算 1+1"     # 一次性问答
 */
import readline from 'node:readline';
import { ConductorAgent } from './agents/index.js';
import { MessageBus } from './core/messageBus.js';
import { sessionManager } from './core/session.js';
import { buildToolRegistryWithSubAgents } from './tools/index.js';
import { longTermMemory } from './memory/longTerm.js';
import { tracer } from './observability/tracer.js';
import { createLLM } from './llm/index.js';

const args = process.argv.slice(2);

function takeOpt(name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1) return null;
  return args.splice(i, 2)[1] ?? null;
}

const provider = takeOpt('--provider');
const sessionFlag = takeOpt('--session');
const oneshot = args.join(' ').trim();

const bus = new MessageBus();
const llm = createLLM(provider ?? undefined);
const toolRegistry = buildToolRegistryWithSubAgents({ llm, longTermMemory, bus });
const conductor = new ConductorAgent({ llm, toolRegistry, sessionManager, bus });

const session = sessionFlag
  ? await sessionManager.get(sessionFlag)
  : await sessionManager.create({});
if (!session) {
  console.error(`找不到 session: ${sessionFlag}`);
  process.exit(1);
}

console.log(`\n会话：${session.title}  (id: ${session.id})  provider: ${llm.name}\n`);

bus.on('message:start', () => process.stdout.write('\n\x1b[36mAssistant:\x1b[0m '));
bus.on('message:token', ({ chunk }: { chunk: string }) => process.stdout.write(chunk));
bus.on('message:end', () => process.stdout.write('\n'));
bus.on('tool:start', ({ name, input }: { name: string; input: unknown }) => {
  process.stdout.write(`\n  \x1b[33m🔧 ${name}\x1b[0m ${shortJson(input)}\n`);
});
bus.on('tool:end', ({ name, result }: { name: string; result: unknown }) => {
  const r = result as { result?: unknown; value?: unknown; path?: unknown } | undefined;
  const summary = String(r?.result ?? r?.value ?? r?.path ?? JSON.stringify(result)).slice(0, 120);
  process.stdout.write(`  \x1b[32m  ✓ ${name}\x1b[0m → ${summary}\n`);
});
bus.on('tool:error', ({ name, error }: { name: string; error: string }) => {
  process.stdout.write(`  \x1b[31m  ✗ ${name}\x1b[0m → ${error}\n`);
});
bus.on('turn:done', ({ usage }: { usage: { inputTokens?: number; outputTokens?: number } }) => {
  process.stdout.write(`\n\x1b[2m  ${usage.inputTokens || 0} in · ${usage.outputTokens || 0} out\x1b[0m\n\n`);
});

async function ask(text: string): Promise<void> {
  process.stdout.write(`\n\x1b[34mYou:\x1b[0m ${text}\n`);
  const trace = tracer.startTrace('cli.turn', { sessionId: session!.id });
  try {
    await conductor.respond({ sessionId: session!.id, userMessage: text, stream: true, trace, tracer });
  } finally {
    tracer.endTrace(trace);
  }
}

if (oneshot) {
  await ask(oneshot);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt('\x1b[34mYou:\x1b[0m ');
rl.prompt();
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (text === '/exit' || text === '/quit') {
    process.exit(0);
  }
  if (text === '/history') {
    const s = await sessionManager.get(session!.id);
    console.log(`\n${s!.messages.length} 条消息：`);
    s!.messages.forEach((m, i) => {
      const sn = String(m.content || '').slice(0, 80).replace(/\n/g, ' ');
      console.log(`  ${i + 1}. [${m.role}] ${sn}`);
    });
    console.log();
    return rl.prompt();
  }
  rl.pause();
  await ask(text);
  rl.resume();
  rl.prompt();
});

function shortJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  } catch { return String(v); }
}
