/**
 * PromptBuilder —— 链式拼接 system prompt。
 *
 * 用法：
 *   new PromptBuilder()
 *     .add(IDENTITY)
 *     .add(TOOLS)
 *     .when(memories.length, () => memoryBlock(memories))
 *     .build();
 */
export class PromptBuilder {
  private _parts: string[] = [];

  add(text: string | null | undefined): this {
    if (text) this._parts.push(String(text).trim());
    return this;
  }

  when(cond: unknown, producer: string | (() => string | null | undefined)): this {
    if (cond) this.add(typeof producer === 'function' ? producer() : producer);
    return this;
  }

  addAll(parts: Array<string | null | undefined>): this {
    for (const p of parts) this.add(p);
    return this;
  }

  map(fn: (last: string) => string): this {
    if (this._parts.length) {
      this._parts[this._parts.length - 1] = fn(this._parts[this._parts.length - 1]);
    }
    return this;
  }

  build(): string {
    return this._parts.join('\n\n').trim();
  }
}

export function prompt(): PromptBuilder {
  return new PromptBuilder();
}
