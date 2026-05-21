import type { Session, Message } from './types';

/**
 * 把一个 Session 序列化成 Markdown 字符串，给「导出」/「复制全文」用。
 *
 * 输出格式（约定俗成）：
 *   # <session title>
 *   _exported from TuttiKit · <createdAt>_
 *
 *   ## You · 14:33
 *   <content>
 *   - 📎 [附件名](url)
 *
 *   ## Conductor · 14:34
 *   <content>
 *   <details><summary>🔧 calculator</summary>
 *   `input` ...
 *   `output` ...
 *   </details>
 */
export function exportSessionToMarkdown(session: Session): string {
  const lines: string[] = [];
  lines.push(`# ${session.title || '未命名会话'}`);
  lines.push(`_exported from TuttiKit · ${new Date().toISOString()}_`);
  lines.push('');

  for (const m of session.messages) {
    if (m.role === 'tool') continue;  // tool 输出在 assistant 折叠块里渲染了
    const time = m.meta?.createdAt
      ? new Date(typeof m.meta.createdAt === 'number' ? m.meta.createdAt : m.meta.createdAt).toLocaleString()
      : '';
    const who = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Conductor' : m.role;
    lines.push(`## ${who}${time ? ` · ${time}` : ''}`);
    lines.push('');

    if (m.attachments?.length) {
      for (const a of m.attachments) {
        const kind = a.kind === 'pdf' ? '📄' : '🖼';
        lines.push(`- ${kind} [${a.filename}](/api/uploads/${a.id})`);
      }
      lines.push('');
    }

    if (m.content) {
      lines.push(m.content);
      lines.push('');
    }

    // assistant 的 tool_calls：把对应的 tool 消息拼进折叠块
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        const toolMsg = findToolMessage(session.messages, tc.id);
        lines.push(`<details><summary>🔧 ${tc.name}</summary>`);
        lines.push('');
        lines.push('**Input**');
        lines.push('```json');
        lines.push(jsonPretty(tc.input));
        lines.push('```');
        if (toolMsg?.content) {
          lines.push('**Output**');
          lines.push('```json');
          lines.push(prettyPrintToolContent(toolMsg.content));
          lines.push('```');
        }
        lines.push('</details>');
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

function findToolMessage(messages: Message[], toolCallId: string): Message | undefined {
  return messages.find((m) => m.role === 'tool' && m.toolCallId === toolCallId);
}

function jsonPretty(v: unknown): string {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function prettyPrintToolContent(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); }
  catch { return s; }
}

/**
 * 触发下载 .md 文件
 */
export function downloadMarkdown(md: string, filename: string): void {
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 200);
}

/** 复制到剪贴板 */
export async function copyToClipboard(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch { return false; }
}
