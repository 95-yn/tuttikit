/**
 * 集中导出所有 agent 的 system prompt builder。
 */

import { prompt } from './builder.js';
import {
  CONDUCTOR_IDENTITY, CONDUCTOR_TOOLS, CONDUCTOR_RULES,
  RESEARCHER_IDENTITY, RESEARCHER_WORKFLOW, RESEARCHER_CONSTRAINTS,
  CODER_IDENTITY, CODER_WORKFLOW, CODER_CONSTRAINTS,
  REVIEWER_IDENTITY, REVIEWER_WORKFLOW,
  memoryHintBlock,
} from './fragments.js';
import type { MemoryEntry } from '../types.js';

export function buildConductorPrompt(): string {
  return prompt()
    .add(CONDUCTOR_IDENTITY)
    .add(CONDUCTOR_TOOLS)
    .add(CONDUCTOR_RULES)
    .build();
}

export function buildResearcherPrompt({ memories = [] }: { memories?: MemoryEntry[] } = {}): string {
  return prompt()
    .add(RESEARCHER_IDENTITY)
    .add(RESEARCHER_WORKFLOW)
    .add(RESEARCHER_CONSTRAINTS)
    .when(memories.length, () => memoryHintBlock(memories))
    .build();
}

export function buildCoderPrompt(): string {
  return prompt()
    .add(CODER_IDENTITY)
    .add(CODER_WORKFLOW)
    .add(CODER_CONSTRAINTS)
    .build();
}

export function buildReviewerPrompt(): string {
  return prompt()
    .add(REVIEWER_IDENTITY)
    .add(REVIEWER_WORKFLOW)
    .build();
}

export { prompt, PromptBuilder } from './builder.js';
export * from './fragments.js';
