import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';
import { logger } from '../observability/logger.js';
import type { Skill, SkillMeta } from './types.js';

export type SkillScope = 'user' | 'project' | 'plugin';

/**
 * SkillsLoader —— 启动期扫描多个来源：
 *   1. 项目级:    <project>/.claude/skills/<name>/SKILL.md
 *   2. 用户级:    ~/.claude/skills/<name>/SKILL.md（含软链；很多 superpowers 用户在这里链到外部仓库）
 *   3. Plugin:    ~/.claude/plugins/marketplaces/<m>/{plugins,external_plugins}/<p>/skills/<skill>/SKILL.md
 *                 （Claude Code `/plugin` 命令安装到这里）
 * 同名覆盖优先级：project > user > plugin。
 *
 * 软链兼容：dirent.isDirectory() 在软链上返回 false，需要 fs.statSync follow 一下。
 */
export class SkillsLoader {
  private skills: Map<string, Skill> = new Map();
  private initialized = false;

  /** 强制重新扫盘（用于 web UI 改完 SKILL.md 后热更新） */
  reload(): void {
    this.skills.clear();
    this.initialized = false;
    this.init();
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // 反向遍历：plugin 先加 → user 覆盖 → project 最后覆盖
    this._scanPluginSkills();
    this._scanFlatDir(path.join(os.homedir(), '.claude/skills'), 'user');
    const projectDir = findUpwards('.claude/skills');
    if (projectDir) this._scanFlatDir(projectDir, 'project');

    logger.info(
      { count: this.skills.size, names: [...this.skills.keys()] },
      '[skills] 加载完成',
    );
  }

  /**
   * 扫平铺目录 `<dir>/<skillName>/SKILL.md`。entry 可以是目录、也可以是软链到目录。
   */
  private _scanFlatDir(dir: string, scope: SkillScope): void {
    if (!fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      // dirent.isDirectory() 在软链上是 false → 跟随软链一次再判
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        try { isDir = fs.statSync(path.join(dir, entry.name)).isDirectory(); }
        catch { isDir = false; }
      }
      if (!isDir) continue;
      const skillPath = path.join(dir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;
      const parsed = this.parseSkill(skillPath, entry.name, scope);
      if (parsed) this.skills.set(parsed.name, parsed);
    }
  }

  /**
   * 扫 Claude Code plugin 装的 skill：
   *   ~/.claude/plugins/marketplaces/<m>/{plugins,external_plugins}/<plugin>/skills/<skill>/SKILL.md
   * 找不到目录直接 return（用户没装过任何 plugin）。
   */
  private _scanPluginSkills(): void {
    const root = path.join(os.homedir(), '.claude/plugins/marketplaces');
    if (!fs.existsSync(root)) return;
    let marketplaces: fs.Dirent[];
    try { marketplaces = fs.readdirSync(root, { withFileTypes: true }); }
    catch { return; }
    for (const m of marketplaces) {
      if (!isLikeDir(root, m)) continue;
      for (const sub of ['plugins', 'external_plugins']) {
        const pluginsDir = path.join(root, m.name, sub);
        if (!fs.existsSync(pluginsDir)) continue;
        let plugins: fs.Dirent[];
        try { plugins = fs.readdirSync(pluginsDir, { withFileTypes: true }); }
        catch { continue; }
        for (const p of plugins) {
          if (!isLikeDir(pluginsDir, p)) continue;
          const skillsDir = path.join(pluginsDir, p.name, 'skills');
          if (!fs.existsSync(skillsDir)) continue;
          let skills: fs.Dirent[];
          try { skills = fs.readdirSync(skillsDir, { withFileTypes: true }); }
          catch { continue; }
          for (const s of skills) {
            if (!isLikeDir(skillsDir, s)) continue;
            const skillPath = path.join(skillsDir, s.name, 'SKILL.md');
            if (!fs.existsSync(skillPath)) continue;
            // 加 plugin 前缀避免和用户级同名 skill 冲突
            const prefixed = `${m.name}:${p.name}:${s.name}`;
            const parsed = this.parseSkill(skillPath, s.name, 'plugin', prefixed);
            if (parsed) this.skills.set(parsed.name, parsed);
          }
        }
      }
    }
  }

  private parseSkill(
    filePath: string,
    dirName: string,
    scope: SkillScope,
    /** plugin 来源会用 marketplace:plugin:skill 形式做 key，避免和 user-level 同名冲突 */
    overrideName?: string,
  ): Skill | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { data, content } = matter(raw);
      const baseName = String(data.name || dirName).trim();
      const description = String(data.description || '').trim();
      if (!baseName) {
        logger.warn({ filePath }, '[skills] frontmatter 缺 name，跳过');
        return null;
      }
      if (!description) {
        logger.warn({ filePath, name: baseName }, '[skills] frontmatter 缺 description，跳过');
        return null;
      }
      const name = overrideName || baseName;
      return { name, description, body: content.trim(), source: filePath, scope };
    } catch (err) {
      logger.warn({ err, filePath }, '[skills] 解析失败，跳过');
      return null;
    }
  }

  list(): SkillMeta[] {
    this.init();
    return [...this.skills.values()].map(({ body: _body, ...meta }) => meta);
  }

  get(name: string): Skill | null {
    this.init();
    return this.skills.get(name) || null;
  }

  /** 简单关键词匹配：description + name 都打分；返回 top-k */
  search(query: string, k = 5): SkillMeta[] {
    this.init();
    const q = query.toLowerCase().trim();
    if (!q) return this.list().slice(0, k);
    const terms = q.split(/\s+/).filter((t) => t.length > 0);
    const scored = [...this.skills.values()].map((skill) => {
      const haystack = `${skill.name} ${skill.description}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (haystack.includes(t)) score += 2;
        if (skill.name.toLowerCase().includes(t)) score += 3;
      }
      return { skill, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ skill: { body: _body, ...meta } }) => meta);
  }
}

export const skillsLoader = new SkillsLoader();

/** dirent 是真目录、或软链跟随后是目录。文件系统 stat 失败一律视为 not-dir */
function isLikeDir(parent: string, ent: fs.Dirent): boolean {
  if (ent.isDirectory()) return true;
  if (!ent.isSymbolicLink()) return false;
  try { return fs.statSync(path.join(parent, ent.name)).isDirectory(); }
  catch { return false; }
}

/** 从 cwd 一路向上找最近的指定相对路径，找到返回绝对路径，没有返回 null。 */
function findUpwards(rel: string): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;     // 到文件系统根
    dir = parent;
  }
}
