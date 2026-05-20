// 与 apps/server/public/app.js 的 renderMarkdown 行为完全一致
// 服务端有 34 个 markdown 断言保证（test-markdown.js），保持字符串级兼容

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!)
  );
}

// 全局自增 + 36 进制 + 4 位随机，跨调用唯一
let _mmdSeq = 0;
export function nextMermaidId(prefix = 'mmd'): string {
  _mmdSeq++;
  return `${prefix}-${_mmdSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function renderMarkdown(text: string): string {
  if (!text) return '';

  const blocks: { lang: string; code: string; closed: boolean }[] = [];
  let body = text;

  // 闭合的 ``` … ```
  body = body.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push({
      lang: (lang || 'text').toLowerCase(),
      code: String(code).replace(/\n$/, ''),
      closed: true,
    });
    return `\x00CB${blocks.length - 1}\x00`;
  });
  // 流式中未闭合的
  const openMatch = body.match(/```(\w+)?\n?([\s\S]*)$/);
  if (openMatch) {
    blocks.push({
      lang: (openMatch[1] || 'text').toLowerCase(),
      code: openMatch[2] || '',
      closed: false,
    });
    body = body.slice(0, openMatch.index) + `\x00CB${blocks.length - 1}\x00`;
  }

  // 简版 inline markdown
  let html = escapeHtml(body);
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );

  html = html.replace(/\x00CB(\d+)\x00/g, (_m, i) => {
    const b = blocks[+i];
    if (b.lang === 'mermaid') {
      if (!b.closed) {
        return (
          `<div class="mermaid mermaid-streaming" data-streaming="1">` +
            `<div class="stream-head"><div class="spinner"></div><span>正在生成流程图源码…</span></div>` +
            `<pre><code class="language-mermaid">${escapeHtml(b.code)}</code></pre>` +
          `</div>`
        );
      }
      const src = encodeURIComponent(b.code);
      return (
        `<div class="mermaid" data-source="${src}">` +
          `<div class="mermaid-loading"><div class="spinner"></div><span>渲染流程图…</span></div>` +
        `</div>`
      );
    }
    return `<pre><code class="language-${b.lang}">${escapeHtml(b.code)}</code></pre>`;
  });

  return html;
}

export function safeDecodeURI(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function prettyJson(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export function compactJsonOneLine(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  } catch { return String(v); }
}

export function fmtTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
