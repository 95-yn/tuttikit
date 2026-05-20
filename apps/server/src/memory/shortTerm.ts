import { config } from '../config.js';
import type { Message } from '../types.js';

/**
 * 短期记忆：滑动窗口式对话历史，超过 maxTurns 丢弃最早消息。
 * 一个 Agent 一份独立短期记忆。
 */
export class ShortTermMemory {
  maxTurns: number;
  messages: Message[];

  constructor({ maxTurns = config.memory.shortTermMaxTurns }: { maxTurns?: number } = {}) {
    this.maxTurns = maxTurns;
    this.messages = [];
  }

  append(message: Message): void {
    this.messages.push(message);
    this._trim();
  }

  appendMany(messages: Message[]): void {
    for (const m of messages) this.append(m);
  }

  getAll(): Message[] {
    return [...this.messages];
  }

  reset(): void {
    this.messages = [];
  }

  private _trim(): void {
    const overflow = this.messages.length - this.maxTurns * 2;
    if (overflow > 0) this.messages.splice(0, overflow);
  }
}
