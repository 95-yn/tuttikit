import { BaseAgent, type BaseAgentDeps } from './base.js';
import { buildCoderPrompt } from '../prompts/index.js';

export class CoderAgent extends BaseAgent {
  constructor(deps: Omit<BaseAgentDeps, 'name' | 'role' | 'systemPrompt'>) {
    super({ ...deps, name: 'coder', role: 'coder', systemPrompt: buildCoderPrompt() });
  }
}
