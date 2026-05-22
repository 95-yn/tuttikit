import type { Express } from 'express';
import { mcpManager } from '../mcp/index.js';
import {
  translateMcpTools, readMcpTranslation, writeMcpTranslation, hashOfTools, shortToolName,
  type McpLang,
} from '../mcp/translator.js';

/**
 * MCP 状态查询 + 翻译 + 重连。
 *   GET  /mcp
 *   GET  /mcp/:name
 *   GET  /mcp/:name/translation
 *   POST /mcp/:name/translate
 *   POST /mcp/:name/reconnect
 */
export function register(app: Express): void {
  app.get('/mcp', (_req, res) => res.json(mcpManager.getStatuses()));
  app.get('/mcp/:name', (req, res) => {
    const s = mcpManager.getStatuses().find((x) => x.name === String(req.params.name));
    if (!s) return res.status(404).json({ error: 'mcp server not found' });
    const tools = mcpManager.getToolSpecs()
      .filter((t) => t.name.startsWith(`mcp__${req.params.name}__`))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    res.json({ ...s, tools });
  });
  /** GET: 已落盘的 MCP server 翻译 */
  app.get('/mcp/:name/translation', async (req, res) => {
    const lang = String(req.query.lang || 'zh') as McpLang;
    if (lang !== 'zh' && lang !== 'en') return res.status(400).json({ error: 'lang 必须是 zh 或 en' });
    const serverName = String(req.params.name);
    const status = mcpManager.getStatuses().find((s) => s.name === serverName);
    if (!status) return res.status(404).json({ error: 'mcp server not found' });
    const tools = mcpManager.getToolSpecs()
      .filter((t) => t.name.startsWith(`mcp__${serverName}__`))
      .map((t) => ({ fullName: t.name, shortName: shortToolName(t.name, serverName), description: t.description }));
    const saved = await readMcpTranslation(serverName, lang, hashOfTools(tools));
    if (!saved) return res.status(404).json({ error: 'no saved translation' });
    res.json(saved);
  });

  /** POST: 翻译这个 server 的所有 tool descriptions + displayName，落盘 */
  app.post('/mcp/:name/translate', async (req, res) => {
    const lang = String(req.query.lang || 'zh') as McpLang;
    if (lang !== 'zh' && lang !== 'en') return res.status(400).json({ error: 'lang 必须是 zh 或 en' });
    const serverName = String(req.params.name);
    const status = mcpManager.getStatuses().find((s) => s.name === serverName);
    if (!status) return res.status(404).json({ error: 'mcp server not found' });
    const tools = mcpManager.getToolSpecs()
      .filter((t) => t.name.startsWith(`mcp__${serverName}__`))
      .map((t) => ({ fullName: t.name, shortName: shortToolName(t.name, serverName), description: t.description }));
    if (tools.length === 0) {
      return res.json({ server: serverName, lang, displayNames: {}, descriptions: {}, path: '', tools: 0 });
    }
    const sourceHash = hashOfTools(tools);
    try {
      // 缓存命中
      const cached = await readMcpTranslation(serverName, lang, sourceHash);
      if (cached) return res.json({ ...cached, cached: true });
      const { displayNames, descriptions } = await translateMcpTools({ serverName, tools, lang });
      const result = {
        server: serverName, lang, sourceHash,
        savedAt: new Date().toISOString(),
        displayNames, descriptions,
      };
      const p = await writeMcpTranslation(result);
      res.json({ ...result, path: p, cached: false });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/mcp/:name/reconnect', async (req, res) => {
    try {
      const r = await mcpManager.reconnect(String(req.params.name));
      if (!r.ok) return res.status(404).json({ error: r.error || 'reconnect failed' });
      res.json(r);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
