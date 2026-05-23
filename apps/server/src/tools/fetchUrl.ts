/**
 * fetch_and_summarize（W3.1 R3 升级版）：抓 URL → 剥 HTML → cheap LLM 摘要。
 *
 * 用法（LLM 视角）：webSearch 拿到 top-K 结果只有 snippet 不全，需要深度看时调这个。
 *
 * 流程：
 *   1. node fetch（含 5s 超时 + 跟随重定向 + UA）
 *   2. 简单 HTML→text 提取（去 script/style/nav，保留 article/main/p 文本）
 *   3. cheap LLM 摘要（用 routing low-tier）；不传 prompt 则用"按 query 提炼要点"默认
 *   4. 自动 register 到 ctx.citations 让 LLM 后续能 [ref:N]
 *
 * 安全：
 *   - 不接受 file:// / localhost / 内网 IP（防 SSRF）
 *   - 内容上限 500KB（截断防内存爆）
 */
import { z } from 'zod';
import type { ToolSpec, ToolCtx } from '../types.js';
import { createLLM } from '../llm/index.js';
import { logger } from '../observability/logger.js';

const Input = z.object({
  url: z.string().url('必须是合法 URL'),
  prompt: z.string().max(500).optional().describe('摘要焦点；不传则按 LLM 默认按"全文要点"提炼'),
  timeoutMs: z.number().int().min(500).max(15_000).optional(),
});

const FORBIDDEN_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
const MAX_BYTES = 500_000;

function isAllowedUrl(u: string): { ok: boolean; reason?: string } {
  let url: URL;
  try { url = new URL(u); } catch { return { ok: false, reason: 'invalid URL' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, reason: '只接受 http/https' };
  if (FORBIDDEN_HOSTS.includes(url.hostname.toLowerCase())) return { ok: false, reason: '不接受 localhost / loopback' };
  // 简单内网 IP 防 SSRF（不完整但拦最常见 10.* / 192.168.* / 172.16-31.*）
  if (/^10\./.test(url.hostname)) return { ok: false, reason: '不接受 10.* 内网 IP' };
  if (/^192\.168\./.test(url.hostname)) return { ok: false, reason: '不接受 192.168.* 内网 IP' };
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(url.hostname)) return { ok: false, reason: '不接受 172.16-31.* 内网 IP' };
  return { ok: true };
}

/** 简单 HTML → 纯文本：去 script/style/svg/nav/header/footer，保留正文 */
function stripHtml(html: string): string {
  let text = html;
  // 去掉成对的 script/style/svg/nav/header/footer/aside 整段
  text = text.replace(/<(script|style|svg|nav|header|footer|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // 去掉所有 HTML tag
  text = text.replace(/<[^>]+>/g, ' ');
  // HTML entity 简化解码（&amp; / &lt; / &gt; / &quot; / &nbsp;）
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  // 折叠空白
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

export const fetchAndSummarizeTool: ToolSpec<
  z.infer<typeof Input>,
  { url: string; title?: string; summary: string; rawBytes: number; truncated: boolean; ref?: number }
> = {
  name: 'fetch_and_summarize',
  description:
    '抓取一个 URL 的内容并用 LLM 摘要。给 webSearch 结果中你最感兴趣的一条做深度阅读。\n' +
    '不接受 file:// / localhost / 内网 IP（防 SSRF）。内容超 500KB 截断。\n' +
    '摘要会自动加引用（如果对话开了 citation）。',
  parameters: {
    type: 'object',
    properties: {
      url:       { type: 'string', description: 'http/https URL' },
      prompt:    { type: 'string', description: '摘要焦点（可选）' },
      timeoutMs: { type: 'integer', description: 'fetch 超时（ms，默认 8000）' },
    },
    required: ['url'],
  },
  inputSchema: Input,
  allowedAgents: ['conductor', 'researcher', 'coder'],
  async handler({ url, prompt, timeoutMs }, ctx: ToolCtx = {}) {
    const guard = isAllowedUrl(url);
    if (!guard.ok) throw new Error(`URL 不允许：${guard.reason}`);

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs ?? 8000);
    let html = '';
    let title: string | undefined;
    let truncated = false;
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'TuttiKit/1.0 fetch_and_summarize tool' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error('response body unreadable');
      const decoder = new TextDecoder('utf-8');
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) { truncated = true; break; }
        html += decoder.decode(value, { stream: true });
      }
      // 提 title
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) title = titleMatch[1].trim().slice(0, 200);
    } catch (err) {
      throw new Error(`fetch 失败：${(err as Error).message}`);
    } finally {
      clearTimeout(t);
    }

    const text = stripHtml(html);
    if (text.length === 0) {
      return { url, title, summary: '(页面无可提取正文)', rawBytes: html.length, truncated };
    }

    // cheap LLM 摘要（用 ROUTER_LOW provider 或主 provider 降级 mock）
    const summarizer = createLLM(process.env.ROUTER_LOW || undefined);
    let summary: string;
    if (summarizer.name === 'mock') {
      summary = `[mock 摘要] 抓到 ${text.length} 字符；前 200：${text.slice(0, 200)}`;
    } else {
      try {
        const res = await summarizer.chat({
          system: '把下面网页正文压缩成 5-10 句中文要点，保留事实和数字，去掉广告/导航/无关链接。直接输出要点，不要前言。',
          messages: [{
            role: 'user',
            content: (prompt ? `重点关注：${prompt}\n\n网页正文：\n` : '网页正文：\n') + text.slice(0, 30_000),
          }],
          temperature: 0,
          maxTokens: 600,
        });
        summary = (res.content || '').trim() || '(摘要为空)';
      } catch (err) {
        logger.warn({ err: (err as Error).message, url }, '[fetch_and_summarize] LLM 失败');
        summary = `(摘要失败：${(err as Error).message})；原文长度 ${text.length} 字符`;
      }
    }

    const ref = ctx.citations?.register({
      title: title ?? url, url, snippet: summary, kind: 'web',
    });
    return { url, title, summary, rawBytes: html.length, truncated, ref };
  },
};
