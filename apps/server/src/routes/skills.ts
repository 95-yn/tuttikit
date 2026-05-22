import type { Express } from 'express';
import { config } from '../config.js';
import { skillsLoader } from '../skills/index.js';
import {
  translateSkillField, hashOf, readSavedTranslation, writeTranslation, translationFilePath,
  translateNamesBatch, readNamesIndex, writeNamesIndex,
  type SkillLang,
} from '../skills/translator.js';

/**
 * Skills 状态查询 + 管理 + 翻译。
 *   GET  /skills
 *   GET  /skills/:name
 *   POST /skills/reload
 *   GET  /skills/:name/translation
 *   POST /skills/:name/translate
 *   GET  /skills/translated-names
 *   POST /skills/translate-names
 */
export function register(app: Express): void {
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
}
