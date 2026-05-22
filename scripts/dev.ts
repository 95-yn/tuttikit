#!/usr/bin/env tsx
// 一键启动 server (3001) + web (3000)。
//   - 启动前检查端口；如果被「我们上次没退干净的 dev 进程」占着 → 自动清
//   - 如果被「别的应用」占着 → 打印警告并退出，让你自己决定
//   - 启动后把 LAN URL banner 打印出来（手机扫码用）
//   - 子进程退出 / Ctrl+C 一并清理
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';

const PORTS = { web: 3000, server: 3001 } as const;
// 进程名包含以下子串视为「我们自己的」可清；防止误杀别的开发服务
const OWN_PROCESS_HINTS = ['tsx', 'next-server', 'next dev', 'next start', 'multi-agent', 'pnpm'];

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};

function findPidsOnPort(port: number): number[] {
  // 仅检测 LISTEN 状态，避免把浏览器 keep-alive 客户端连接误判成「端口被占」
  const r = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8' });
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map(Number);
}

function pidCmdline(pid: number): string {
  // ps -o command= 兼容 macOS / Linux
  const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

async function freePort(label: string, port: number): Promise<boolean> {
  const pids = findPidsOnPort(port);
  if (!pids.length) return true;

  const conflicts: Array<{ pid: number; cmd: string }> = [];
  const ownPids: Array<{ pid: number; cmd: string }> = [];
  for (const pid of pids) {
    const cmd = pidCmdline(pid);
    const isOurs = OWN_PROCESS_HINTS.some((h) => cmd.includes(h));
    (isOurs ? ownPids : conflicts).push({ pid, cmd });
  }

  if (conflicts.length) {
    console.error(`${C.red}✗ 端口 ${port} (${label}) 被「非本项目进程」占用：${C.reset}`);
    for (const { pid, cmd } of conflicts) {
      console.error(`  ${C.dim}PID ${pid}:${C.reset} ${cmd.slice(0, 120)}`);
    }
    console.error(`${C.yellow}请手动停掉这些进程，或修改 PORT/web 端口后重试。${C.reset}`);
    return false;
  }

  if (ownPids.length) {
    console.log(`${C.yellow}⚠${C.reset}  端口 ${port} (${label}) 被上次未退干净的 dev 进程占用，清理：`);
    for (const { pid, cmd } of ownPids) {
      console.log(`   ${C.dim}kill PID ${pid}:${C.reset} ${cmd.slice(0, 100)}`);
      try { process.kill(pid, 'SIGTERM'); } catch {/* ignore */}
    }
    await new Promise((r) => setTimeout(r, 500));
    for (const { pid } of ownPids) {
      try { process.kill(pid, 'SIGKILL'); } catch {/* already dead */}
    }
    if (findPidsOnPort(port).length) {
      console.error(`${C.red}✗ 清理后端口 ${port} 仍被占用${C.reset}`);
      return false;
    }
    console.log(`${C.green}✓${C.reset} 端口 ${port} 已释放`);
  }
  return true;
}

function findLanIp(): string | null {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    if (!ifaces) continue;
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

function printBanner(): void {
  const lan = findLanIp();
  const local = `http://localhost:${PORTS.web}`;
  const lanUrl = lan ? `http://${lan}:${PORTS.web}` : null;
  const lines = [
    '',
    `${C.dim}┌───────────────────────────────────────────────────────────${C.reset}`,
    `${C.dim}│${C.reset}  ${C.bold}TuttiKit${C.reset} ${C.dim}— 已就绪${C.reset}`,
    `${C.dim}│${C.reset}`,
    `${C.dim}│${C.reset}  ${C.cyan}前端${C.reset}        ${local}    ${C.dim}← 浏览器进这个${C.reset}`,
    `${C.dim}│${C.reset}  ${C.cyan}后端${C.reset}        http://localhost:${PORTS.server}    ${C.dim}← API + SSE${C.reset}`,
  ];
  if (lanUrl) {
    lines.push(
      `${C.dim}│${C.reset}  ${C.green}局域网${C.reset}  📱  ${C.bold}${lanUrl}${C.reset}   ${C.dim}← 手机用这个${C.reset}`,
      `${C.dim}│${C.reset}              ${C.dim}（页面右下角 QR 可直接扫）${C.reset}`,
    );
  } else {
    lines.push(`${C.dim}│${C.reset}  ${C.yellow}未检测到局域网 IP（无线断开？）${C.reset}`);
  }
  lines.push(
    `${C.dim}│${C.reset}`,
    `${C.dim}│${C.reset}  按 ${C.bold}Ctrl+C${C.reset} 停止全部`,
    `${C.dim}└───────────────────────────────────────────────────────────${C.reset}`,
    '',
  );
  console.log(lines.join('\n'));
}

// ───── main ─────
console.log(`${C.dim}→ 检查端口占用...${C.reset}`);
const okWeb = await freePort('web', PORTS.web);
const okSrv = await freePort('server', PORTS.server);
if (!okWeb || !okSrv) process.exit(1);

printBanner();

const child = spawn('pnpm', ['-r', '--parallel', '--stream', 'run', 'dev'], {
  stdio: 'inherit',
  shell: false,
  env: { ...process.env, FORCE_COLOR: '1' },
});

const forward = (sig: NodeJS.Signals) => (): void => {
  if (!child.killed) child.kill(sig);
};
process.on('SIGINT', forward('SIGINT'));
process.on('SIGTERM', forward('SIGTERM'));

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
