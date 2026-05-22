import type { Express } from 'express';
import { longTermMemory } from '../memory/longTerm.js';

/**
 * 长期记忆查询。
 *   GET /memory
 *   GET /memory/search?q=&k=
 */
export function register(app: Express): void {
  app.get('/memory', (_req, res) => res.json(longTermMemory.all()));
  app.get('/memory/search', (req, res) => {
    res.json(longTermMemory.search(String(req.query.q || ''), Number(req.query.k || 5)));
  });
}
