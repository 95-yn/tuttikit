/**
 * 验证前端的 renderMarkdown（实现 in apps/web/src/lib/markdown.ts）：
 *   - mermaid 闭合块 → <div class="mermaid">
 *   - 任意语言代码块 → <pre><code class="language-X">
 *   - 流式中未闭合的 ```mermaid → <pre><code> 占位（避免半图渲染失败）
 *   - 特殊字符正确 escape
 */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

// 直接 copy 自 apps/web/src/lib/markdown.ts（保持同步）
function renderMarkdown(text) {
  if (!text) return '';
  const blocks = [];
  let body = text;

  body = body.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ lang: (lang || 'text').toLowerCase(), code: code.replace(/\n$/, ''), closed: true });
    return `\x00CB${blocks.length - 1}\x00`;
  });
  const openMatch = body.match(/```(\w+)?\n?([\s\S]*)$/);
  if (openMatch) {
    blocks.push({ lang: (openMatch[1] || 'text').toLowerCase(), code: openMatch[2] || '', closed: false });
    body = body.slice(0, openMatch.index) + `\x00CB${blocks.length - 1}\x00`;
  }

  let html = escapeHtml(body);
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  html = html.replace(/\x00CB(\d+)\x00/g, (_, i) => {
    const b = blocks[+i];
    if (b.lang === 'mermaid') {
      if (!b.closed) {
        return `<div class="mermaid mermaid-streaming" data-streaming="1">` +
                 `<div class="stream-head"><div class="spinner"></div><span>正在生成流程图源码…</span></div>` +
                 `<pre><code class="language-mermaid">${escapeHtml(b.code)}</code></pre>` +
               `</div>`;
      }
      const src = encodeURIComponent(b.code);
      return `<div class="mermaid" data-source="${src}">` +
               `<div class="mermaid-loading"><div class="spinner"></div><span>渲染流程图…</span></div>` +
             `</div>`;
    }
    return `<pre><code class="language-${b.lang}">${escapeHtml(b.code)}</code></pre>`;
  });

  return html;
}

function assert(cond, msg) {
  if (!cond) { console.error('✗', msg); process.exit(1); }
  console.log('✓', msg);
}

// 1) 完整 mermaid 块 → 直接产出 loading 占位 + data-source（待 enhanceMermaid 拿源码渲染）
{
  const h = renderMarkdown('前文\n```mermaid\nflowchart TD\n  A --> B\n```\n后文');
  assert(h.includes('<div class="mermaid" data-source="'), 'mermaid 闭合 → <div class=mermaid data-source>');
  assert(h.includes('mermaid-loading'), 'mermaid 闭合 → 立即显示 loading');
  assert(h.includes(encodeURIComponent('flowchart TD')), 'mermaid 源码经 URI 编码塞进 data-source');
  assert(!h.includes('mermaid-streaming'), 'mermaid 闭合时不是 streaming');
}

// 2) 完整 js 代码块（有语言）
{
  const h = renderMarkdown('```js\nconst x = 1;\n```');
  assert(h.includes('<pre><code class="language-js">'), 'js 块产生 language-js 类');
  assert(h.includes('const x = 1;'), 'js 内容保留');
}

// 3) 完整 python 代码块
{
  const h = renderMarkdown('```python\ndef foo():\n  pass\n```');
  assert(h.includes('<pre><code class="language-python">'), 'python 块产生 language-python 类');
}

// 4) 流式：未闭合 mermaid → "正在生成流程图源码…" head + 源码 pre，固定高度容器
{
  const h = renderMarkdown('开头\n```mermaid\nflowchart TD\n  A --> B');
  assert(h.includes('mermaid-streaming'), '未闭合 mermaid → mermaid-streaming 状态');
  assert(h.includes('data-streaming="1"'), '未闭合 mermaid → 加 data-streaming 阻止 enhance');
  assert(h.includes('<pre><code class="language-mermaid">'), '未闭合 mermaid：源码用 pre 显示');
  assert(h.includes('flowchart TD'), '未闭合 mermaid：源码内容保留');
  assert(h.includes('正在生成流程图源码'), '未闭合 mermaid：streaming head 文案');
}

// 5) 流式：未闭合普通代码块 → 也是 <pre> 占位
{
  const h = renderMarkdown('正在写 ```js\nconst');
  assert(h.includes('<pre><code class="language-js">'), '未闭合 js 也用 pre 占位');
  assert(h.includes('const'), '未闭合代码内容保留');
}

// 6) 特殊字符在 mermaid 源码里正确保留（URI 编码进 data-source）
{
  const h = renderMarkdown('```mermaid\nA --> B & C<D\n```');
  const m = h.match(/data-source="([^"]+)"/);
  assert(m, 'mermaid 有 data-source');
  const src = decodeURIComponent(m[1]);
  assert(src.includes('&'), '& 在 data-source 里完整保留');
  assert(src.includes('<'), '< 在 data-source 里完整保留');
  assert(src.includes('B & C<D'), '完整源码段保留');
}

// 7) 行内 code 与 fenced code 共存
{
  const h = renderMarkdown('用 `tools` 来调用 ```js\nfoo()\n```');
  assert(h.includes('<code>tools</code>'), '行内 code 渲染');
  assert(h.includes('<pre><code class="language-js">'), 'fenced code 渲染');
}

// 8) 无语言标记的代码块 → language-text
{
  const h = renderMarkdown('```\nplain text\n```');
  assert(h.includes('<pre><code class="language-text">'), '无语言 → language-text');
}

// 9) 标题 / 粗体 / 链接 不被代码块影响
{
  const h = renderMarkdown('## 标题\n**粗** [link](https://example.com)\n```js\nfoo\n```');
  assert(h.includes('<h2>标题</h2>'), 'h2 渲染');
  assert(h.includes('<strong>粗</strong>'), '粗体渲染');
  assert(h.includes('href="https://example.com"'), '链接渲染');
  assert(h.includes('<pre><code class="language-js">'), '代码块共存');
}

// 10) 长 mermaid 流程图（DeepSeek 真实输出）
{
  const realLLMOutput = '## Mermaid 流程图\n\n```mermaid\nflowchart TD\n    U[用户提问] --> CA[ConductorAgent]\n    CA --> D{判断}\n    D -- 简单 --> R[最终回答]\n```\n\n说明在下方。';
  const h = renderMarkdown(realLLMOutput);
  assert(h.includes('<div class="mermaid" data-source="'), '真实 LLM 输出 → mermaid loading 容器');
  assert(h.includes(encodeURIComponent('flowchart TD')), '真实 LLM 输出 → 源码经 URI 编码');
  assert(h.includes('<h2>Mermaid 流程图</h2>'), '同段 markdown 标题保留');
}

// 11) 两个 mermaid 流程图共存（用户报告的 bug：两图渲染到一起）
//     验证渲染时每个都有独立的 data-source（避免源码被合并）
{
  const twoCharts = '```mermaid\nflowchart LR\n  A1 --> A2\n```\n\n## 第二个\n\n```mermaid\nflowchart TD\n  B1 --> B2\n```';
  const h = renderMarkdown(twoCharts);
  const mermaidMatches = h.match(/<div class="mermaid" data-source="([^"]+)"/g) || [];
  assert(mermaidMatches.length === 2, '两个 mermaid 块 → 两个独立 .mermaid 容器');
  const sources = mermaidMatches.map((m) => m.match(/data-source="([^"]+)"/)[1]);
  assert(sources[0] !== sources[1], '两个 mermaid 块 → 各自的 data-source 独立');
  assert(decodeURIComponent(sources[0]).includes('A1 --> A2'), '第一个 mermaid 源码独立');
  assert(decodeURIComponent(sources[1]).includes('B1 --> B2'), '第二个 mermaid 源码独立');
}

// 12) nextMermaidId 唯一性回归（用户报告的 bug：两条 message 同毫秒并发 enhance 时 id 撞）
{
  // 复刻前端 markdown.ts 里的实现做单测
  let seq = 0;
  function nextId(prefix = 'mmd') {
    seq++;
    return `${prefix}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  const ids = new Set();
  // 模拟极端场景：1ms 内连续 2000 次调用
  for (let i = 0; i < 2000; i++) ids.add(nextId());
  assert(ids.size === 2000, '2000 次连续调用 nextMermaidId 全部唯一');
  // 同毫秒不同前缀也不撞
  const a = nextId('mmd-node');
  const b = nextId('mmd-svg');
  assert(a !== b, '不同前缀 id 不互撞');
}

console.log('\n全部通过 ✅');
