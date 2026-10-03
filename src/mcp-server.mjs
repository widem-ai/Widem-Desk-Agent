// The agent door: a remote MCP server (Streamable HTTP, stateless) for customers' AI agents.
// Each tool calls the core and nothing else, so an agent gets exactly what a person would.
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createDesk } from './desk.mjs';
import { TOOLS, toZodShape } from './tools.mjs';
import { createFileStore, createMemoryStore } from './store.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const AGENT = { door: 'agent' };

const asResult = (value, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

export function createMcpServer(desk) {
  const server = new McpServer({ name: 'widem-agent-desk', version: '0.1.0' });
  for (const tool of TOOLS) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: toZodShape(tool.params, z),
    }, async (args) => {
      const result = tool.run(desk, args ?? {}, AGENT);
      return asResult(result, result?.ok === false);
    });
  }
  return server;
}

function sendJson(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message }, id: null }));
}

/** The agent door over a desk. Without one it runs on a memory store (nothing is kept). */
export function createHttpServer({ desk = createDesk({ store: createMemoryStore() }) } = {}) {
  return http.createServer(async (req, res) => {
    if (new URL(req.url, 'http://x').pathname !== '/mcp') { res.writeHead(404).end(); return; }
    try {
      let body = '';
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { sendJson(res, 413, 'Request too large'); return; }
        body += chunk;
      }
      let parsed;
      if (body) {
        try { parsed = JSON.parse(body); } catch { sendJson(res, 400, 'Parse error: body is not JSON'); return; }
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close());
      await createMcpServer(desk).connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      console.error('mcp request failed:', err);
      if (!res.headersSent) sendJson(res, 500, 'Internal error');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8790);
  const host = process.env.HOST ?? '127.0.0.1';
  const storeFile = process.env.DESK_STORE ?? fileURLToPath(new URL('../var/desk-store.json', import.meta.url));
  const desk = createDesk({ store: createFileStore(storeFile) });
  console.log(`Bookings and handovers are kept in ${storeFile}`);
  createHttpServer({ desk }).listen(port, host, () => console.log(`Agent door (MCP) on http://${host}:${port}/mcp`));
}
