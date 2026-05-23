/**
 * `render_artifact` tool —— 让 LLM 生成可在用户气泡里直接渲染的 HTML/SVG/React 片段。
 *
 * 体验类比 Claude Artifacts / ChatGPT Canvas / v0：
 *   - LLM 调 render_artifact({ html, kind })
 *   - 后端落 sqlite + emit SSE 'artifact:rendered'
 *   - 前端 ArtifactFrame 用 <iframe sandbox="allow-scripts"> 渲染
 *   - 同 id 重复调用 = 更新（用户说"把按钮变红"→ LLM 重新生成→替换同一个 iframe）
 *
 * 安全：
 *   - iframe sandbox="allow-scripts" —— 浏览器原生最强隔离：
 *     no same-origin / no cookies / no top-navigation / no forms / no popups
 *     即使 LLM 写 eval() 也只在沙箱里跑，拿不到宿主任何东西
 *   - HTML 体上限 200KB（防 LLM 灌爆 SSE / sqlite）
 *   - **不加 safety regex 拦 HTML 模式**——sandbox 已经够强，正则反而误伤合法 demo 代码
 */
import { z } from 'zod';
import type { ToolSpec, ToolCtx } from '../types.js';
import { saveArtifact, type Artifact } from '../core/artifact.js';

const ArtifactInputSchema = z.object({
  html: z.string().min(1).max(200_000).describe('完整 HTML 文档（含 <html><head><style><body>...），或 <svg> 字符串'),
  kind: z.enum(['html', 'svg', 'react']).optional().describe('类型；默认 html'),
  title: z.string().max(120).optional().describe('给用户看的标题；显示在 iframe 上方'),
  id: z.string().min(1).max(30).optional().describe('artifact id；同 id 重复调用 = 更新（多轮迭代场景）'),
});

export const renderArtifactTool: ToolSpec<z.infer<typeof ArtifactInputSchema>, Artifact> = {
  name: 'render_artifact',
  description:
    '生成一段可在用户聊天界面里直接渲染的 HTML / SVG / React 片段（沙箱 iframe）。\n' +
    '类比 Claude Artifacts / v0 / bolt：用户看到你的代码效果，不用复制到浏览器。\n' +
    '同一对话里如果想"改一下让按钮变红"，**传同样的 id 就会替换**，不会建新 iframe。\n' +
    '限制：完整 HTML 文档，不超过 200KB；iframe sandbox 不允许同源 / cookie / top navigation / form 提交。\n' +
    'React/Vue 用 CDN：`<script type="module" src="https://esm.sh/react"></script>`。',
  parameters: {
    type: 'object',
    properties: {
      html:  { type: 'string', description: '完整 HTML 文档' },
      kind:  { type: 'string', enum: ['html', 'svg', 'react'], description: '类型（默认 html）' },
      title: { type: 'string', description: '标题' },
      id:    { type: 'string', description: '同 id 重复调 = 更新已有 artifact' },
    },
    required: ['html'],
  },
  inputSchema: ArtifactInputSchema,
  allowedAgents: ['conductor', 'coder'],
  handler: async ({ html, kind, title, id }, ctx: ToolCtx = {}) => {
    const sessionId = ctx.sessionId ?? '_default';
    const artifact = saveArtifact({ id, sessionId, kind: kind ?? 'html', title, html });
    // emit SSE 让前端立刻渲染（不等 conductor 走完 tool 循环）
    ctx.bus?.emit('artifact:rendered', {
      sessionId,
      artifactId: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      html: artifact.html,
      updatedAt: artifact.updatedAt,
    });
    return artifact;
  },
};
