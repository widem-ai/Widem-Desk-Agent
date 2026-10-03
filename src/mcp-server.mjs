// The agent door: a remote MCP server (Streamable HTTP, stateless) for customers' AI agents.
// Each tool calls the core and nothing else, so an agent gets exactly what a person would.
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createDesk } from './desk.mjs';
import { TOOLS, toZodShape } from './tools.mjs';
import { createChat, createNebiusModel, sorryReply } from './chat.mjs';
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

const send = (res, status, value) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

/** Read a JSON body up to MAX_BODY_BYTES. On a bad body it answers with fail(status, message) and returns { done: true }. */
async function readJson(req, fail) {
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { fail(413, 'Request too large'); return { done: true }; }
    body += chunk;
  }
  if (!body) return { value: undefined };
  try { return { value: JSON.parse(body) }; } catch { fail(400, 'Parse error: body is not JSON'); return { done: true }; }
}

const MAX_SESSIONS = 500;
const MAX_MESSAGE_CHARS = 4000;

/** The human door over HTTP: POST /chat { sessionId, message } -> { reply, booked?, handover? }.
 * Each session's history is kept in memory (lost on restart; the oldest session goes past MAX_SESSIONS). */
function createChatRoute(desk, model) {
  const chat = model ? createChat({ desk, model }) : null;
  const sessions = new Map();
  return async (req, res) => {
    const fail = (status, message, code = 'bad_request') => send(res, status, { error: { code, message } });
    if (req.method !== 'POST') { fail(405, 'Use POST', 'method_not_allowed'); return; }
    const body = await readJson(req, fail);
    if (body.done) return;
    const { sessionId, message } = body.value ?? {};
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 100
      || typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_CHARS) {
      fail(400, `Send { sessionId, message } as strings (sessionId up to 100, message up to ${MAX_MESSAGE_CHARS} characters).`);
      return;
    }
    if (!chat) { send(res, 503, { error: { code: 'chat_not_configured' }, reply: sorryReply(message) }); return; }
    let out;
    try {
      out = await chat.respond(sessions.get(sessionId) ?? [], message);
    } catch (err) {
      const code = err?.code === 'model_timeout' ? 'model_timeout' : 'model_error';
      console.error('chat turn failed:', code, err?.message);
      send(res, 503, { error: { code }, reply: sorryReply(message) }); // the failed turn is not kept
      return;
    }
    sessions.delete(sessionId);
    sessions.set(sessionId, out.history);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const booked = out.toolCalls.findLast((c) => c.name === 'book' && c.result?.ok)?.result.booking;
    const handover = out.handover ?? out.toolCalls.findLast((c) => c.result?.handover)?.result.handover;
    send(res, 200, { reply: out.reply.replace(/^(\s*\n)+/, ''), ...(booked ? { booked } : {}), ...(handover ? { handover } : {}) });
  };
}

/** Both doors over one desk: the agent door at /mcp and, when a model is given, the human door at /chat.
 * Without a desk it runs on a memory store (nothing is kept). */
export function createHttpServer({ desk = createDesk({ store: createMemoryStore() }), model } = {}) {
  const chatRoute = createChatRoute(desk, model);
  return http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/chat') {
      try { await chatRoute(req, res); } catch (err) {
        console.error('chat request failed:', err);
        if (!res.headersSent) send(res, 500, { error: { code: 'internal_error' } });
      }
      return;
    }
    if (path !== '/mcp') { res.writeHead(404).end(); return; }
    try {
      const body = await readJson(req, (status, message) => sendJson(res, status, message));
      if (body.done) return;
      const parsed = body.value;
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
  const model = process.env.NEBIUS_API_KEY && process.env.NEBIUS_BASE_URL ? createNebiusModel() : undefined;
  console.log(model ? 'Human door (chat) uses the model on Nebius Token Factory' : 'Human door (chat) is off: NEBIUS_API_KEY or NEBIUS_BASE_URL is not set');
  createHttpServer({ desk, model }).listen(port, host, () => console.log(`Agent door (MCP) on http://${host}:${port}/mcp`));
}
