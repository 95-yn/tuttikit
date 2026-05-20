import type { ToolSpec } from '../types.js';
import { skillsLoader } from './loader.js';

export const findSkillsTool: ToolSpec<
  { query?: string; k?: number },
  { results: Array<{ name: string; description: string }> }
> = {
  name: 'find_skills',
  description:
    '检索可用的本地 Skill（工作流指南 / 操作手册）。当任务可能需要某个专项工作流时，先用关键词搜一下，' +
    '看有没有匹配的 skill，再用 invoke_skill 拉取正文。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '关键词；留空 = 列出全部' },
      k: { type: 'integer', description: '返回数量，默认 5' },
    },
  },
  allowedAgents: ['conductor'],
  handler({ query = '', k = 5 }) {
    const results = skillsLoader.search(query, k).map(({ name, description }) => ({ name, description }));
    return { results };
  },
};

export const invokeSkillTool: ToolSpec<
  { name: string },
  { name: string; description: string; content: string } | { error: string }
> = {
  name: 'invoke_skill',
  description:
    '加载指定 Skill 的完整正文。先用 find_skills 找到 name，再调用这个把正文拉到对话上下文。' +
    '正文是 markdown 操作指南，按里面说的执行后续步骤。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill 的 name（来自 find_skills 的结果）' },
    },
    required: ['name'],
  },
  allowedAgents: ['conductor'],
  handler({ name }) {
    const skill = skillsLoader.get(name);
    if (!skill) return { error: `Skill "${name}" 不存在；先用 find_skills 看可用列表` };
    return { name: skill.name, description: skill.description, content: skill.body };
  },
};
