'use client';
import { Icon, type IconName } from './IconSprite';

const EXAMPLES: { icon: IconName; label: string; prompt: string }[] = [
  { icon: 'i-calc',   label: '帮我算个数学', prompt: '帮我算 (128 × 37 + 256) ÷ 8 的结果' },
  { icon: 'i-search', label: '调研技术',     prompt: '调研一下 pgvector 是什么' },
  { icon: 'i-file',   label: '写一个文件',   prompt: '在 ./data/hello.txt 里写一句 hello multi-agent' },
  { icon: 'i-bot',    label: '调研 + 落地',  prompt: '调研多 Agent 架构常见模式，把要点写到 ./data/patterns.md' },
];

export function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="empty-state">
      <div className="empty-icon-wrap">
        <Icon name="i-spark" size="lg" />
      </div>
      <div>
        <h2>TuttiKit</h2>
        <p>Conductor 主 Agent 会按需调用工具或委派子 Agent</p>
      </div>
      <div className="empty-suggest">
        {EXAMPLES.map((e, i) => (
          <button key={i} type="button" onClick={() => onPick(e.prompt)}>
            <Icon name={e.icon} />
            <span>{e.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
