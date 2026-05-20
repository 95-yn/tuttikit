import type { LLMLike, LLMCallArgs, LLMResponse, LLMOnDelta } from '../types.js';

/**
 * 所有 LLM Provider 的基类。子类实现 chat / stream。
 */
export class BaseLLM implements LLMLike {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async chat(_input: LLMCallArgs): Promise<LLMResponse> {
    throw new Error(`${this.name}.chat() 未实现`);
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async stream(_input: LLMCallArgs, _onDelta?: LLMOnDelta): Promise<LLMResponse> {
    throw new Error(`${this.name}.stream() 未实现`);
  }
}
