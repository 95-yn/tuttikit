/**
 * `code_execute` tool —— 让 LLM 在 Pyodide 沙箱里跑 Python。
 *
 * 用法（LLM 视角）：
 *   code_execute({ code: "import pandas as pd; df = pd.DataFrame(...); print(df)" })
 *
 * 行为：
 *   - 同 session 多次调用共享 globals（像 Jupyter cell）
 *   - matplotlib 自动转 PNG，通过 SSE 'code:image' 推前端 + 在 result.images 也有 base64
 *   - 30s 默认超时，超时强清 runtime（下次冷启动）
 *   - safety hook 自动接管：rm -rf / os.system 之类的 Python 代码也会被拦
 */
import { z } from 'zod';
import type { ToolSpec, ToolCtx } from '../types.js';
import { execPython, type CodeExecResult } from '../core/codeExec.js';

const CodeExecInputSchema = z.object({
  code: z.string().min(1).max(20_000).describe('Python 代码；同 session 多次调用共享 globals'),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional().describe('执行超时毫秒；默认 30000'),
});

export const codeExecTool: ToolSpec<z.infer<typeof CodeExecInputSchema>, CodeExecResult> = {
  name: 'code_execute',
  description:
    '在 Pyodide 沙箱里跑 Python 代码做数据分析 / 画图 / 算数。\n' +
    '已预装 numpy / pandas / matplotlib / scipy / scikit-learn。\n' +
    '同一对话里多次调用共享变量（像 Jupyter）。\n' +
    'matplotlib 画的图自动转 PNG 显示给用户。\n' +
    '不能访问网络、不能访问宿主文件系统；写文件请用 /sandbox/output/ 路径。',
  parameters: {
    type: 'object',
    properties: {
      code:      { type: 'string', description: 'Python 代码' },
      timeoutMs: { type: 'integer', description: '执行超时毫秒（默认 30000）' },
    },
    required: ['code'],
  },
  inputSchema: CodeExecInputSchema,
  allowedAgents: ['conductor', 'coder'],
  handler: async ({ code, timeoutMs }, ctx: ToolCtx = {}) => {
    return execPython({
      sessionId: ctx.sessionId ?? '_default',
      code,
      timeoutMs,
      bus: ctx.bus,
    });
  },
};
