// The agent door: a remote MCP server (Streamable HTTP, stateless) for customers' AI agents.
// Each tool calls the core and nothing else, so an agent gets exactly what a person would.
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { listServices } from './core.mjs';
import { createDesk } from './desk.mjs';
import { createFileStore, createMemoryStore } from './store.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const AGENT = { door: 'agent' };

const asResult = (value, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

export function createMcpServer(desk) {
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
      + 'the rules. A request the rules cannot price is handed to a person automatically: the reply then '
      + 'includes a handover with what to tell the customer. Never invent a price: quote the total exactly as returned.',
    inputSchema: {
      services: z.array(z.string()).describe('Service ids, e.g. ["cv_rewrite", "linkedin_profile"]'),
      tier: z.string().describe('junior | mid | senior | executive'),
      addons: z.array(z.string()).optional().describe('Add-on ids, e.g. ["express"]'),
    },
  }, async (args) => {
    const result = desk.quote(args, AGENT);
    return asResult(result, !result.ok);
  });

  server.registerTool('check_availability', {
    title: 'Check free slots',
    description: 'List free 60-minute kickoff-call slots, in Asia/Riyadh time (UTC+3). Optionally pass from '
      + '(YYYY-MM-DD, default today in Riyadh) and days (1 to 7, default 7). Each slot has a start and end with '
      + 'the offset included; pass a start to book exactly as returned.',
    inputSchema: {
      from: z.string().optional().describe('First date to check, YYYY-MM-DD in Riyadh time'),
      days: z.number().optional().describe('How many days to check, 1 to 7'),
    },
  }, async (args) => {
    const result = desk.checkAvailability(args);
    return asResult(result, !result.ok);
  });

  server.registerTool('book', {
    title: 'Book a kickoff call',
    description: 'Book one customer into a free slot from check_availability. Pass the same services, tier and '
      + 'add-ons you quoted, the slot start exactly as returned, and the customer name and a contact (email or '
      + 'phone). The order is priced again by the same rules and the price is stored with the booking. Returns '
      + 'a booking reference, or a refusal with a reason code (slot_taken: pick another free slot).',
    inputSchema: {
      services: z.array(z.string()).describe('Service ids from list_services'),
      tier: z.string().describe('junior | mid | senior | executive'),
      addons: z.array(z.string()).optional().describe('Add-on ids, e.g. ["express"]'),
      slot: z.string().describe('A slot start from check_availability, e.g. "2026-10-05T11:00:00+03:00"'),
      customer_name: z.string().describe("The customer's name"),
      contact: z.string().describe('Email or phone number for the customer'),
    },
  }, async (args) => {
    const result = desk.book(args, AGENT);
    return asResult(result, !result.ok);
  });

  server.registerTool('handover', {
    title: 'Hand over to a person',
    description: 'Pass the customer to a person at the business. Use it when the customer asks for a person '
      + '(reason talk_to_a_person) or wants anything the rules do not cover, such as a discount, a complaint or '
      + 'an unusual case (reason out_of_rules). Returns what to tell the customer, in English and Arabic.',
    inputSchema: {
      reason: z.string().describe('talk_to_a_person | out_of_rules'),
      summary: z.string().optional().describe('One or two sentences on what the customer wants'),
      customer_name: z.string().optional().describe("The customer's name, if known"),
      contact: z.string().optional().describe('Email or phone number, if known'),
    },
  }, async (args) => asResult(desk.handover(args, AGENT)));

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
