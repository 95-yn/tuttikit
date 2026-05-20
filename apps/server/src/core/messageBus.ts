import { EventEmitter } from 'node:events';

/**
 * MessageBus —— Conductor / Sub-agent / Tool 之间的事件中枢。
 * 服务端把 bus 上的事件转成 SSE 推给前端，CLI 把它打印到终端。
 */
export class MessageBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }
}
