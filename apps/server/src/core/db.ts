/**
 * SQLite 单例 —— Node ≥ 22.5 内置 `node:sqlite`，零依赖、零 native build。
 *
 * 设计原则：
 *   1. **进程内单例**：所有模块（session / longTerm / approval）共享同一个 DB 连接。
 *      sqlite 是文件级别锁，多连接会互相阻塞——单例 + WAL 模式吞吐最好。
 *   2. **WAL 模式**：写不阻塞读；reader 看到的是 commit 时的快照。
 *   3. **lazy init**：第一次 getDB() 才连接，所以测试能在 import 后改 path。
 *   4. **同步 API**：DatabaseSync 在主线程同步执行 SQL——sqlite 写盘很快（μs 级），
 *      不会真的"阻塞 event loop"那么夸张；换异步反而要 worker thread。
 *   5. **idempotent DDL**：`CREATE TABLE IF NOT EXISTS`，启动多少次都安全。
 *
 * 表结构见 _ensureSchema()。版本管理用 user_version PRAGMA。
 */
// 必须在 import 'node:sqlite' **之前** —— preamble 装 warning listener 过滤 sqlite experimental 噪音
import './_preamble.js';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { logger } from '../observability/logger.js';

const DEFAULT_PATH = './data/tuttikit.db';

let _db: DatabaseSync | null = null;
let _dbPath: string = DEFAULT_PATH;
const _stmtCache = new Map<string, StatementSync>();

/**
 * 测试用：在 import 后切换 db path。必须在 getDB() 之前调用。
 * 生产代码不用；boot 时一切走默认 path。
 */
export function setDBPath(p: string): void {
  if (_db) throw new Error('setDBPath 必须在 getDB() 之前调用');
  _dbPath = p;
}

export function getDB(): DatabaseSync {
  if (_db) return _db;
  const abs = path.resolve(_dbPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  _db = new DatabaseSync(abs);
  // WAL：写并发更好；synchronous=NORMAL：性能权衡，单机够安全
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA synchronous = NORMAL');
  _db.exec('PRAGMA foreign_keys = ON');
  _ensureSchema(_db);
  logger.info({ path: abs }, '[db] sqlite 连接已建立');
  return _db;
}

/**
 * Prepared statement cache —— 同一 SQL 字符串复用 statement，避免每次 prepare 解析。
 * 命中率近 100%（业务里 SQL 是固定的几条），显著加速。
 */
export function prepare(sql: string): StatementSync {
  const db = getDB();
  let stmt = _stmtCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    _stmtCache.set(sql, stmt);
  }
  return stmt;
}

/** 测试关闭 / 优雅退出 */
export function closeDB(): void {
  if (_db) {
    try { _db.close(); } catch {/* ignore */}
    _db = null;
    _stmtCache.clear();
  }
}

/**
 * 在事务里跑一段 sync 函数。任何 throw 都会自动 ROLLBACK。
 * 用法：transaction(() => { stmt1.run(...); stmt2.run(...); })
 */
export function transaction<T>(fn: () => T): T {
  const db = getDB();
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {/* ignore */}
    throw err;
  }
}

/**
 * 表结构 + schema version。
 * 加新表时：在 schema_versions 里加一条 migration，按版本号顺序跑。
 */
const SCHEMA_VERSION = 4;

function _ensureSchema(db: DatabaseSync): void {
  // 用 user_version PRAGMA 跟踪当前 schema 版本
  const cur = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (cur >= SCHEMA_VERSION) return;

  // 增量迁移：每个 v_n → v_{n+1} 独立跑，不重复 v1 的全量建表
  if (cur >= 1 && cur < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_feedback (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        message_id   TEXT NOT NULL,
        rating       INTEGER NOT NULL,
        comment      TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_session ON message_feedback(session_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_msg ON message_feedback(session_id, message_id);
    `);
  }
  if (cur >= 2 && cur < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        kind         TEXT NOT NULL,
        title        TEXT,
        html         TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, updated_at DESC);
    `);
  }
  if (cur >= 3 && cur < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        token        TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER                       -- 可空 = 永不过期
      );
      CREATE INDEX IF NOT EXISTS idx_shares_session ON shares(session_id);
    `);
  }
  if (cur >= 1) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    logger.info({ from: cur, to: SCHEMA_VERSION }, '[db] schema 增量迁移完成');
    return;
  }

  // v1：四张表
  db.exec(`
    -- sessions：messages 整段 json 存 messages 列；archive 也存 json
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT '新对话',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      messages    TEXT NOT NULL DEFAULT '[]',     -- JSON Message[]
      archive     TEXT                            -- JSON archive meta（可空）
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

    -- memory：长期记忆条目
    CREATE TABLE IF NOT EXISTS memory (
      id           TEXT PRIMARY KEY,
      text         TEXT NOT NULL,
      source       TEXT NOT NULL DEFAULT 'unknown',
      tags         TEXT NOT NULL DEFAULT '[]',    -- JSON string[]
      vec          TEXT,                          -- JSON number[]，可空（未 backfill 的老数据）
      vec_model    TEXT,                          -- embedding provider 名（mock / openai 等）
      created_at   INTEGER NOT NULL               -- ms timestamp
    );
    CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created_at DESC);

    -- memory_fts：FTS5 关键词全文索引，content 同步触发器维护
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      text,
      content=memory,
      content_rowid=rowid,
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
    END;

    -- approvals：待审批 / 进行中的 pending（P2 持久化）
    -- 进程 crash 重启后，boot 时 reject 所有 stale pending
    CREATE TABLE IF NOT EXISTS approvals (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      input         TEXT NOT NULL,                -- JSON
      rule_name     TEXT NOT NULL,
      reason        TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      timeout_ms    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id);

    -- message_feedback：用户对 assistant 消息的 👍/👎（W1.1 Y7）
    CREATE TABLE IF NOT EXISTS message_feedback (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      message_id   TEXT NOT NULL,
      rating       INTEGER NOT NULL,        -- 1 = 👍, -1 = 👎
      comment      TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_session ON message_feedback(session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_msg ON message_feedback(session_id, message_id);

    -- artifacts：LLM 生成的可渲染 HTML/SVG 片段（v3，Claude Artifacts 风格）
    CREATE TABLE IF NOT EXISTS artifacts (
      id           TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      kind         TEXT NOT NULL,                  -- 'html' | 'svg' | 'react'
      title        TEXT,
      html         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, updated_at DESC);

    -- shares：可分享只读对话链接（v4）
    CREATE TABLE IF NOT EXISTS shares (
      token        TEXT PRIMARY KEY,
      session_id   TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_shares_session ON shares(session_id);
  `);

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  logger.info({ version: SCHEMA_VERSION }, '[db] schema 初始化完成');
}
