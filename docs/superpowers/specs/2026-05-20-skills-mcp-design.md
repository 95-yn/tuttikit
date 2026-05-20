# Skills + MCP 接入 · 设计

**Status**: approved 2026-05-20
**Scope**: Conductor 启动期加载本地 Skills (Claude Code 同款格式) + 连接外部 MCP servers，统一暴露到 ToolRegistry

## 目标

让 tuttikit 在不改前端、不破坏现有 67 个测试断言的前提下，获得两条新能力：

1. **Skills** —— 本地 markdown 工作流指南（兼容 `~/.claude/skills/` 现有生态）
2. **MCP** —— 通过 [Model Context Protocol](https://modelcontextprotocol.io) 接入外部工具 server（stdio + HTTP/SSE）

## 架构

```
ConductorAgent
  ↑ specsFor('conductor')
  │
ToolRegistry  ←──── 原有 (calculator/web_search/file_*/delegate_*)
  ├── find_skills(query)        ← 新：列出匹配 skills 的 name+description
  ├── invoke_skill(name)        ← 新：加载 skill 正文到对话上下文
  └── mcp__<server>__<tool>     ← 新：每个 MCP server 的每个 tool 一条
        ↑
        │ proxy
        │
MCPManager (init at boot)       SkillsLoader (init at boot)
  ├── 读 .mcp.json (project)      ├── 扫 .claude/skills/*/SKILL.md
  ├── 读 ~/.claude/mcp.json       ├── 扫 ~/.claude/skills/*/SKILL.md
  ├── 项目盖全局                  ├── frontmatter (gray-matter)
  └── @modelcontextprotocol/sdk   └── 失败的跳过 + warn
```

启动期初始化失败不阻塞，只 warn 日志。

## 数据结构

```ts
// apps/server/src/skills/types.ts
interface SkillMeta {
  name: string;          // dir 名 (必须匹配 frontmatter.name 或缺省时用 dir 名)
  description: string;   // 一句话
  source: string;        // 文件绝对路径，调试用
}
interface Skill extends SkillMeta {
  body: string;          // markdown 正文
}
```

```ts
// apps/server/src/mcp/types.ts
interface McpServerConfig {
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http/sse
  url?: string;
  headers?: Record<string, string>;
}
type McpConfig = { mcpServers: Record<string, McpServerConfig> };
```

## 运行时流程

### Skills

1. `SkillsLoader.init()` 在 server boot 时同步执行（启动 < 100ms 可接受）
2. 每次 Conductor turn：system prompt 末尾自动追加 `[可用 Skills（共 N 个）: name1, name2, ...]`（只名字）
3. 模型调 `find_skills({query, k?})` → 关键词匹配 description，返回 top-k `{name, description}`
4. 模型调 `invoke_skill({name})` → tool 返回 `{name, content: <markdown body>}`，自然进入下一轮 context

### MCP

1. `MCPManager.init()` 在 boot 时 async（不阻塞 listen）
2. 读 `.mcp.json` (project) + `~/.claude/mcp.json` (user)，项目覆盖全局
3. 每个 server 用 `@modelcontextprotocol/sdk`：stdio 走 `StdioClientTransport`，http 走 `StreamableHTTPClientTransport`
4. `client.listTools()` 拿到工具清单，每个工具注册成 `ToolSpec`：
   - name: `mcp__<server>__<tool>`
   - description: 透传
   - parameters: 透传 inputSchema
   - allowedAgents: `['conductor']`
   - handler: `client.callTool({name: tool, arguments: input})`
5. 进程退出 / SIGINT → `client.close()` 全部释放

## 错误处理

| 场景 | 行为 |
| --- | --- |
| skill frontmatter 缺 `name` 或 `description` | warn + 跳过 |
| MCP server connect 失败 | warn + 跳过该 server，其他继续 |
| MCP tool call 超时（30s） | 返回 `{error: 'timeout'}` 给模型 |
| MCP server crash | 标记不可用，下次调用尝试一次重连 |

## 配置

无需 `.env` 改动。两个文件：
- `<project>/.mcp.json` — MCP servers (project 级)
- `<project>/.claude/skills/*/SKILL.md` — skills (project 级)
- `~/.claude/{mcp.json, skills/}` — 全局，自动 fallback

## 改动文件清单

**新增**
- `apps/server/src/skills/loader.ts` —— 扫描 + 解析
- `apps/server/src/skills/tools.ts` —— `find_skills` / `invoke_skill` 工具实现
- `apps/server/src/skills/types.ts`
- `apps/server/src/skills/index.ts`
- `apps/server/src/mcp/manager.ts` —— 连接 + tool 注册
- `apps/server/src/mcp/types.ts`
- `apps/server/src/mcp/index.ts`

**改动**
- `apps/server/src/tools/index.ts` — `buildToolRegistryWithSubAgents()` 接 skills + MCP
- `apps/server/src/agents/conductor.ts` — system prompt 末尾追加 skills 名单
- `apps/server/src/server.ts` — boot 时 init MCPManager
- `apps/server/package.json` — `@modelcontextprotocol/sdk` + `gray-matter`
- `STRUCTURE.md` — 加 skills/mcp 两组「我想…」

**新增配置范例**
- `.mcp.json.example` — 项目根

## 测试

- 单测：skills loader（合法 / 缺字段 / 不存在目录）
- 单测：MCP 配置 merge 逻辑（project 覆盖 user）
- 集成测：mock MCP server（用 SDK 自带的 test transport）连一个 → 列出工具 → 调用一个，断言 tool result 回传正确
- 不破坏 67 个原有断言

## YAGNI 明确不做的事

- ❌ Skills 自带脚本自动执行（用户/模型可以通过 `file_system_read` 看脚本内容，自动执行的安全代价不值）
- ❌ MCP server 做服务器端（只做 client）
- ❌ Skills 热更新（boot 后改文件需重启）
- ❌ MCP resources / prompts（只接 tools，先把核心走通）
- ❌ 多用户 skill 命名空间（单租户 demo）
