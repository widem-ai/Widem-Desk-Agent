// The agent door: a remote MCP server (Streamable HTTP, stateless) for customers' AI agents.
// Each tool calls the core and nothing else, so an agent gets exactly what a person would.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { listServices, quote } from './core.mjs';

const MAX_BODY_BYTES = 64 * 1024;

const asResult = (value, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

export function createMcpServer() {
  const server = new McpServer({ name: 'widem-agent-desk', version: '0.1.0' });

  server.registerTool('list_services', {
    title: 'List services',
    description: 'List everything this career-services studio offers (a fictional demo business): services with '
      + 'English and Arabic names, the price for each tier (junior, mid, senior, executive) in SAR, bundles and '
      + 'add-ons. Call this first, then use the ids it returns in quote.',
    inputSchema: {},
  }, async () => asResult(listServices()));

  server.registerTool('quote', {
    title: 'Quote a price',
    description: 'Price an order for one customer. Pass the service ids from list_services, the customer tier '
      + '(junior, mid, senior or executive, by years of experience) and any add-on ids. Returns an itemised '
      + 'quote with bundle discounts applied, or a refusal with a reason code when the request is outside '
      + 'the rules. Never invent a price: quote the total exactly as returned.',
    inputSchema: {
      services: z.array(z.string()).describe('Service ids, e.g. ["cv_rewrite", "linkedin_profile"]'),
      tier: z.string().describe('junior | mid | senior | executive'),
      addons: z.array(z.string()).optional().describe('Add-on ids, e.g. ["express"]'),
    },
  }, async (args) => {
    const result = quote(args);
    return asResult(result, !result.ok);
  });

  return server;
}

function sendJson(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message }, id: null }));
}

export function createHttpServer() {
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
      await createMcpServer().connect(transport);
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
  createHttpServer().listen(port, host, () => console.log(`Agent door (MCP) on http://${host}:${port}/mcp`));
}
