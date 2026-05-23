import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import { config, validateEnvOnBoot } from './config.js';
import { sessionManager } from './core/session.js';
import { pruneOldTraces, tracer } from './observability/tracer.js';
import { logger } from './observability/logger.js';
import { contextWindowOf } from './llm/contextWindow.js';
import { installDefaultSafetyHooks } from './core/safetyRules.js';
import { migrateJSONToSQLite } from './core/migration.js';
import { closeDB, getDB } from './core/db.js';
import { saveFeedback, getFeedbackForSession, feedbackStats } from './core/feedback.js';
import { getArtifact, listArtifactsForSession } from './core/artifact.js';
import {
  installApprovalHook, resolveApproval, listPending,
  cancelAllForSession, clearStaleApprovalsOnBoot,
  DEFAULT_APPROVAL_RULES, loadApprovalRulesFromEnv,
} from './core/approval.js';
import { listAllHooks } from './core/hooks.js';
import { DEFAULT_DANGER_RULES, loadExtraRulesFromEnv } from './core/safetyRules.js';
import { broadcaster } from './core/broadcaster.js';
import { saveUpload, getUpload, MAX_BYTES, classify } from './core/uploads.js';
import { skillsLoader } from './skills/index.js';
import { mcpManager } from './mcp/index.js';
import { drainer } from './core/drain.js';
import { budgetGuard } from './core/budget.js';
import { register as registerTracesRoutes } from './routes/traces.js';
import { register as registerMemoryRoutes } from './routes/memory.js';
import { register as registerSkillsRoutes } from './routes/skills.js';
import { register as registerMcpRoutes } from './routes/mcp.js';
import { register as registerStreamsRoutes } from './routes/streams.js';

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
  // 删 session 前先清掉它身上挂着的 pending 审批（避免 hook promise 永远不 resolve）
  cancelAllForSession(req.params.id);
  const ok = await sessionManager.delete(req.params.id);
  res.json({ ok });
  if (ok) broadcaster.sessionsChanged('deleted', req.params.id);
});

// ── 动态审批：列出当前 session 下的 pending（reconnect 后前端拉一次） ──
app.get('/sessions/:id/permissions', (req, res) => {
  res.json({ pending: listPending(req.params.id) });
});

// ── debug：列出当前注册的 hook 数 + 安全/审批规则名 + 内置 danger 规则名 ──
// 排查"为啥这条命令被拦了 / 怎么没被拦"时直接 curl 这个 endpoint
//
// 安全约束（C3 修复）：返回里包含 regex pattern.source —— 攻击者拿到能精确避开拦截。
//   - 默认仅 NODE_ENV !== 'production' 时挂载；prod 直接 404
//   - 即使非 prod，也要求 Authorization: Bearer <DEBUG_TOKEN>（如果 env 设了的话）；
//     未设 DEBUG_TOKEN 时降级为 localhost-only（拒绝外网 IP）
app.get('/debug/hooks', (req, res) => {
  if (process.env.NODE_ENV === 'production' && !config.debug.token) {
    return res.status(404).json({ error: 'not_found' });
  }
  const expected = config.debug.token;
  if (expected) {
    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || match[1] !== expected) {
      return res.status(401).json({ error: 'unauthorized', hint: '需要 Authorization: Bearer <DEBUG_TOKEN>' });
    }
  } else {
    // 没设 token：只允许 localhost / 内网回环
    const ip = req.ip ?? req.socket.remoteAddress ?? '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('::ffff:127.');
    if (!isLocal) {
      return res.status(403).json({ error: 'forbidden', hint: '未设 DEBUG_TOKEN 时仅允许 localhost 访问' });
    }
  }
  const safetyRules = [...DEFAULT_DANGER_RULES, ...loadExtraRulesFromEnv()];
  const approvalRules = [...DEFAULT_APPROVAL_RULES, ...loadApprovalRulesFromEnv()];
  res.json({
    hooks: listAllHooks(),
    safetyRules: safetyRules.map((r) => ({ name: r.name, pattern: r.pattern.source, reason: r.reason })),
    approvalRules: approvalRules.map((r) => ({ name: r.name, pattern: r.pattern.source, reason: r.reason })),
  });
});

// ── 动态审批：用户点 Approve / Deny 后回收 ──
app.post('/sessions/:id/permissions/:reqId/answer', express.json(), (req, res) => {
  const allow = (req.body as { allow?: unknown })?.allow === true;
  const result = resolveApproval(req.params.reqId, allow);
  if (!result.ok) return res.status(404).json(result);
  res.json({ ok: true, allow });
});

// ── 用户对 assistant 消息打 👍/👎（W1.1 Y7）──
app.post('/sessions/:id/messages/:messageId/feedback', express.json(), (req, res) => {
  const body = req.body as { rating?: unknown; comment?: unknown };
  const rating = body?.rating === 1 || body?.rating === -1 ? body.rating : null;
  if (rating === null) return res.status(400).json({ error: 'rating 必填且必须是 1 或 -1' });
  const comment = typeof body.comment === 'string' ? body.comment.slice(0, 1000) : undefined;
  const rec = saveFeedback({
    sessionId: req.params.id, messageId: req.params.messageId, rating, comment,
  });
  res.json(rec);
});
app.get('/sessions/:id/feedback', (req, res) => {
  res.json({ items: getFeedbackForSession(req.params.id), stats: feedbackStats(req.params.id) });
});

// ── Artifacts（Claude Artifacts 风格的 LLM 渲染 HTML）──
app.get('/sessions/:id/artifacts', (req, res) => {
  res.json({ items: listArtifactsForSession(req.params.id) });
});
app.get('/artifacts/:id', (req, res) => {
  const a = getArtifact(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
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
// streams 路由（POST /sessions/:id/stream + GET /events）拆到 routes/streams.ts

// ───── Trace / Memory / Skills / MCP 路由（已拆到 routes/ 下） ─────
registerTracesRoutes(app);
registerMemoryRoutes(app);
registerSkillsRoutes(app);
registerMcpRoutes(app);
registerStreamsRoutes(app);

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

  // 2a. 一次性迁移老 JSON 数据到 sqlite（首次启动后老文件会被改名 .migrated，再启动跳过）
  try {
    migrateJSONToSQLite();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[migration] 迁移失败（不阻塞启动）');
  }

  // 2b. 安装内置安全 hook（rm -rf / DROP DATABASE / fork bomb 等硬拦截）
  installDefaultSafetyHooks();
  logger.info('[safety] 已加载默认 danger pattern 拦截规则');

  // 2c. 安装审批 hook + 清理上次进程残留的 pending
  clearStaleApprovalsOnBoot();
  const approvalRules = [...DEFAULT_APPROVAL_RULES, ...loadApprovalRulesFromEnv()];
  installApprovalHook(approvalRules);
  logger.info(`[approval] 已加载 ${approvalRules.length} 条审批规则`);

  // 3. 同步：扫 ~/.claude/skills + .claude/skills
  skillsLoader.init();
  // 3b. 清理过期 trace 文件（防 data/traces 无限增长）—— 不阻塞 listen
  void pruneOldTraces().then((n) => {
    if (n > 0) logger.info({ removed: n }, '[tracer] 清理过期 trace 文件');
  });
  // 4. 异步：连接 MCP servers（失败的跳过，不阻塞 listen）
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
  // 4. 等所有 in-flight tracer 写盘完成（避免丢最后一两个 trace）
  await tracer.flushPersistQueue();
  // 5. 把 sqlite WAL checkpoint 合到主 db 文件 + 关连接（让 .db-wal / .db-shm 干净退出）
  try {
    getDB().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    closeDB();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[shutdown] sqlite checkpoint 失败');
  }
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// 全局错误兜底：任何未捕获的 async 异常 / promise reject 都不让进程挂掉，只 log
// 真要让 K8s 重启时手动 shutdown('FATAL')
process.on('uncaughtException', (err) => {
  logger.error({ err: err.stack ?? err.message }, '[fatal] uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason instanceof Error ? reason.stack : reason }, '[fatal] unhandledRejection');
});

void boot();
