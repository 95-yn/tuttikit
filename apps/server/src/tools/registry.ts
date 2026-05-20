import type { ToolSpec, ToolCtx, LLMToolDef } from '../types.js';

export class ToolRegistry {
  tools: Map<string, ToolSpec>;

  constructor() {
    this.tools = new Map();
  }

  register(tool: ToolSpec): this {
    if (!tool?.name) throw new Error('tool.name 必填');
    if (this.tools.has(tool.name)) {
      throw new Error(`tool ${tool.name} 已存在`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  /** 某个 agent role 可见的工具规格（不含 handler） */
  specsFor(agentName: string): LLMToolDef[] {
    const out: LLMToolDef[] = [];
    for (const t of this.tools.values()) {
      if (t.allowedAgents?.length && !t.allowedAgents.includes(agentName)) continue;
      out.push({ name: t.name, description: t.description, parameters: t.parameters });
    }
    return out;
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  async invoke(name: string, input: unknown, ctx: ToolCtx = {}): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`未知工具：${name}`);
    return tool.handler(input ?? {}, ctx);
  }
}
