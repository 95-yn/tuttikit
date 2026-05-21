/**
 * Skill 翻译：on-demand 翻译 description + body。
 *   - 内存 cache 跨进程内调用（命中秒返）
 *   - **磁盘落盘** 到 data/skills-zh/<sanitized-name>.md，用户可直接打开查看
 *   - 内容 hash 变 → 自动 invalidate 重译
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLLM } from '../llm/index.js';
import { logger } from '../observability/logger.js';
import type { LLMLike } from '../types.js';

/** 落盘根目录：相对 server cwd */
const TRANSLATIONS_DIR = path.resolve('./data/skills-zh');

export type SkillLang = 'zh' | 'en';

interface CacheEntry {
  result: string;
  storedAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 7 * 24 * 60 * 60 * 1000;        // 7 天

let translatorLLM: LLMLike | null = null;
function getTranslator(): LLMLike {
  if (!translatorLLM) {
    // 优先用 cheap provider（haiku / deepseek-chat）；不强制开特殊配置，回落到默认 provider
    translatorLLM = createLLM(process.env.TRANSLATOR_PROVIDER);
  }
  return translatorLLM;
}

function shortHash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
}

function key(name: string, lang: SkillLang, kind: 'desc' | 'body', source: string): string {
  return `${name}::${lang}::${kind}::${shortHash(source)}`;
}

function detectLang(text: string): SkillLang {
  // 简单启发：含 CJK 字符 → zh；否则 en
  return /[一-龥぀-ヿ㐀-䶿]/.test(text) ? 'zh' : 'en';
}

async function callTranslate(text: string, targetLang: SkillLang, kind: 'desc' | 'body'): Promise<string> {
  const llm = getTranslator();
  if (llm.name === 'mock') return text;        // mock 不会翻，原样返回

  const target = targetLang === 'zh' ? '简体中文' : 'English';
  const system = kind === 'desc'
    ? `把下面这段 Claude Skill 的描述翻译成${target}。保持简洁，直接输出译文，不要前言、不要 markdown 包裹。`
    : `把下面这段 Claude Skill 的 markdown 正文翻译成${target}。要求：
- **保留** 所有 markdown 标记（# / * / \`\`\` / [link](url) / 表格等），仅翻译可见文字。
- **保留** 所有代码块（\`\`\` ... \`\`\`）的内容不翻译，包括代码注释中的英文。
- **保留** frontmatter（--- name: ... description: --- 这段）原样不动。
- **保留** 所有 \\\`inline code\\\` 不翻译。
- 不要前言或后记，直接输出译文。`;

  try {
    const res = await llm.chat({
      system,
      messages: [{ role: 'user', content: text }],
      temperature: 0,
      maxTokens: kind === 'desc' ? 256 : 4096,
    });
    return (res.content || '').trim() || text;
  } catch (err) {
    logger.warn({ err, target, kind }, '[translator] 翻译失败，回退原文');
    return text;
  }
}

export async function translateSkillField(args: {
  name: string;
  text: string;
  targetLang: SkillLang;
  kind: 'desc' | 'body';
}): Promise<{ text: string; cached: boolean; sameLang: boolean }> {
  // 已经是目标语言 → 不翻译，直接原文
  if (detectLang(args.text) === args.targetLang) {
    return { text: args.text, cached: false, sameLang: true };
  }
  const k = key(args.name, args.targetLang, args.kind, args.text);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.storedAt < TTL_MS) {
    return { text: hit.result, cached: true, sameLang: false };
  }
  const out = await callTranslate(args.text, args.targetLang, args.kind);
  cache.set(k, { result: out, storedAt: Date.now() });
  return { text: out, cached: false, sameLang: false };
}

/** 测试 / 管理用 */
export function _clearTranslationCache(): void { cache.clear(); }
export function _cacheStats(): { size: number } { return { size: cache.size }; }

/** 把 skill name 转成安全的文件名：冒号/斜杠都换成下划线 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function translationFilePath(name: string, lang: SkillLang): string {
  return path.join(TRANSLATIONS_DIR, `${sanitizeFilename(name)}.${lang}.md`);
}

export interface SavedTranslation {
  name: string;
  lang: SkillLang;
  /** 翻译后的 description */
  description: string;
  /** 翻译后的 body */
  body: string;
  /** 用于 hash 校验：原文的 sha8（变了说明原 skill 改过，落盘的译文过期） */
  sourceHashDesc: string;
  sourceHashBody: string;
  /** 翻译时使用的 provider */
  provider: string;
  savedAt: string;
  /** 文件绝对路径 */
  path: string;
}

/**
 * 读已落盘的翻译（如果存在且 hash 仍匹配）。
 * 用 frontmatter 存元信息，下面跟着 markdown 正文。
 */
export async function readSavedTranslation(
  name: string,
  lang: SkillLang,
  currentDescHash: string,
  currentBodyHash: string,
): Promise<SavedTranslation | null> {
  const filePath = translationFilePath(name, lang);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;
    const { meta, body } = parsed;
    if (meta.sourceHashDesc !== currentDescHash || meta.sourceHashBody !== currentBodyHash) {
      // 原文变了，落盘的过期
      return null;
    }
    return {
      name,
      lang,
      description: String(meta.description || ''),
      body,
      sourceHashDesc: String(meta.sourceHashDesc || ''),
      sourceHashBody: String(meta.sourceHashBody || ''),
      provider: String(meta.provider || ''),
      savedAt: String(meta.savedAt || ''),
      path: filePath,
    };
  } catch {
    return null;
  }
}

/** 写落盘 + 同时刷新内存 cache */
export async function writeTranslation(args: {
  name: string;
  lang: SkillLang;
  description: string;
  body: string;
  origDesc: string;
  origBody: string;
  provider: string;
}): Promise<string> {
  await fs.mkdir(TRANSLATIONS_DIR, { recursive: true });
  const filePath = translationFilePath(args.name, args.lang);
  const sourceHashDesc = shortHash(args.origDesc);
  const sourceHashBody = shortHash(args.origBody);
  const yaml =
    `---\n` +
    `name: ${args.name}\n` +
    `lang: ${args.lang}\n` +
    `description: ${JSON.stringify(args.description)}\n` +
    `sourceHashDesc: ${sourceHashDesc}\n` +
    `sourceHashBody: ${sourceHashBody}\n` +
    `provider: ${args.provider}\n` +
    `savedAt: ${new Date().toISOString()}\n` +
    `---\n`;
  await fs.writeFile(filePath, yaml + args.body, 'utf-8');
  // 内存 cache 也填上，命中下次 list 翻译
  cache.set(key(args.name, args.lang, 'desc', args.origDesc), { result: args.description, storedAt: Date.now() });
  cache.set(key(args.name, args.lang, 'body', args.origBody), { result: args.body, storedAt: Date.now() });
  return filePath;
}

/** 给外部用：方便算 hash */
export function hashOf(text: string): string {
  return shortHash(text);
}

/** 暴露：让 server 路由也能用 */
export const SKILL_TRANSLATIONS_DIR = TRANSLATIONS_DIR;

/** skill name → 中文显示名的批量缓存（落盘 data/skills-zh/_names.<lang>.json） */
export function namesIndexPath(lang: SkillLang): string {
  return path.join(TRANSLATIONS_DIR, `_names.${lang}.json`);
}

export interface NamesIndex {
  lang: SkillLang;
  savedAt: string;
  /** name → 译名（display name）；不在的表示没翻过 */
  names: Record<string, string>;
}

export async function readNamesIndex(lang: SkillLang): Promise<NamesIndex | null> {
  try {
    const raw = await fs.readFile(namesIndexPath(lang), 'utf-8');
    const parsed = JSON.parse(raw) as NamesIndex;
    if (parsed.lang !== lang) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeNamesIndex(idx: NamesIndex): Promise<string> {
  await fs.mkdir(TRANSLATIONS_DIR, { recursive: true });
  const p = namesIndexPath(idx.lang);
  await fs.writeFile(p, JSON.stringify(idx, null, 2), 'utf-8');
  return p;
}

/**
 * 给一批 skill name 翻成中文「显示名」。注意：不是字面翻译 source-id，
 * 而是结合 description 总结一个简短中文名（让人一眼看懂这个 skill 干啥的）。
 * 输出严格 JSON：{ "<原 name>": "<中文显示名>", ... }
 */
export async function translateNamesBatch(
  items: Array<{ name: string; description: string }>,
  lang: SkillLang,
): Promise<Record<string, string>> {
  if (items.length === 0) return {};
  const llm = getTranslator();
  if (llm.name === 'mock') {
    return Object.fromEntries(items.map((it) => [it.name, it.name]));
  }
  const target = lang === 'zh' ? '中文' : 'English';
  const system = `你是翻译助手。给你一批 Claude Skill 的「英文 id + description」，
为每个 skill 生成一个简短的 ${target} 显示名（4-12 个字，能让人一眼看懂这个 skill 干什么）。
要求：
- **保留** id 原文不变（id 是程序调用用的）
- 显示名要**简短具体**，不要"XX助手"、"XX工具"这类废话词
- 输出**严格 JSON 对象**：{ "<id>": "<显示名>", ... }，不要 markdown 包裹，不要前言

例：
{
  "test-driven-development": "测试驱动开发",
  "writing-skills": "写作 Skill 指南",
  "claude-plugins-official:frontend-design:frontend-design": "前端设计规范"
}`;

  const userContent = items.map((it) => `- id: ${it.name}\n  description: ${it.description}`).join('\n');

  try {
    const res = await llm.chat({
      system,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0,
      // 50 个 ids 大概 1-2k tokens；给充足 margin
      maxTokens: 4096,
    });
    const text = (res.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(text) as Record<string, string>;
    // 过滤：只保留 items 里有的 id（防 LLM 加新键），值必须是字符串
    const out: Record<string, string> = {};
    for (const it of items) {
      const v = parsed[it.name];
      if (typeof v === 'string' && v.trim().length > 0) out[it.name] = v.trim();
    }
    return out;
  } catch (err) {
    logger.warn({ err }, '[translator] 批量翻译 names 失败');
    return {};
  }
}

// 极小 YAML frontmatter 解析（够当前用：只读简单 key: value 行）
function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } | null {
  if (!raw.startsWith('---\n')) return null;
  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) return null;
  const head = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const meta: Record<string, unknown> = {};
  for (const line of head.split('\n')) {
    const m = line.match(/^([a-zA-Z_][\w]*):\s*(.*)$/);
    if (!m) continue;
    let val: unknown = m[2];
    // JSON-quoted 字符串（description 写时用了 JSON.stringify）
    if (typeof val === 'string' && val.startsWith('"')) {
      try { val = JSON.parse(val); } catch { /* keep raw */ }
    }
    meta[m[1]] = val;
  }
  return { meta, body };
}
