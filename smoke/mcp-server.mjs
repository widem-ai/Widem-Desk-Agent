// Day-1 smoke test: minimal remote MCP server (Streamable HTTP, stateless) with one tool.
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

function build() {
  const s = new McpServer({ name: 'widem-agent-desk-smoke', version: '0.0.1' });
  s.tool('list_services', 'List the services of the demo career studio (fictional).', {}, async () => ({
    content: [{ type: 'text', text: JSON.stringify([
      { id: 'cv_rewrite', name: 'CV rewrite' }, { id: 'linkedin_profile', name: 'LinkedIn profile' },
      { id: 'interview_coaching', name: 'Interview coaching' }]) }] }));
  s.tool('quote', 'Price a service for a customer (demo prices).',
    { service: z.enum(['cv_rewrite', 'linkedin_profile', 'interview_coaching']), seniority: z.enum(['junior', 'mid', 'senior', 'executive']) },
    async ({ service, seniority }) => ({ content: [{ type: 'text', text: JSON.stringify({ service, seniority, price_sar: 'demo-only' }) }] }));
  return s;
}
http.createServer(async (req, res) => {
  if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
  let body = ''; for await (const c of req) body += c;
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => t.close());
  await build().connect(t);
  await t.handleRequest(req, res, body ? JSON.parse(body) : undefined);
}).listen(8790, '127.0.0.1', () => console.log('MCP smoke on http://127.0.0.1:8790/mcp'));
