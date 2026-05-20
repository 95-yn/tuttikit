import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import { config } from './config.js';
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
import { mcpManager } from './mcp/index.js';
import type { Attachment } from './types.js';

const app = express();
app.use(cors({
  origin: config.server.corsOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, provider: config.llm.provider }));

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

// ───── Chat（SSE 流） ─────
app.get('/sessions/:id/stream', async (req, res) => {
  const sessionId = req.params.id;
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

  const trace = tracer.startTrace('conductor.turn', { sessionId, message });
  try {
    await conductor.respond({
      sessionId, userMessage: message, attachments,
      stream: true, trace, tracer,
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
app.get('/events', (req, res) => {
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

// ───── 长期记忆 ─────
app.get('/memory', (_req, res) => res.json(longTermMemory.all()));
app.get('/memory/search', (req, res) => {
  res.json(longTermMemory.search(String(req.query.q || ''), Number(req.query.k || 5)));
});

// ───── Skills / MCP 状态查询（调试用）─────
app.get('/skills', (_req, res) => res.json(skillsLoader.list()));
app.get('/mcp', (_req, res) => res.json(mcpManager.getStatuses()));

// ───── boot ─────
async function boot(): Promise<void> {
  // 同步：扫 ~/.claude/skills + .claude/skills
  skillsLoader.init();
  // 异步：连接 MCP servers（失败的跳过，不阻塞 listen）
  await mcpManager.init().catch((err) => logger.warn({ err }, '[mcp] init 抛错'));

  app.listen(config.server.port, () => {
    logger.info(`multi-agent server 已启动 → http://localhost:${config.server.port}`);
    logger.info(`默认 LLM provider: ${config.llm.provider}`);
  });
}

// 优雅退出：关 MCP client 子进程 / 长连接
const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, '[server] 收到信号，开始关闭...');
  await mcpManager.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void boot();
