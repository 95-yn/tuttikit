import pino, { Logger } from 'pino';
import { config } from '../config.js';

export const logger: Logger = pino({
  level: config.server.logLevel,
  transport: {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss.l' },
  },
});

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
