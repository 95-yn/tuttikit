import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import cors from 'cors';
import multer from 'multer';
import { config, validateEnvOnBoot } from './config.js';
import { MessageBus } from './core/messageBus.js';
import { ConductorAgent } from './agents/index.js';
import { sessionManager } from './core/session.js';
import { buildToolRegistryWithSubAgents } from './tools/index.js';
import { longTermMemory } from './memory/longTerm.js';
import { attachSSE } from './streaming/sse.js';
import { tracer } from './observability/tracer.js';
import { logger } from './observability/logger.js';
import { createLLM } from './llm/index.js';
import { broadcaster, type BroadcastEvent } from './core/broadcaster.js';
import { saveUpload, getUpload, MAX_BYTES, classify } from './core/uploads.js';
import { skillsLoader } from './skills/index.js';
import {
  translateSkillField, hashOf, readSavedTranslation, writeTranslation, translationFilePath,
  translateNamesBatch, readNamesIndex, writeNamesIndex,
  type SkillLang,
} from './skills/translator.js';
import { mcpManager } from './mcp/index.js';
import {
  translateMcpTools, readMcpTranslation, writeMcpTranslation, hashOfTools, shortToolName,
  type McpLang,
} from './mcp/translator.js';
import { drainer } from './core/drain.js';
import { budgetGuard } from './core/budget.js';
import type { Attachment } from './types.js';

const app = express();

// 简易安全响应头（覆盖 helmet 的默认子集）。
//   API 服务，故不挂 CSP 以免误杀；跨域资源用 cross-origin 让浏览器/Next.js 能读 /uploads。
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Origin-Agent-Cluster', '?1');
  // 只有 HTTPS 下浏览器才会理它；本地 http 下无效，故放上去无害
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

app.use(cors({
  origin: config.server.corsOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

// drain 中的请求直接 503（必须在所有路由之前注册）。/health 放行，便于 load balancer 持续 ping 直到下线
app.use((req, res, next) => {
  if (drainer.isDraining() && req.path !== '/health') {
    res.setHeader('Connection', 'close');
    return res.status(503).json({ error: 'server is draining' });
  }
  next();
});

// ───── SSE 连接并发限流：防止单 IP 把长连接打满 ─────
const SSE_MAX_PER_IP = 8;     // 单 IP 最多同时 8 个 SSE 长连接
const sseConnCount = new Map<string, number>();
function getClientIp(req: Request): string {
  // 优先 trust-proxy 解析过的 ip；没有的话 fallback 到 socket.remoteAddress
  return (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}
const sseLimiter: RequestHandler = (req, res, next) => {
  const ip = getClientIp(req);
  const cur = sseConnCount.get(ip) ?? 0;
  if (cur >= SSE_MAX_PER_IP) {
    res.status(429).json({ error: `too many SSE connections from ${ip} (max ${SSE_MAX_PER_IP})` });
    return;
  }
  sseConnCount.set(ip, cur + 1);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const n = sseConnCount.get(ip) ?? 1;
    if (n <= 1) sseConnCount.delete(ip);
    else sseConnCount.set(ip, n - 1);
  };
  res.on('close', release);
  res.on('finish', release);
  next();
};

app.get('/health', (_req, res) => {
  // 暴露当前 provider + model + 上下文窗口，让前端 CtxMeter 不再硬编码窗口
  const provider = config.llm.provider;
  const model = currentModelOf(provider);
  res.json({
    ok: true,
    provider,
    model,
    contextWindow: contextWindowOf(provider, model),
  });
});

/** 取当前 provider 配置里的 model 名（mock 也给一个合理值） */
function currentModelOf(provider: string): string {
  if (provider === 'mock') return 'mock';
  const cfg = (config.llm as unknown as Record<string, { model?: string } | undefined>)[provider];
  return cfg?.model || '';
}

/** 各 provider × model 的 context window 上限；和 web 端 tokens.ts 同步 */
function contextWindowOf(provider: string, model: string): number {
  const table: Record<string, number> = {
    'anthropic:claude-opus-4':    200_000,
    'anthropic:claude-sonnet-4':  200_000,
    'anthropic:claude-haiku-4':   200_000,
    'anthropic:claude-3-5-sonnet': 200_000,
    'anthropic:claude-3-5-haiku':  200_000,
    'openai:gpt-4o':              128_000,
    'openai:gpt-4o-mini':         128_000,
    'openai:gpt-4.1':           1_047_576,
    'openai:gpt-4.1-mini':      1_047_576,
    'openai:o1':                  200_000,
    'openai:o3-mini':             200_000,
    'deepseek:deepseek-chat':     128_000,
    'deepseek:deepseek-reasoner':  64_000,
    // 国产 provider
    'qwen:qwen-max':               32_000,
    'qwen:qwen-plus':             131_072,
    'qwen:qwen-turbo':          1_000_000,
    'qwen:qwen3':                262_144,
    'doubao:doubao-1-5-pro-32k':   32_000,
    'doubao:doubao-1-5-pro-256k': 256_000,
    'doubao:doubao-1-5-lite':      32_000,
    'hunyuan:hunyuan-turbos':      32_000,
    'hunyuan:hunyuan-large':       32_000,
    'hunyuan:hunyuan-standard':    32_000,
    'glm:glm-4-plus':             128_000,
    'glm:glm-4-flash':            128_000,
    'glm:glm-4':                  128_000,
    'kimi:moonshot-v1-8k':          8_000,
    'kimi:moonshot-v1-32k':        32_000,
    'kimi:moonshot-v1-128k':      128_000,
    'mock:mock':                    8_000,
  };
  // 精确
  const exact = table[`${provider}:${model}`];
  if (exact) return exact;
  // 前缀（claude-sonnet-4-6 → claude-sonnet-4）
  let bestKey: string | null = null;
  const prefix = `${provider}:`;
  for (const k of Object.keys(table)) {
    if (!k.startsWith(prefix)) continue;
    const tail = k.slice(prefix.length);
    if (model.startsWith(tail) && (!bestKey || tail.length > bestKey.length)) bestKey = tail;
  }
  if (bestKey) return table[`${provider}:${bestKey}`];
  // provider 兜底
  return {
    anthropic: 200_000, openai: 128_000, deepseek: 128_000,
    qwen: 131_072, doubao: 32_000, hunyuan: 32_000, glm: 128_000, kimi: 32_000,
    mock: 8_000,
  }[provider] ?? 32_000;
}

/** /ready：比 /health 严格——还要能写 data 目录 + LLM provider 配置正常。给 K8s readinessProbe 用。 */
app.get('/ready', async (_req, res) => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  // 1. env 校验
  const env = validateEnvOnBoot();
  checks.env = env.ok ? { ok: true } : { ok: false, detail: env.errors.join('; ') };
  // 2. data 目录可写
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const probe = path.resolve('./data/.ready-probe');
    await fs.mkdir(path.dirname(probe), { recursive: true });
    await fs.writeFile(probe, '');
    await fs.unlink(probe);
    checks.dataWritable = { ok: true };
  } catch (err) {
    checks.dataWritable = { ok: false, detail: (err as Error).message };
  }
  // 3. MCP server 至少 50% 连上（如有配置）
  const mcpStatuses = mcpManager.getStatuses();
  if (mcpStatuses.length > 0) {
    const okN = mcpStatuses.filter((s) => s.state === 'connected').length;
    checks.mcp = {
      ok: okN >= Math.ceil(mcpStatuses.length / 2),
      detail: `${okN}/${mcpStatuses.length} connected`,
    };
  }
  const ok = Object.values(checks).every((c) => c.ok);
  res.status(ok ? 200 : 503).json({ ok, checks });
});

// ───── 文件上传（图片 / PDF） ─────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  defParamCharset: 'utf8',
  fileFilter: (_req, file, cb) => {
    if (classify(file.mimetype)) cb(null, true);
    else cb(new Error(`unsupported media type: ${file.mimetype}`));
  },
});

function repairMojibake(s: string | undefined): string | undefined {
  if (!s) return s;
  if (!/[ÃÂæèéê][\x80-\xBF]/.test(s)) return s;
  try {
    return Buffer.from(s, 'latin1').toString('utf8');
  } catch {
    return s;
  }
}
app.post('/uploads', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    req.file.originalname = repairMojibake(req.file.originalname) || req.file.originalname;
    const entry = await saveUpload(req.file);
    res.json(entry);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
// multer LIMIT_FILE_SIZE 等会冒到这里
app.use('/uploads', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err) return res.status(400).json({ error: (err as Error).message });
  next();
});
app.get('/uploads/:id', async (req, res) => {
  const meta = await getUpload(req.params.id);
  if (!meta) return res.status(404).end('not found');
  res.setHeader('Content-Type', meta.mediaType);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(meta.filename)}`);
  res.sendFile(meta.fullPath);
});

// ───── Sessions CRUD ─────
app.post('/sessions', async (_req, res) => {
  const s = await sessionManager.create({});
  res.json(s);
  broadcaster.sessionsChanged('created', s.id);
});
app.get('/sessions', async (_req, res) => {
  res.json(await sessionManager.list());
});
app.get('/sessions/:id/budget', (req, res) => {
  const stats = budgetGuard.getSessionStats(String(req.params.id));
  if (!stats) return res.json({ inputTokens: 0, outputTokens: 0, totalUSD: 0, turns: 0 });
  res.json(stats);
});
app.get('/sessions/:id', async (req, res) => {
  const s = await sessionManager.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
});
app.patch('/sessions/:id', async (req, res) => {
  try {
    const s = await sessionManager.rename(req.params.id, String(req.body?.title || '').slice(0, 80));
    res.json(s);
    broadcaster.sessionsChanged('renamed', s.id);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});
app.delete('/sessions/:id', async (req, res) => {
  const ok = await sessionManager.delete(req.params.id);
  res.json({ ok });
  if (ok) broadcaster.sessionsChanged('deleted', req.params.id);
});

// 截断消息：DELETE /sessions/:id/messages?fromIndex=N （重生 / 编辑后重发用）
app.delete('/sessions/:id/messages', async (req, res) => {
  try {
    const fromIndex = Number(req.query.fromIndex ?? -1);
    if (!Number.isFinite(fromIndex) || fromIndex < 0) {
      return res.status(400).json({ error: 'fromIndex 必填且为非负整数' });
    }
    const s = await sessionManager.truncateMessages(req.params.id, fromIndex);
    if (!s) return res.status(404).json({ error: 'session not found' });
    res.json(s);
    broadcaster.sessionUpdated(s.id);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ───── Chat（SSE 流） ─────
app.get('/sessions/:id/stream', sseLimiter, async (req, res) => {
  const sessionId = String(req.params.id);
  const message = String(req.query.message || '');
  const provider = req.query.provider ? String(req.query.provider) : undefined;
  const attachmentIds = String(req.query.attachmentIds || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (!message.trim() && attachmentIds.length === 0) {
    return res.status(400).end('message or attachments required');
  }

  const session = await sessionManager.get(sessionId);
  if (!session) return res.status(404).end('session not found');

  const attachments: Attachment[] = [];
  for (const id of attachmentIds) {
    const meta = await getUpload(id);
    if (meta) {
      attachments.push({
        id: meta.id, kind: meta.kind, mediaType: meta.mediaType,
        filename: meta.filename, sizeBytes: meta.sizeBytes,
      });
    }
  }

  const bus = new MessageBus();
  attachSSE(bus, res);

  const llm = createLLM(provider);
  const toolRegistry = buildToolRegistryWithSubAgents({ llm, longTermMemory, bus });
  const conductor = new ConductorAgent({ llm, toolRegistry, sessionManager, bus });

  // 客户端断开（用户 stop / 关浏览器）→ abort 这一 turn 的 tool 调用
  const turnAbort = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      turnAbort.abort(new Error('client disconnected'));
    }
  });

  const trace = tracer.startTrace('conductor.turn', { sessionId, message });
  try {
    await conductor.respond({
      sessionId, userMessage: message, attachments,
      stream: true, trace, tracer,
      signal: turnAbort.signal,
    });
  } catch (err) {
    logger.error({ err }, 'turn failed');
    bus.emit('turn:error', { sessionId, error: (err as Error).message });
  } finally {
    tracer.endTrace(trace);
    broadcaster.sessionUpdated(sessionId);
    broadcaster.sessionsChanged('turn-done', sessionId);
  }
});

// ───── 全局事件广播（多设备同步） ─────
app.get('/events', sseLimiter, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);

  const onEvent = (payload: BroadcastEvent): void => {
    res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  broadcaster.on('event', onEvent);

  const hb = setInterval(() => res.write(': hb\n\n'), 15_000);

  req.on('close', () => {
    clearInterval(hb);
    broadcaster.off('event', onEvent);
  });
});

// ───── Trace 查询 ─────
app.get('/traces', (_req, res) => res.json(tracer.list()));
app.get('/traces/:id', (req, res) => {
  const t = tracer.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
});

/**
 * Trace Replay：用 1 个或多个 provider 把原始 user message 各重跑一次，
 * 每次写入独立 trace（标记 replayOf）。多 provider 用于 A/B 对比。
 *
 *   POST /traces/:id/replay
 *   body: { provider?: string }                   ← 单 provider（向后兼容）
 *   body: { providers: string[] }                 ← 多 provider 并发 replay
 *
 * 返回：
 *   { replayTraceId, forkedSessionId, provider }                    （单 provider，老调用方）
 *   { replays: [{ replayTraceId, forkedSessionId, provider, error? }, ...] }   （多 provider）
 */
app.post('/traces/:id/replay', async (req, res) => {
  const original = tracer.get(req.params.id);
  if (!original) return res.status(404).json({ error: 'trace not found' });
  const originalMessage = (original.meta as { message?: string })?.message;
  if (!originalMessage) {
    return res.status(400).json({ error: 'trace 缺 meta.message，无法 replay' });
  }

  // 入参归一化：providers 数组优先；否则用单 provider；都没传走默认
  let providers: Array<string | undefined>;
  let multiMode = false;
  if (Array.isArray(req.body?.providers) && req.body.providers.length > 0) {
    providers = req.body.providers.map((p: unknown) => p ? String(p) : undefined);
    multiMode = true;
  } else {
    providers = [req.body?.provider ? String(req.body.provider) : undefined];
  }

  // 并发跑所有 replay；每个独立的 forked session + trace
  const tasks = providers.map(async (providerName) => {
    try {
      const forked = await sessionManager.create({
        title: `replay of ${req.params.id}${providerName ? ` (${providerName})` : ''}`,
      });
      const bus = new MessageBus();
      const llm = createLLM(providerName);
      const toolRegistry = buildToolRegistryWithSubAgents({ llm, longTermMemory, bus });
      const conductor = new ConductorAgent({ llm, toolRegistry, sessionManager, bus });

      const replayTrace = tracer.startTrace('conductor.replay', {
        sessionId: forked.id,
        message: originalMessage,
        replayOf: req.params.id,
        provider: providerName || 'default',
      });
      try {
        await conductor.respond({
          sessionId: forked.id, userMessage: originalMessage,
          stream: false, trace: replayTrace, tracer,
        });
      } finally {
        tracer.endTrace(replayTrace);
      }
      return {
        replayTraceId: replayTrace.traceId,
        forkedSessionId: forked.id,
        provider: providerName || 'default',
      };
    } catch (err) {
      return {
        provider: providerName || 'default',
        error: (err as Error).message,
      };
    }
  });
  const results = await Promise.all(tasks);

  if (multiMode) {
    return res.json({ replays: results });
  }
  // 单 provider 向后兼容：拿第一个；如果出错也返 200（兼容旧前端）
  const first = results[0];
  if ('error' in first) return res.status(500).json({ error: first.error });
  return res.json(first);
});

// ───── 长期记忆 ─────
app.get('/memory', (_req, res) => res.json(longTermMemory.all()));
app.get('/memory/search', (req, res) => {
  res.json(longTermMemory.search(String(req.query.q || ''), Number(req.query.k || 5)));
});

// ───── Skills / MCP 状态查询 + 管理 ─────
app.get('/skills', (_req, res) => res.json(skillsLoader.list()));
app.get('/skills/:name', (req, res) => {
  const sk = skillsLoader.get(String(req.params.name));
  if (!sk) return res.status(404).json({ error: 'skill not found' });
  res.json(sk);
});
/** 手动 reinit skills（用户改完磁盘上的 SKILL.md 后调一下，不用重启进程） */
app.post('/skills/reload', (_req, res) => {
  skillsLoader.reload();
  res.json({ ok: true, count: skillsLoader.list().length });
});

/**
 * GET：读已落盘的中文翻译（如果存在且没过期）。前端进入详情页时调一次，决定按钮是「翻译」还是「✓ 已翻译」。
 * 返回 404 表示还没翻译过 / 原文改了导致缓存失效。
 */
app.get('/skills/:name/translation', async (req, res) => {
  const lang = String(req.query.lang || 'zh') as SkillLang;
  if (lang !== 'zh' && lang !== 'en') return res.status(400).json({ error: 'lang 必须是 zh 或 en' });
  const sk = skillsLoader.get(String(req.params.name));
  if (!sk) return res.status(404).json({ error: 'skill not found' });
  const saved = await readSavedTranslation(sk.name, lang, hashOf(sk.description), hashOf(sk.body));
  if (!saved) return res.status(404).json({ error: 'no saved translation' });
  res.json(saved);
});

/**
 * POST：触发翻译 + 落盘。
 * 文件落到 data/skills-zh/<sanitized-name>.<lang>.md，frontmatter 带 hash 和元信息。
 * 第二次调（原文没变）会命中内存 cache，毫秒级返回。
 */
app.post('/skills/:name/translate', async (req, res) => {
  const lang = String(req.query.lang || 'zh') as SkillLang;
  if (lang !== 'zh' && lang !== 'en') return res.status(400).json({ error: 'lang 必须是 zh 或 en' });
  const sk = skillsLoader.get(String(req.params.name));
  if (!sk) return res.status(404).json({ error: 'skill not found' });
  try {
    // 先查磁盘缓存
    const cached = await readSavedTranslation(sk.name, lang, hashOf(sk.description), hashOf(sk.body));
    if (cached) {
      return res.json({
        name: sk.name, lang,
        description: cached.description, body: cached.body,
        path: cached.path, cached: true, provider: cached.provider,
      });
    }
    // 翻译
    const desc = await translateSkillField({ name: sk.name, text: sk.description, targetLang: lang, kind: 'desc' });
    const body = await translateSkillField({ name: sk.name, text: sk.body, targetLang: lang, kind: 'body' });
    // 落盘
    const filePath = await writeTranslation({
      name: sk.name, lang,
      description: desc.text, body: body.text,
      origDesc: sk.description, origBody: sk.body,
      provider: process.env.TRANSLATOR_PROVIDER || config.llm.provider,
    });
    res.json({
      name: sk.name, lang,
      description: desc.text, body: body.text,
      path: filePath, cached: false,
      provider: process.env.TRANSLATOR_PROVIDER || config.llm.provider,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

void translationFilePath;  // 保留 import 供测试或后续路由用

/** GET：读已落盘的「列表显示名」翻译索引；前端进入 /skills 时拉一次 */
app.get('/skills/translated-names', async (req, res) => {
  const lang = String(req.query.lang || 'zh') as SkillLang;
  if (lang !== 'zh' && lang !== 'en') return res.status(400).json({ error: 'lang 必须是 zh 或 en' });
  const idx = await readNamesIndex(lang);
  if (!idx) return res.status(404).json({ error: 'no names index' });
  res.json(idx);
});

/**
 * POST：一次性翻所有 skill 的「列表显示名」。
 * 大批量分块（每批 25 个），结果合并存到 data/skills-zh/_names.<lang>.json。
 *   - id 本身不变（程序调用要用）
 *   - 只生成简短中文显示名（4-12 字）
 */
app.post('/skills/translate-names', async (req, res) => {
  const lang = String(req.query.lang || 'zh') as SkillLang;
  if (lang !== 'zh' && lang !== 'en') return res.status(400).json({ error: 'lang 必须是 zh 或 en' });
  const all = skillsLoader.list();
  // 已经翻过的不再翻（增量）
  const existing = (await readNamesIndex(lang))?.names ?? {};
  const todo = all.filter((s) => !existing[s.name]);
  if (todo.length === 0) {
    return res.json({ lang, total: all.length, translated: Object.keys(existing).length, newlyTranslated: 0, path: '' });
  }
  const BATCH = 25;
  const merged: Record<string, string> = { ...existing };
  let newlyTranslated = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH).map((s) => ({ name: s.name, description: s.description }));
    const out = await translateNamesBatch(slice, lang);
    Object.assign(merged, out);
    newlyTranslated += Object.keys(out).length;
  }
  const idx = { lang, savedAt: new Date().toISOString(), names: merged };
  const p = await writeNamesIndex(idx);
  res.json({ lang, total: all.length, translated: Object.keys(merged).length, newlyTranslated, path: p });
});
app.get('/mcp', (_req, res) => res.json(mcpManager.getStatuses()));
app.get('/mcp/:name', (req, res) => {
  const s = mcpManager.getStatuses().find((x) => x.name === String(req.params.name));
  if (!s) return res.status(404).json({ error: 'mcp server not found' });
  const tools = mcpManager.getToolSpecs()
    .filter((t) => t.name.startsWith(`mcp__${req.params.name}__`))
    .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  res.json({ ...s, tools });
});
/** GET: 已落盘的 MCP server 翻译 */
app.get('/mcp/:name/translation', async (req, res) => {
  const lang = String(req.query.lang || 'zh') as McpLang;
  if (lang !== 'zh' && lang !== 'en') return res.status(400).json({ error: 'lang 必须是 zh 或 en' });
  const serverName = String(req.params.name);
  const status = mcpManager.getStatuses().find((s) => s.name === serverName);
  if (!status) return res.status(404).json({ error: 'mcp server not found' });
  const tools = mcpManager.getToolSpecs()
    .filter((t) => t.name.startsWith(`mcp__${serverName}__`))
    .map((t) => ({ fullName: t.name, shortName: shortToolName(t.name, serverName), description: t.description }));
  const saved = await readMcpTranslation(serverName, lang, hashOfTools(tools));
  if (!saved) return res.status(404).json({ error: 'no saved translation' });
  res.json(saved);
});

/** POST: 翻译这个 server 的所有 tool descriptions + displayName，落盘 */
app.post('/mcp/:name/translate', async (req, res) => {
  const lang = String(req.query.lang || 'zh') as McpLang;
  if (lang !== 'zh' && lang !== 'en') return res.status(400).json({ error: 'lang 必须是 zh 或 en' });
  const serverName = String(req.params.name);
  const status = mcpManager.getStatuses().find((s) => s.name === serverName);
  if (!status) return res.status(404).json({ error: 'mcp server not found' });
  const tools = mcpManager.getToolSpecs()
    .filter((t) => t.name.startsWith(`mcp__${serverName}__`))
    .map((t) => ({ fullName: t.name, shortName: shortToolName(t.name, serverName), description: t.description }));
  if (tools.length === 0) {
    return res.json({ server: serverName, lang, displayNames: {}, descriptions: {}, path: '', tools: 0 });
  }
  const sourceHash = hashOfTools(tools);
  try {
    // 缓存命中
    const cached = await readMcpTranslation(serverName, lang, sourceHash);
    if (cached) return res.json({ ...cached, cached: true });
    const { displayNames, descriptions } = await translateMcpTools({ serverName, tools, lang });
    const result = {
      server: serverName, lang, sourceHash,
      savedAt: new Date().toISOString(),
      displayNames, descriptions,
    };
    const p = await writeMcpTranslation(result);
    res.json({ ...result, path: p, cached: false });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post('/mcp/:name/reconnect', async (req, res) => {
  try {
    const r = await mcpManager.reconnect(String(req.params.name));
    if (!r.ok) return res.status(404).json({ error: r.error || 'reconnect failed' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ───── boot ─────
async function boot(): Promise<void> {
  // 1. env 校验：缺 API key 直接挂，不要等第一次请求才报错
  const envCheck = validateEnvOnBoot();
  if (!envCheck.ok) {
    console.error('❌ 环境变量校验失败：');
    for (const e of envCheck.errors) console.error(`  - ${e}`);
    console.error('修复 .env 后重启。\n');
    process.exit(1);
  }

  // 2. 同步：扫 ~/.claude/skills + .claude/skills
  skillsLoader.init();
  // 3. 异步：连接 MCP servers（失败的跳过，不阻塞 listen）
  await mcpManager.init().catch((err) => logger.warn({ err }, '[mcp] init 抛错'));

  serverHandle = app.listen(config.server.port, () => {
    logger.info(`multi-agent server 已启动 → http://localhost:${config.server.port}`);
    logger.info(`默认 LLM provider: ${config.llm.provider}`);
  });
}

let serverHandle: ReturnType<typeof app.listen> | null = null;

// 优雅退出：1) 停接新请求 → 2) 等 in-flight turn 完成（≤30s）→ 3) 关 MCP / sessions → exit
const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal, inFlight: drainer.count() }, '[server] 收到信号，开始关闭...');
  // 1. 停接新请求；现有连接保留（SSE 长连接由 drainer 控制）
  if (serverHandle) {
    serverHandle.close();
  }
  // 2. 等当前所有 conductor.respond() 跑完
  await drainer.drain(30_000);
  // 3. 关 MCP 子进程
  await mcpManager.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void boot();
