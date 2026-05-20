/** .mcp.json 单条 server 配置 */
export interface McpServerConfig {
  // 任选一种传输：
  // stdio：本地子进程
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http/sse：远端
  url?: string;
  headers?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http';
  state: 'connected' | 'failed' | 'closed';
  toolCount: number;
  error?: string;
}
