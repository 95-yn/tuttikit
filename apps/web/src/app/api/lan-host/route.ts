import os from 'node:os';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * 返回本机第一个非环回 IPv4 拼出的 URL，前端拿去画二维码。
 * 没有 LAN（譬如断网）时 lanUrl 为 null。
 */
export function GET(req: Request) {
  const port = Number(process.env.PORT || 3000);

  let lanIp: string | null = null;
  for (const ifaces of Object.values(os.networkInterfaces())) {
    if (!ifaces) continue;
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) {
        lanIp = i.address;
        break;
      }
    }
    if (lanIp) break;
  }

  const url = new URL(req.url);
  return NextResponse.json({
    lanUrl: lanIp ? `http://${lanIp}:${port}` : null,
    currentUrl: `${url.protocol}//${url.host}`,
  });
}
