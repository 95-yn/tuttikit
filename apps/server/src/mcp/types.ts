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

  /**
   * 安全控制：
   *   - trusted: false（默认）时必须给出 allowTools 白名单，server 暴露的其他 tool 不会被注册。
   *   - trusted: true 时跳过 allowTools 检查，等价于完全信任（仅用于自己写的本地 MCP）。
   */
  trusted?: boolean;
  /** 允许注册的 MCP 端工具名（不含 mcp__<server>__ 前缀） */
  allowTools?: string[];
  /** 阻断 MCP server 覆盖系统内置 tool 名时的额外说明，可选 */
  notes?: string;
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
