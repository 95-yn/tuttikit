import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from '../observability/logger.js';
import type { ToolSpec } from '../types.js';
import type { McpServerConfig, McpConfig, McpServerStatus } from './types.js';

const TOOL_PREFIX = 'mcp__';                  // mcp__<server>__<tool>
const CALL_TIMEOUT_MS = 30_000;

interface ClientHandle {
  name: string;
  client: Client;
  transport: 'stdio' | 'http';
  specs: ToolSpec[];                          // 这个 server 暴露的 tool specs（已加 mcp__server__ 前缀）
}

/**
 * MCPManager —— 启动期加载 .mcp.json，对每个 server：
 *   - stdio：spawn 子进程
 *   - http/sse：StreamableHTTPClientTransport
 *   连接后 listTools，把每个 tool 包装成 ToolSpec 缓存起来。
 *   失败的 server 跳过 + warn，不阻断启动。
 *
 * 设计：MCP client 是长连接（boot 一次，进程退出时 close）；ToolSpec 只是缓存，
 * 每次 buildToolRegistryWithSubAgents 调 getToolSpecs() 拿过去注册到新 registry。
 */
export class MCPManager {
  private clients: ClientHandle[] = [];
  private statuses: McpServerStatus[] = [];

  async init(): Promise<void> {
    const config = this.loadConfig();
    if (!config) {
      logger.info('[mcp] 未找到 .mcp.json，跳过 MCP 初始化');
      return;
    }

    const entries = Object.entries(config.mcpServers || {});
    if (!entries.length) {
      logger.info('[mcp] mcpServers 为空，跳过');
      return;
    }

    logger.info({ count: entries.length, names: entries.map(([n]) => n) }, '[mcp] 开始连接 MCP servers');

    // 并发连接所有 server（一个慢的不阻塞其他的）
    await Promise.all(entries.map(([name, cfg]) => this.connectServer(name, cfg)));

    logger.info({ connected: this.clients.length, statuses: this.statuses }, '[mcp] 初始化完成');
  }

  /** 拿到所有已连接 server 的工具 specs，给 buildToolRegistryWithSubAgents 用 */
  getToolSpecs(): ToolSpec[] {
    return this.clients.flatMap((h) => h.specs);
  }

  /** 读 .mcp.json：先 user-global 后 project（项目级从 cwd 向上找，兼容 monorepo） */
  private loadConfig(): McpConfig | null {
    const projectFile = findUpwards('.mcp.json');
    const candidates = [
      path.join(os.homedir(), '.claude/mcp.json'),   // user-global 先
      projectFile,                                     // project-local 后（覆盖）
    ].filter(Boolean) as string[];
    let merged: McpConfig | null = null;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as McpConfig;
        if (!merged) merged = { mcpServers: {} };
        for (const [k, v] of Object.entries(parsed.mcpServers || {})) {
          merged.mcpServers[k] = v;
        }
      } catch (err) {
        logger.warn({ err, file }, '[mcp] 配置文件解析失败');
      }
    }
    return merged;
  }

  private async connectServer(name: string, cfg: McpServerConfig): Promise<void> {
    const transport = cfg.command ? 'stdio' : (cfg.url ? 'http' : null);
    if (!transport) {
      this.statuses.push({ name, transport: 'stdio', state: 'failed', toolCount: 0, error: '配置缺 command 或 url' });
      logger.warn({ name }, '[mcp] 配置缺 command/url，跳过');
      return;
    }

    try {
      const client = new Client({ name: 'tuttikit', version: '0.1.0' });

      if (transport === 'stdio') {
        const stdio = new StdioClientTransport({
          command: cfg.command!,
          args: cfg.args ?? [],
          env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
        });
        await client.connect(stdio);
      } else {
        const httpTransport = new StreamableHTTPClientTransport(new URL(cfg.url!), {
          requestInit: { headers: cfg.headers },
        });
        await client.connect(httpTransport);
      }

      const tools = await client.listTools();
      const specs: ToolSpec[] = [];

      for (const t of tools.tools ?? []) {
        const fullName = `${TOOL_PREFIX}${name}__${t.name}`;
        specs.push({
          name: fullName,
          description: t.description || `(MCP) ${t.name}`,
          parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as object,
          allowedAgents: ['conductor'],
          handler: async (input: unknown) => {
            return Promise.race([
              client.callTool({ name: t.name, arguments: (input ?? {}) as Record<string, unknown> }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`MCP 工具 ${fullName} 调用超时 (${CALL_TIMEOUT_MS}ms)`)), CALL_TIMEOUT_MS)),
            ]);
          },
        });
      }

      this.clients.push({ name, client, transport, specs });
      this.statuses.push({ name, transport, state: 'connected', toolCount: specs.length });
      logger.info({ name, transport, toolCount: specs.length }, '[mcp] server 已连接');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.statuses.push({ name, transport, state: 'failed', toolCount: 0, error: msg });
      logger.warn({ name, transport, err: msg }, '[mcp] server 连接失败，跳过');
    }
  }

  /** 进程退出时清理（在 SIGINT/SIGTERM 调） */
  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map(async (h) => {
      try { await h.client.close(); } catch {/* ignore */}
    }));
    this.clients = [];
    logger.info('[mcp] 全部 client 已关闭');
  }

  getStatuses(): McpServerStatus[] {
    return [...this.statuses];
  }
}

export const mcpManager = new MCPManager();

/** 从 cwd 一路向上找最近的指定相对路径（兼容 monorepo 子目录 cwd） */
function findUpwards(rel: string): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
