import { z } from 'zod';
import type { ToolSpec } from '../types.js';

const Input = z.object({
  expression: z.string().min(1, 'expression 不能为空'),
});

/** 安全的算式求值器：只接受 数字 + - * / ( ) . 空白 */
export const calculatorTool: ToolSpec<z.infer<typeof Input>, { expression: string; value: number }> = {
  name: 'calculator',
  description: '对一个数学表达式求值，只允许加减乘除与括号。例如 (1+2)*3 / 4。',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '数学表达式' },
    },
    required: ['expression'],
  },
  inputSchema: Input,
  allowedAgents: [],
  async handler({ expression }) {
    if (typeof expression !== 'string') throw new Error('expression 必须是字符串');
    // 长度上限：防止极端长度引发的 CPU 卡顿（或 Function 解析极端代价）
    if (expression.length > 256) {
      throw new Error('表达式过长（最多 256 字符）');
    }
    if (!/^[\d\s\+\-\*\/\(\)\.]+$/.test(expression)) {
      throw new Error(`非法字符，仅允许数字与 + - * / ( ) .。收到：${expression}`);
    }
    // 数字字面量长度上限（避免 0.000...01 这类 200 位数字塞进 Function）
    if (/[\d.]{32,}/.test(expression)) {
      throw new Error('表达式中数字过长');
    }
    // eslint-disable-next-line no-new-func
    const value = Function(`"use strict"; return (${expression});`)() as number;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`求值结果非有限数：${value}`);
    }
    return { expression, value };
  },
};
