/**
 * MCP 翻译：把每个 MCP server 的 tool descriptions 翻成中文，落盘。
 *   - tool name 不翻（程序调用要用）
 *   - 落盘到 data/mcp-zh/<server>.zh.json
 *   - hash 校验：tools 列表变了（新加 / 改 description）→ 自动 invalidate
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLLM } from '../llm/index.js';
import { logger } from '../observability/logger.js';
import type { LLMLike } from '../types.js';

export type McpLang = 'zh' | 'en';

const MCP_TRANSLATIONS_DIR = path.resolve('./data/mcp-zh');

let translatorLLM: LLMLike | null = null;
function getTranslator(): LLMLike {
  if (!translatorLLM) translatorLLM = createLLM(process.env.TRANSLATOR_PROVIDER);
  return translatorLLM;
}

function shortHash(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function mcpTranslationPath(serverName: string, lang: McpLang): string {
  return path.join(MCP_TRANSLATIONS_DIR, `${sanitize(serverName)}.${lang}.json`);
}

export interface McpTranslation {
  server: string;
  lang: McpLang;
  /** sourceHash = hash(JSON of input tools)，原 tools 变了自动失效 */
  sourceHash: string;
  savedAt: string;
  /** 中文显示名：原 tool name → "短中文名"（4-12 字）— 列表 用 */
  displayNames: Record<string, string>;
  /** 翻译后的 description：原 tool name → "中文描述" */
  descriptions: Record<string, string>;
  /** 文件绝对路径 */
  path?: string;
}

export interface ToolForTranslate {
  /** mcp__<server>__<toolName>，但翻译时只看后段 */
  fullName: string;
  /** 去掉 mcp__server__ 前缀的纯 tool name */
  shortName: string;
  description?: string;
}

/** 把 fullName 里的纯 tool name 拆出来 */
export function shortToolName(fullName: string, serverName: string): string {
  const prefix = `mcp__${serverName}__`;
  return fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName;
}

export async function readMcpTranslation(
  serverName: string,
  lang: McpLang,
  currentSourceHash: string,
): Promise<McpTranslation | null> {
  const p = mcpTranslationPath(serverName, lang);
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as McpTranslation;
    if (parsed.lang !== lang) return null;
    if (parsed.sourceHash !== currentSourceHash) return null;
    return { ...parsed, path: p };
  } catch {
    return null;
  }
}

export async function writeMcpTranslation(t: McpTranslation): Promise<string> {
  await fs.mkdir(MCP_TRANSLATIONS_DIR, { recursive: true });
  const p = mcpTranslationPath(t.server, t.lang);
  await fs.writeFile(p, JSON.stringify(t, null, 2), 'utf-8');
  return p;
}

/**
 * 翻译一个 MCP server 的 tool descriptions + 生成中文显示名。
 *   - 单次 LLM 调用，要求 strict JSON 输出 { displayNames, descriptions }
 *   - mock provider 时直接返回空对象（不浪费 token）
 */
export async function translateMcpTools(args: {
  serverName: string;
  tools: ToolForTranslate[];
  lang: McpLang;
}): Promise<{ displayNames: Record<string, string>; descriptions: Record<string, string> }> {
  const llm = getTranslator();
  if (llm.name === 'mock' || args.tools.length === 0) {
    return { displayNames: {}, descriptions: {} };
  }
  const target = args.lang === 'zh' ? '中文' : 'English';
  const system = `你是翻译助手。下面是一个 MCP server 的 tools 列表，每个 tool 有 name 和 description。

为每个 tool 输出两个字段：
  1. displayName：4-12 个字的简短${target}显示名（让人一眼看懂干啥）
  2. description：把原 description 翻译成简洁的${target}

**严格要求**：
- 只输出 JSON 对象，**不要** markdown 包裹、不要前言
- 格式：{ "displayNames": { "<toolName>": "..." }, "descriptions": { "<toolName>": "..." } }
- 保留所有原 tool name（key 不变）

示例输入（不要复述）：
[{ "name": "fetch_url", "description": "Fetch content of any URL as HTML/markdown/text" }]

示例输出：
{
  "displayNames": { "fetch_url": "抓取网页" },
  "descriptions": { "fetch_url": "拉取任意 URL 的内容（HTML / Markdown / 文本）" }
}`;

  const userContent = args.tools
    .map((t) => `- name: ${t.shortName}\n  description: ${t.description ?? '(无)'}`)
    .join('\n');

  try {
    const res = await llm.chat({
      system,
      messages: [{ role: 'user', content: userContent }],
      temperature: 0,
      maxTokens: 4096,
    });
    const text = (res.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(text) as {
      displayNames?: Record<string, string>;
      descriptions?: Record<string, string>;
    };
    const allowed = new Set(args.tools.map((t) => t.shortName));
    const dn: Record<string, string> = {};
    const ds: Record<string, string> = {};
    for (const k of allowed) {
      const dnv = parsed.displayNames?.[k];
      const dsv = parsed.descriptions?.[k];
      if (typeof dnv === 'string' && dnv.trim()) dn[k] = dnv.trim();
      if (typeof dsv === 'string' && dsv.trim()) ds[k] = dsv.trim();
    }
    return { displayNames: dn, descriptions: ds };
  } catch (err) {
    logger.warn({ err, server: args.serverName }, '[mcp-translator] 翻译失败');
    return { displayNames: {}, descriptions: {} };
  }
}

/** 给一组 tools 算稳定 hash，作为缓存失效信号 */
export function hashOfTools(tools: ToolForTranslate[]): string {
  // sort by shortName 让顺序不影响 hash
  const payload = [...tools]
    .map((t) => ({ n: t.shortName, d: t.description ?? '' }))
    .sort((a, b) => a.n.localeCompare(b.n));
  return shortHash(JSON.stringify(payload));
}
