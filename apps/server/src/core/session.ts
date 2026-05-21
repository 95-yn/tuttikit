import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { logger } from '../observability/logger.js';
import type { Message, Session, SessionSummary } from '../types.js';

const SESSIONS_DIR = path.resolve('./data/sessions');

/**
 * 一个 session = 一段持续对话，落盘到 data/sessions/<id>.json。
 */
export class SessionManager {
  dir: string;

  constructor({ dir = SESSIONS_DIR }: { dir?: string } = {}) {
    this.dir = dir;
    fsSync.mkdirSync(this.dir, { recursive: true });
  }

  private _file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async create({ title = '新对话' }: { title?: string } = {}): Promise<Session> {
    const session: Session = {
      id: nanoid(10),
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    await this._save(session);
    return session;
  }

  async get(id: string): Promise<Session | null> {
    try {
      const raw = await fs.readFile(this._file(id), 'utf-8');
      return JSON.parse(raw) as Session;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async list(): Promise<SessionSummary[]> {
    const files = await fs.readdir(this.dir).catch(() => [] as string[]);
    const sessions: SessionSummary[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(this.dir, f), 'utf-8');
        const s = JSON.parse(raw) as Session;
        sessions.push({
          id: s.id,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messages?.length || 0,
        });
      } catch (err) {
        logger.warn({ err, file: f }, 'session 文件损坏，跳过');
      }
    }
    return sessions.sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return tb - ta;
    });
  }

  async appendMessage(id: string, message: Message): Promise<Session> {
    const session = await this.get(id);
    if (!session) throw new Error(`session ${id} 不存在`);
    session.messages.push(message);
    session.updatedAt = new Date().toISOString();
    if (session.title === '新对话' && message.role === 'user' && typeof message.content === 'string') {
      session.title = message.content.slice(0, 30) + (message.content.length > 30 ? '…' : '');
    }
    await this._save(session);
    return session;
  }

  async rename(id: string, title: string): Promise<Session> {
    const session = await this.get(id);
    if (!session) throw new Error(`session ${id} 不存在`);
    session.title = title;
    session.updatedAt = new Date().toISOString();
    await this._save(session);
    return session;
  }

  async delete(id: string): Promise<boolean> {
    try {
      await fs.unlink(this._file(id));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /** 截断会话：删除 index >= fromIndex 的所有消息。用于"重生"/编辑后重发的场景。 */
  async truncateMessages(id: string, fromIndex: number): Promise<Session | null> {
    const session = await this.get(id);
    if (!session) return null;
    if (fromIndex < 0 || fromIndex > session.messages.length) {
      throw new Error(`fromIndex 越界: ${fromIndex} / 共 ${session.messages.length} 条`);
    }
    session.messages = session.messages.slice(0, fromIndex);
    session.updatedAt = new Date().toISOString();
    await this._save(session);
    return session;
  }

  private async _save(session: Session): Promise<void> {
    await fs.writeFile(this._file(session.id), JSON.stringify(session, null, 2));
  }
}

export const sessionManager = new SessionManager();
