import { BaseAgent, type BaseAgentDeps } from './base.js';
import { buildResearcherPrompt } from '../prompts/index.js';

export class ResearcherAgent extends BaseAgent {
  constructor(deps: Omit<BaseAgentDeps, 'name' | 'role' | 'systemPrompt'>) {
    super({ ...deps, name: 'researcher', role: 'researcher', systemPrompt: buildResearcherPrompt() });
  }

  buildSystemPrompt(input: string): string {
    const memories = this.longTermMemory?.search(input, 3) || [];
    return buildResearcherPrompt({ memories });
  }
}
