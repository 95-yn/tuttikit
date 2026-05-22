/**
 * SSE 连接并发限流：防止单 IP 把长连接打满。
 * 抽自 server.ts —— `routes/streams.ts` 用，server.ts 也仍可直接 import。
 */
import type { Request, RequestHandler } from 'express';

const SSE_MAX_PER_IP = 8;     // 单 IP 最多同时 8 个 SSE 长连接
const sseConnCount = new Map<string, number>();

export function getClientIp(req: Request): string {
  // 优先 trust-proxy 解析过的 ip；没有的话 fallback 到 socket.remoteAddress
  return (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

export const sseLimiter: RequestHandler = (req, res, next) => {
  const ip = getClientIp(req);
  const cur = sseConnCount.get(ip) ?? 0;
  if (cur >= SSE_MAX_PER_IP) {
    res.status(429).json({ error: `too many SSE connections from ${ip} (max ${SSE_MAX_PER_IP})` });
    return;
  }
  sseConnCount.set(ip, cur + 1);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const n = sseConnCount.get(ip) ?? 1;
    if (n <= 1) sseConnCount.delete(ip);
    else sseConnCount.set(ip, n - 1);
  };
  res.on('close', release);
  res.on('finish', release);
  next();
};
