// The agent door: a remote MCP server (Streamable HTTP, stateless) for customers' AI agents.
// Each tool calls the core and nothing else, so an agent gets exactly what a person would.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
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

/** Limits on the human door, in one place (acceptance A7: the model credit is protected). */
export const CHAT_LIMITS = {
  perIp: { messages: 20, windowMs: 10 * 60_000 }, // one customer
  global: { messages: 60, windowMs: 60_000 }, // everyone together
  newSessionsPerIp: { count: 5, windowMs: 10 * 60_000 }, // so a flood cannot push real sessions out
  maxSessions: 500, // past this the least recently used session is dropped
  maxHistoryMessages: 40, // per session; the oldest turns are trimmed (the system prompt is added fresh each turn)
};
const MAX_MESSAGE_CHARS = 4000;
const BUSY_REPLY = 'Too many messages for now. Please try again in a few minutes.\n'
  + 'عدد الرسائل كبير الآن. يرجى المحاولة مرة أخرى بعد بضع دقائق.';

/** Token buckets by key: each holds up to size tokens and refills size per windowMs, continuously. */
function createBuckets(size, windowMs, now) {
  const buckets = new Map();
  return {
    /** Take one token for key: 0 when allowed, otherwise the seconds until one is free. */
    take(key) {
      const t = now();
      const b = buckets.get(key) ?? { tokens: size, at: t };
      b.tokens = Math.min(size, b.tokens + ((t - b.at) * size) / windowMs);
      b.at = t;
      buckets.delete(key);
      buckets.set(key, b);
      if (buckets.size > 10_000) buckets.delete(buckets.keys().next().value);
      if (b.tokens >= 1) { b.tokens -= 1; return 0; }
      return Math.max(1, Math.ceil(((1 - b.tokens) * windowMs) / size / 1000));
    },
  };
}

/** Keep the newest messages, starting at a customer message so no tool result loses its call. */
function trimHistory(history, max) {
  if (history.length <= max) return history;
  const kept = history.slice(-max);
  const first = kept.findIndex((m) => m.role === 'user');
  return first === -1 ? [] : kept.slice(first);
}

/** The human door over HTTP: POST /chat { sessionId?, message } -> { sessionId, reply, booked?, handover? }.
 * The server issues session ids (send none to start); an id it did not issue gets a 400, never another
 * session's history. History lives in memory and is lost on restart. */
function createChatRoute(desk, model, limits, now) {
  const chat = model ? createChat({ desk, model }) : null;
  const sessions = new Map();
  const perIp = createBuckets(limits.perIp.messages, limits.perIp.windowMs, now);
  const global = createBuckets(limits.global.messages, limits.global.windowMs, now);
  const newSessions = createBuckets(limits.newSessionsPerIp.count, limits.newSessionsPerIp.windowMs, now);
  return async (req, res) => {
    const fail = (status, message, code = 'bad_request') => send(res, status, { error: { code, message } });
    if (req.method !== 'POST') { fail(405, 'Use POST', 'method_not_allowed'); return; }
    const body = await readJson(req, fail);
    if (body.done) return;
    const { sessionId, message } = body.value ?? {};
    if ((sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > 100))
      || typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_CHARS) {
      fail(400, `Send { message } (up to ${MAX_MESSAGE_CHARS} characters) and, after the first reply, the sessionId it gave you.`);
      return;
    }
    if (sessionId !== undefined && !sessions.has(sessionId)) {
      fail(400, 'This chat has ended. Send the message without a sessionId to start a new one.', 'unknown_session');
      return;
    }
    if (!chat) { send(res, 503, { error: { code: 'chat_not_configured' }, reply: sorryReply(message) }); return; }
    const ip = req.socket.remoteAddress ?? 'unknown';
    const wait = perIp.take(ip) || (sessionId === undefined && newSessions.take(ip)) || global.take('all');
    if (wait) {
      res.setHeader('retry-after', String(wait));
      send(res, 429, { error: { code: 'rate_limited' }, reply: BUSY_REPLY });
      return;
    }
    const id = sessionId ?? randomUUID();
    let out;
    try {
      out = await chat.respond(sessions.get(id) ?? [], message);
    } catch (err) {
      const code = err?.code === 'model_timeout' ? 'model_timeout' : 'model_error';
      console.error('chat turn failed:', code, err?.message);
      send(res, 503, { error: { code }, reply: sorryReply(message) }); // the failed turn is not kept
      return;
    }
    // Log English leaking into an Arabic reply (the words only, never the customer's message); the reply still goes out.
    if (out.latin?.length) console.warn(`chat reply: Latin words in an Arabic reply: ${out.latin.join(', ')}`);
    sessions.delete(id);
    sessions.set(id, trimHistory(out.history, limits.maxHistoryMessages));
    if (sessions.size > limits.maxSessions) sessions.delete(sessions.keys().next().value);
    const booked = out.booked ?? out.toolCalls.findLast((c) => c.name === 'book' && c.result?.ok)?.result.booking;
    const handover = out.handover ?? out.toolCalls.findLast((c) => c.result?.handover)?.result.handover;
    send(res, 200, { sessionId: id, reply: out.reply.replace(/^(\s*\n)+/, ''),
      ...(booked ? { booked } : {}), ...(handover ? { handover } : {}) });
  };
}

/** Both doors over one desk: the agent door at /mcp and, when a model is given, the human door at /chat.
 * Without a desk it runs on a memory store (nothing is kept). */
export function createHttpServer({ desk = createDesk({ store: createMemoryStore() }), model, limits = CHAT_LIMITS,
  now = Date.now } = {}) {
  const chatRoute = createChatRoute(desk, model, limits, now);
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
