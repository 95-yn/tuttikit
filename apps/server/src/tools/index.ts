import { ToolRegistry } from './registry.js';
import { calculatorTool } from './calculator.js';
import { fileReadTool, fileWriteTool } from './fileSystem.js';
import { webSearchTool } from './webSearch.js';
import { codeExecTool } from './codeExec.js';
import { renderArtifactTool } from './artifact.js';
import { gitStatusTool, gitDiffTool } from './git.js';
import { makeDelegateTool } from './delegate.js';
import { ResearcherAgent, CoderAgent, ReviewerAgent } from '../agents/index.js';
import { findSkillsTool, invokeSkillTool } from '../skills/index.js';
import { mcpManager } from '../mcp/index.js';
import { logger } from '../observability/logger.js';
import type { LLMLike } from '../types.js';
import type { MessageBus } from '../core/messageBus.js';
import type { LongTermMemory } from '../memory/longTerm.js';

export interface ToolRegistryDeps {
  llm: LLMLike;
  longTermMemory: LongTermMemory;
  bus?: MessageBus;
}

export function buildToolRegistryWithSubAgents({ llm, longTermMemory, bus }: ToolRegistryDeps): ToolRegistry {
  const reg = new ToolRegistry();

  reg.register({
    ...calculatorTool,
    allowedAgents: ['conductor', 'researcher', 'coder', 'reviewer'],
  });
  reg.register({
    ...fileReadTool,
    allowedAgents: ['conductor', 'coder', 'reviewer'],
  });
  reg.register({
    ...fileWriteTool,
    allowedAgents: ['conductor', 'coder'],
  });
  reg.register({
    ...webSearchTool,
    allowedAgents: ['conductor', 'researcher'],
  });
  reg.register({
    ...codeExecTool,
    allowedAgents: ['conductor', 'coder'],
  });
  reg.register({
    ...renderArtifactTool,
    allowedAgents: ['conductor', 'coder'],
  });
  reg.register({
    ...gitStatusTool,
    allowedAgents: ['conductor', 'coder', 'reviewer'],
  });
  reg.register({
    ...gitDiffTool,
    allowedAgents: ['conductor', 'coder', 'reviewer'],
  });

  const common = { llm, toolRegistry: reg, longTermMemory, bus };
  const researcher = new ResearcherAgent(common);
  const coder = new CoderAgent(common);
  const reviewer = new ReviewerAgent(common);

  reg.register({
    ...makeDelegateTool({
      name: 'delegate_to_researcher',
      description:
        '把"调研类任务"委派给 Researcher 子 Agent。它会自动使用 web_search 收集资料并给出结构化结论。' +
        '适用于：需要事实依据的问题、对比技术方案、概念解释等。',
      agent: researcher,
      longTermMemory,
      persistTagFn: (input) => ['research', String(input).slice(0, 20)],
    }),
    allowedAgents: ['conductor'],
  });

  reg.register({
    ...makeDelegateTool({
      name: 'delegate_to_coder',
      description:
        '把"写文件 / 落地代码"委派给 Coder 子 Agent。它会用 file_system_write 把成果写到项目目录。' +
        '适用于：需要把调研结论或代码方案落到具体 .md/.txt/.js 等文件。',
      agent: coder,
    }),
    allowedAgents: ['conductor'],
  });

  reg.register({
    ...makeDelegateTool({
      name: 'delegate_to_reviewer',
      description:
        '把"审查代码 / 审查文档"委派给 Reviewer 子 Agent。它会必要时 file_system_read 然后给出评分与改进建议。',
      agent: reviewer,
    }),
    allowedAgents: ['conductor'],
  });

  // ── Skills 工具：本地 markdown 工作流指南（兼容 Claude Code skills）──
  reg.register(findSkillsTool);
  reg.register(invokeSkillTool);

  // ── MCP 工具：把全局 MCPManager 已连接的 server 的 specs 注册进来 ──
  for (const spec of mcpManager.getToolSpecs()) {
    try { reg.register(spec); }
    catch (err) { logger.warn({ err, name: spec.name }, '[mcp] tool register 失败（重名？）'); }
  }

  return reg;
}
