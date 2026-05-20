'use client';
import { useEffect, useRef } from 'react';
import { renderMarkdown, safeDecodeURI, escapeHtml, nextMermaidId } from '@/lib/markdown';

// 懒加载 highlight.js（仅在客户端首次 enhance 时拉一次）
let _hljs: typeof import('highlight.js').default | null = null;
async function getHljs() {
  if (_hljs) return _hljs;
  const mod = await import('highlight.js');
  _hljs = mod.default;
  return _hljs;
}

// 懒加载 mermaid（同样仅客户端）
let _mermaid: typeof import('mermaid').default | null = null;
let _mermaidInit = false;
async function getMermaid() {
  if (_mermaid) return _mermaid;
  const mod = await import('mermaid');
  _mermaid = mod.default;
  if (!_mermaidInit) {
    _mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        background: '#0a0a0c', primaryColor: '#1a1a1f',
        primaryTextColor: '#ECEDEE', primaryBorderColor: '#32343d',
        lineColor: '#7C9CFF', secondaryColor: '#131316', tertiaryColor: '#22232a',
        textColor: '#ECEDEE', nodeBorder: '#32343d',
        clusterBkg: '#131316', clusterBorder: '#32343d',
        fontFamily: '"Plus Jakarta Sans", sans-serif',
      },
      flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
      sequence: { useMaxWidth: true },
      securityLevel: 'loose',
    });
    _mermaidInit = true;
  }
  return _mermaid;
}

// 全局 mermaid render 队列：mermaid v11 用全局临时 DOM，不能并发
let _mmdRenderQueue: Promise<unknown> = Promise.resolve();
function runOnMermaidQueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = _mmdRenderQueue.then(fn, fn);
  _mmdRenderQueue = next.catch(() => {});
  return next as Promise<T>;
}

interface Props {
  text: string;
  streaming?: boolean;
  className?: string;
}

export function Markdown({ text, streaming, className }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const html = renderMarkdown(text) + (streaming ? '<span class="cursor"></span>' : '');

  useEffect(() => {
    if (!rootRef.current) return;
    if (streaming) return;          // 流式期间不增强（mermaid 源码可能还没完整）
    enhanceCodeBlocks(rootRef.current);
    const dispose = enhanceMermaidLazy(rootRef.current);
    return dispose;
  }, [html, streaming]);

  return (
    <div
      ref={rootRef}
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

async function enhanceCodeBlocks(root: HTMLElement) {
  const codes = root.querySelectorAll<HTMLElement>(
    ':scope > pre > code[class*="language-"]',
  );
  if (!codes.length) return;
  let hljs: Awaited<ReturnType<typeof getHljs>> | null = null;
  for (const codeEl of codes) {
    if (codeEl.dataset.enhanced) continue;
    const lang = (codeEl.className.match(/language-(\S+)/) || ['', 'text'])[1];
    if (lang === 'mermaid') continue;

    const pre = codeEl.parentElement!;
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    wrap.innerHTML = `
      <div class="code-head">
        <span class="code-lang">${escapeHtml(lang)}</span>
        <button class="code-copy" type="button" title="复制代码">
          <svg class="icon icon-sm"><use href="#i-copy"/></svg><span>复制</span>
        </button>
      </div>
    `;
    pre.parentNode!.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    codeEl.dataset.enhanced = '1';

    if (lang !== 'text') {
      try {
        hljs ??= await getHljs();
        hljs.highlightElement(codeEl);
      } catch { /* 未注册语言静默忽略 */ }
    }

    wrap.querySelector('.code-copy')!.addEventListener('click', async () => {
      const btn = wrap.querySelector<HTMLButtonElement>('.code-copy')!;
      try { await navigator.clipboard.writeText(codeEl.textContent || ''); } catch {}
      btn.classList.add('copied');
      btn.innerHTML = '<svg class="icon icon-sm"><use href="#i-check"/></svg><span>已复制</span>';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = '<svg class="icon icon-sm"><use href="#i-copy"/></svg><span>复制</span>';
      }, 1600);
    });
  }
}

/**
 * 准备所有 .mermaid 节点（设 id / 缓存源码 / 显示 loading），并用 IntersectionObserver
 * 观察它们。节点滚到视口附近时，才真正下载 mermaid chunk + 渲染。
 *
 * 收益：
 *   - 没有流程图的对话：mermaid chunk 永不下载（省 ~600KB）
 *   - 长对话只画当前可见的图，远处的图不抢 CPU
 *   - 渲染加 20s 超时，超时后降级显示源码（避免无限 loading）
 */
function enhanceMermaidLazy(root: HTMLElement): () => void {
  const nodes = [
    ...root.querySelectorAll<HTMLElement>(
      '.mermaid:not([data-processed]):not([data-streaming])',
    ),
  ];
  if (!nodes.length) return () => {};

  nodes.forEach((n) => {
    if (!n.id) n.id = nextMermaidId('mmd-node');
    if (!n.dataset.sourceText) {
      const raw = n.dataset.source ? safeDecodeURI(n.dataset.source) : n.textContent || '';
      n.dataset.sourceText = raw;
    }
    if (!n.querySelector('.mermaid-loading')) {
      n.innerHTML =
        `<div class="mermaid-loading"><div class="spinner"></div><span>等待渲染…</span></div>`;
    }
  });

  // 老浏览器没 IntersectionObserver → 退回到一次性全部渲染
  if (typeof IntersectionObserver === 'undefined') {
    nodes.forEach((n) => { void renderOne(n); });
    return () => {};
  }

  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const node = entry.target as HTMLElement;
      io.unobserve(node);
      void renderOne(node);
    }
  }, {
    // 提前 200px 开始渲染，让用户滚到时基本已经画好
    rootMargin: '200px 0px',
    threshold: 0.01,
  });
  nodes.forEach((n) => io.observe(n));
  return () => io.disconnect();
}

const RENDER_TIMEOUT_MS = 20_000;

async function renderOne(node: HTMLElement): Promise<void> {
  if (node.dataset.processed) return;

  let mermaid;
  try { mermaid = await getMermaid(); } catch (err: unknown) {
    showError(node, err);
    return;
  }

  await runOnMermaidQueue(async () => {
    if (node.dataset.processed) return;
    // 容器宽度为 0 时 mermaid 渲染会生成 0 尺寸 SVG → 跳过这次，等下次 observe
    if (!node.isConnected || node.clientWidth === 0) {
      node.innerHTML =
        `<div class="mermaid-loading"><div class="spinner"></div><span>等待容器就绪…</span></div>`;
      return;
    }

    const renderId = nextMermaidId('mmd-svg');
    const source = node.dataset.sourceText || '';
    try {
      const render = mermaid!.render(renderId, source);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`渲染超时 (${RENDER_TIMEOUT_MS / 1000}s)`)), RENDER_TIMEOUT_MS));
      const out = await Promise.race([render, timeout]);
      node.innerHTML = out.svg;
      if (typeof out.bindFunctions === 'function') out.bindFunctions(node);
      node.dataset.processed = 'true';
      wrapMermaidWithActions(node);
    } catch (err: unknown) {
      showError(node, err, source);
    }
  });
}

function showError(node: HTMLElement, err: unknown, source = ''): void {
  node.classList.add('mermaid-error');
  const msg = err instanceof Error ? err.message : String(err);
  const srcBlock = source
    ? `<details><summary>查看源码</summary><pre>${escapeHtml(source)}</pre></details>`
    : '';
  node.innerHTML = `<pre>Mermaid 渲染失败：${escapeHtml(msg)}</pre>${srcBlock}`;
}

function wrapMermaidWithActions(mermaidEl: HTMLElement) {
  if (mermaidEl.parentElement?.classList.contains('mermaid-block')) return;
  const block = document.createElement('div');
  block.className = 'mermaid-block';
  mermaidEl.parentNode!.insertBefore(block, mermaidEl);
  block.appendChild(mermaidEl);

  const source = safeDecodeURI(mermaidEl.dataset.source || '');

  const actions = document.createElement('div');
  actions.className = 'mermaid-actions';
  actions.innerHTML = `
    <button class="mermaid-action-btn" data-act="copy-src" type="button" title="复制 Mermaid 源码">
      <svg class="icon icon-sm"><use href="#i-source"/></svg><span>源码</span>
    </button>
    <button class="mermaid-action-btn" data-act="download" type="button" title="下载 SVG">
      <svg class="icon icon-sm"><use href="#i-download"/></svg><span>SVG</span>
    </button>
  `;
  block.appendChild(actions);

  const setDone = (btn: HTMLElement, label: string) => {
    const orig = btn.innerHTML;
    btn.classList.add('done');
    btn.innerHTML = `<svg class="icon icon-sm"><use href="#i-check"/></svg><span>${label}</span>`;
    setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = orig; }, 1600);
  };

  actions.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const svg = mermaidEl.querySelector('svg');
    try {
      if (act === 'copy-src') {
        await navigator.clipboard.writeText(source);
        setDone(btn, '已复制');
      } else if (act === 'download') {
        if (!svg) return;
        downloadSvg(svg, 'flowchart.svg');
        setDone(btn, '已下载');
      }
    } catch {/* ignore */}
  });
}

function downloadSvg(svgEl: SVGElement, filename: string) {
  const clone = svgEl.cloneNode(true) as SVGElement;
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!clone.getAttribute('xmlns:xlink')) clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  const data = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([data], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
