import type { ToolSpec } from '../types.js';

/** 安全的算式求值器：只接受 数字 + - * / ( ) . 空白 */
export const calculatorTool: ToolSpec<{ expression: string }, { expression: string; value: number }> = {
  name: 'calculator',
  description: '对一个数学表达式求值，只允许加减乘除与括号。例如 (1+2)*3 / 4。',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '数学表达式' },
    },
    required: ['expression'],
  },
  allowedAgents: [],
  async handler({ expression }) {
    if (typeof expression !== 'string') throw new Error('expression 必须是字符串');
    if (!/^[\d\s\+\-\*\/\(\)\.]+$/.test(expression)) {
      throw new Error(`非法字符，仅允许数字与 + - * / ( ) .。收到：${expression}`);
    }
    // eslint-disable-next-line no-new-func
    const value = Function(`"use strict"; return (${expression});`)() as number;
    return { expression, value };
  },
};
