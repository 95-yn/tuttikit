'use client';
import { useState } from 'react';
import Link from 'next/link';

/**
 * Logo 候选预览：三组 mark 各跑一遍尺寸（favicon 16 → 标题 96），
 * 黑底白底两种背景对照。挑哪个直接说，我把它接到 favicon + Topbar + README。
 */

const MARKS = [
  { id: 'a', name: '方案 A · Conductor T',
    desc: '字母 T（=指挥棒）下面三股延伸到 3 个 agent 节点。识别度最高，专业感强' },
  { id: 'b', name: '方案 B · Hub Topology',
    desc: '中心实心方块（Conductor） + 三角形三个空心节点（sub-agent）。最抽象、最现代' },
  { id: 'c', name: '方案 C · Tutti（齐奏）',
    desc: '5 根高低竖条 + 底部锚线，呼应 Tutti（意大利语「合奏」）。最特别、像音乐 / 均衡器' },
];

const SIZES = [16, 24, 32, 48, 96];

export default function LogoPreview() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  return (
    <div style={{
      minHeight: '100vh',
      background: theme === 'dark' ? '#0a0a0c' : '#FAFAFB',
      color: theme === 'dark' ? '#f0f0f4' : '#0a0a0c',
      padding: '40px 24px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <header style={{ maxWidth: 960, margin: '0 auto 32px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <Link href="/" style={{ color: 'inherit', textDecoration: 'none', opacity: 0.6 }}>← 返回</Link>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>TuttiKit Logo 候选</h1>
        <button
          type="button"
          onClick={() => setTheme((t) => t === 'dark' ? 'light' : 'dark')}
          style={{
            marginLeft: 'auto',
            background: theme === 'dark' ? '#222' : '#e5e5e5',
            color: 'inherit',
            border: 'none', borderRadius: 6, padding: '6px 12px',
            cursor: 'pointer', fontSize: 13,
          }}
        >
          切{theme === 'dark' ? '亮' : '暗'}
        </button>
      </header>

      <div style={{ maxWidth: 960, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
        {MARKS.map((m) => (
          <section
            key={m.id}
            style={{
              padding: '20px 24px',
              background: theme === 'dark' ? '#15151a' : '#fff',
              border: `1px solid ${theme === 'dark' ? '#2a2a30' : '#e0e0e6'}`,
              borderRadius: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>{m.name}</h2>
              <code style={{
                fontSize: 11, opacity: 0.5, fontFamily: 'ui-monospace, Menlo, monospace',
              }}>
                /logos/tuttikit-mark-{m.id}.svg
              </code>
            </div>
            <p style={{ margin: '0 0 18px', opacity: 0.7, fontSize: 14 }}>{m.desc}</p>

            {/* 尺寸阶梯 */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap' }}>
              {SIZES.map((s) => (
                <div key={s} style={{ textAlign: 'center' }}>
                  <div style={{
                    width: s, height: s, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {/* 用 currentColor 让 SVG 跟随父容器 color */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/logos/tuttikit-mark-${m.id}.svg`}
                      alt={m.name}
                      width={s}
                      height={s}
                      style={{ display: 'block' }}
                    />
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.55, marginTop: 4 }}>{s}px</div>
                </div>
              ))}
            </div>

            {/* 反相对照 + 实际 favicon 模拟 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 22 }}>
              <span style={{ fontSize: 12, opacity: 0.55 }}>反色对照:</span>
              <div style={{
                background: theme === 'dark' ? '#fff' : '#0a0a0c',
                padding: 12, borderRadius: 8,
                color: theme === 'dark' ? '#0a0a0c' : '#fff',
              }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/logos/tuttikit-mark-${m.id}.svg`}
                  alt={m.name}
                  width={48} height={48}
                  style={{ display: 'block' }}
                />
              </div>
              <span style={{ fontSize: 12, opacity: 0.55, marginLeft: 24 }}>浏览器 tab 模拟:</span>
              <div style={{
                background: theme === 'dark' ? '#1a1a1f' : '#f0f0f0',
                padding: '6px 12px', borderRadius: '6px 6px 0 0',
                display: 'flex', alignItems: 'center', gap: 8,
                border: `1px solid ${theme === 'dark' ? '#2a2a30' : '#d0d0d6'}`,
                borderBottom: 'none',
              }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/logos/tuttikit-mark-${m.id}.svg`} alt="" width={16} height={16} />
                <span style={{ fontSize: 13 }}>TuttiKit</span>
                <span style={{ opacity: 0.4 }}>×</span>
              </div>
            </div>

            {/* 标题样式 + 字 */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, marginTop: 22,
              padding: '12px 16px',
              background: theme === 'dark' ? '#1a1a1f' : '#f5f5f7',
              borderRadius: 8,
            }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/logos/tuttikit-mark-${m.id}.svg`} alt="" width={28} height={28} />
              <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em' }}>
                TuttiKit
              </span>
              <span style={{ opacity: 0.45, fontSize: 13, marginLeft: 8 }}>
                多 Agent 协作框架
              </span>
            </div>
          </section>
        ))}

        <footer style={{ opacity: 0.5, fontSize: 13, textAlign: 'center', padding: '20px 0' }}>
          挑哪个直接告诉我（A / B / C），我把它接到 favicon、Topbar、README。
        </footer>
      </div>
    </div>
  );
}
