import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import matter from 'gray-matter';
import { logger } from '../observability/logger.js';
import type { Skill, SkillMeta } from './types.js';

/**
 * SkillsLoader —— 启动期扫描两个目录：
 *   <project>/.claude/skills/<name>/SKILL.md
 *   ~/.claude/skills/<name>/SKILL.md
 * 同名 skill 项目级覆盖全局；解析失败跳过 + warn。
 */
export class SkillsLoader {
  private skills: Map<string, Skill> = new Map();
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    const dirs: Array<{ dir: string; scope: 'user' | 'project' }> = [
      { dir: path.join(os.homedir(), '.claude/skills'), scope: 'user' },
    ];
    // 项目级：从 cwd 向上找最近的 .claude/skills（兼容 monorepo 子目录运行）
    const projectDir = findUpwards('.claude/skills');
    if (projectDir) dirs.push({ dir: projectDir, scope: 'project' });

    for (const { dir, scope } of dirs) {
      if (!fs.existsSync(dir)) continue;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = path.join(dir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillPath)) continue;
        const parsed = this.parseSkill(skillPath, entry.name, scope);
        if (parsed) this.skills.set(parsed.name, parsed);   // project 覆盖 user
      }
    }
    logger.info({ count: this.skills.size, names: [...this.skills.keys()] }, '[skills] 加载完成');
  }

  private parseSkill(filePath: string, dirName: string, scope: 'user' | 'project'): Skill | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const { data, content } = matter(raw);
      const name = String(data.name || dirName).trim();
      const description = String(data.description || '').trim();
      if (!name) {
        logger.warn({ filePath }, '[skills] frontmatter 缺 name，跳过');
        return null;
      }
      if (!description) {
        logger.warn({ filePath, name }, '[skills] frontmatter 缺 description，跳过');
        return null;
      }
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
