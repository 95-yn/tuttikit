import { BaseAgent, type BaseAgentDeps } from './base.js';
import { buildReviewerPrompt } from '../prompts/index.js';

export class ReviewerAgent extends BaseAgent {
  constructor(deps: Omit<BaseAgentDeps, 'name' | 'role' | 'systemPrompt'>) {
    super({ ...deps, name: 'reviewer', role: 'reviewer', systemPrompt: buildReviewerPrompt() });
  }
}
