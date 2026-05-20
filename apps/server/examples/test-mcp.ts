/**
 * MCP 集成测：
 *   起一个最小 MCP server（用官方 SDK 自带的 Server + InMemoryTransport），暴露 1 个工具；
 *   MCPManager 用对应 transport 连上去 → listTools → callTool。
 *   绕开 .mcp.json，直接复用内部逻辑。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolSpec } from '../src/types.js';
import { ToolRegistry } from '../src/tools/registry.js';

let pass = 0, fail = 0;
function expect(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`✓ ${name}`); pass++; }
  else { console.log(`✗ ${name}${detail ? ` —— ${detail}` : ''}`); fail++; }
}

// ─── 起一个最小 MCP server ───
const server = new Server(
  { name: 'test-mcp', version: '0.0.1' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: 'Echoes back the input',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'echo') throw new Error('unknown tool');
  const text = (req.params.arguments as { text?: string } | undefined)?.text ?? '';
  return { content: [{ type: 'text', text: `ECHO:${text}` }] };
});

// 双向 in-memory transport
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);

// ─── 用 MCPManager 同款逻辑包装这个 client：listTools → ToolSpec → registry ───
const client = new Client({ name: 'mas-test', version: '0.0.1' });
await client.connect(clientTransport);

const tools = await client.listTools();
expect('listTools 拿到 1 个工具', tools.tools.length === 1);
expect('工具名 echo', tools.tools[0]?.name === 'echo');
expect('description 透传', tools.tools[0]?.description === 'Echoes back the input');

// 复刻 MCPManager 包装逻辑：名字加 mcp__<server>__<tool> 前缀
const registry = new ToolRegistry();
for (const t of tools.tools) {
  const spec: ToolSpec = {
    name: `mcp__test-mcp__${t.name}`,
    description: t.description || '',
    parameters: (t.inputSchema ?? {}) as object,
    allowedAgents: ['conductor'],
    handler: async (input: unknown) => {
      return client.callTool({ name: t.name, arguments: (input ?? {}) as Record<string, unknown> });
    },
  };
  registry.register(spec);
}

const specs = registry.specsFor('conductor');
expect('注册到 registry 1 条', specs.length === 1);
expect('完整名字 mcp__test-mcp__echo', specs[0]?.name === 'mcp__test-mcp__echo');

// ─── 通过 registry 调用，模拟 conductor 调 MCP 工具 ───
const result = await registry.invoke('mcp__test-mcp__echo', { text: 'hi' });
const r = result as { content: Array<{ type: string; text: string }> };
expect('调用结果有 content', Array.isArray(r.content));
expect('content[0].text == ECHO:hi', r.content[0]?.text === 'ECHO:hi');

// ─── 调用不存在的工具应抛错 ───
let threw = false;
try {
  await registry.invoke('mcp__test-mcp__nonexistent', {});
} catch { threw = true; }
expect('未知工具抛错（不会被 register）', threw);

// 清理
await client.close();
await server.close();

console.log(`\n${fail === 0 ? '全部通过 ✅' : `失败 ${fail} 条 ❌`}`);
if (fail > 0) process.exit(1);
