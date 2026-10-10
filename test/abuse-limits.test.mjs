// Before anything is public: the agent door is rate-limited like the chat door, one caller cannot hold the whole
// calendar, and the client IP comes from Cloudflare's header only when TRUST_PROXY says we are behind the tunnel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer, MCP_LIMITS } from '../src/mcp-server.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { PROFILES } from './profiles.mjs';

const NOW = '2026-10-04T08:00:00+03:00'; // Sunday, before opening
const ORDER = PROFILES[0].order;
const SLOTS = ['10', '11', '12', '14', '15'].map((h) => `2026-10-06T${h}:00:00+03:00`);
const big = { requests: 10_000, windowMs: 60_000 };
const limits = (over) => ({ perIp: big, global: big, newSessionsPerIp: { count: 10_000, windowMs: 60_000 }, ...over });

async function open({ mcpLimits = limits({}), trustProxy, store = createMemoryStore() } = {}) {
  const desk = createDesk({ store, now: () => new Date(NOW) });
  const server = createHttpServer({ desk, mcpLimits, trustProxy });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { url, store, close: () => new Promise((resolve) => server.close(resolve)) };
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'limits-test', version: '0' } } };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const post = (url, body, ip) => fetch(url, { method: 'POST', body: JSON.stringify(body), headers: {
  'content-type': 'application/json', accept: 'application/json, text/event-stream',
  ...(ip ? { 'cf-connecting-ip': ip } : {}) } });

test('the agent door has limits of its own, in one place', () => {
  for (const key of ['perIp', 'global', 'newSessionsPerIp']) assert.ok(MCP_LIMITS[key], key);
});

test('/mcp: past the per-IP limit the answer is 429 with retry-after', async () => {
  const door = await open({ mcpLimits: limits({ perIp: { requests: 3, windowMs: 60_000 } }) });
  try {
    for (let i = 0; i < 3; i += 1) assert.notEqual((await post(door.url, INIT)).status, 429, `request ${i + 1}`);
    const over = await post(door.url, INIT);
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers.get('retry-after')) >= 1);
  } finally { await door.close(); }
});

test('/mcp: past the global limit everyone gets 429, whatever their IP', async () => {
  const door = await open({ trustProxy: 'cloudflare', mcpLimits: limits({ global: { requests: 2, windowMs: 60_000 } }) });
  try {
    assert.notEqual((await post(door.url, INIT, '203.0.113.1')).status, 429);
    assert.notEqual((await post(door.url, INIT, '203.0.113.2')).status, 429);
    assert.equal((await post(door.url, INIT, '203.0.113.3')).status, 429);
  } finally { await door.close(); }
});

test('/mcp: new sessions (initialize) per IP have their own limit; other requests still pass', async () => {
  const door = await open({ mcpLimits: limits({ newSessionsPerIp: { count: 2, windowMs: 60_000 } }) });
  try {
    assert.notEqual((await post(door.url, INIT)).status, 429);
    assert.notEqual((await post(door.url, INIT)).status, 429);
    assert.equal((await post(door.url, INIT)).status, 429);
    assert.notEqual((await post(door.url, LIST)).status, 429);
  } finally { await door.close(); }
});

test('a spoofed CF-Connecting-IP is ignored unless TRUST_PROXY=cloudflare', async () => {
  const perIp = limits({ perIp: { requests: 2, windowMs: 60_000 } });
  const direct = await open({ mcpLimits: perIp });
  try { // three "different" IPs from one socket: the header is ignored, so the third is over the limit
    assert.notEqual((await post(direct.url, INIT, '198.51.100.1')).status, 429);
    assert.notEqual((await post(direct.url, INIT, '198.51.100.2')).status, 429);
    assert.equal((await post(direct.url, INIT, '198.51.100.3')).status, 429);
  } finally { await direct.close(); }
  const tunnel = await open({ mcpLimits: perIp, trustProxy: 'cloudflare' });
  try { // behind the tunnel the header is the client, so three IPs are three buckets
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) assert.notEqual((await post(tunnel.url, INIT, ip)).status, 429, ip);
  } finally { await tunnel.close(); }
});

test('one caller holds at most 3 bookings at once; the 4th is refused politely and handed to a person', async () => {
  const door = await open();
  const client = new Client({ name: 'limits-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(door.url)));
  const book = (slot) => client.callTool({ name: 'book', arguments: { ...ORDER, slot, customer_name: 'Test', contact: 'test@example.com' } });
  try {
    for (const slot of SLOTS.slice(0, 3)) assert.ok(!(await book(slot)).isError, slot);
    const fourth = await book(SLOTS[3]);
    assert.equal(fourth.isError, true);
    const out = JSON.parse(fourth.content[0].text);
    assert.equal(out.error.code, 'booking_limit');
    assert.match(out.handover.tell_customer_en, /reply to you personally/);
    assert.equal(door.store.all('bookings').length, 3);
    assert.equal(door.store.all('handovers').at(-1).reason_given, 'booking_limit');
  } finally { await client.close(); await door.close(); }
});

test('the cap counts only bookings still holding a slot: an expired hold frees it, other callers are not affected', () => {
  let t = Date.parse(NOW);
  const desk = createDesk({ store: createMemoryStore(), now: () => new Date(t) });
  const book = (slot, client) => desk.book({ ...ORDER, slot, customer_name: 'Test', contact: 'test@example.com' }, { door: 'agent', client });
  for (const slot of SLOTS.slice(0, 3)) assert.equal(book(slot, 'a').ok, true);
  assert.equal(book(SLOTS[3], 'a').error.code, 'booking_limit');
  assert.equal(book(SLOTS[3], 'b').ok, true);
  t += 31 * 60_000; // the 30-minute holds run out unpaid
  assert.equal(book(SLOTS[4], 'a').ok, true);
});

// E3b: a JSON-RPC batch must not carry many calls past the per-request limits. The protocol revision 2025-06-18
// dropped batching and our clients never batch, so a batch of more than one message is refused outright.
test('/mcp: a 20-message batch from one IP cannot get past a per-IP limit of 5: it is refused with 400', async () => {
  const door = await open({ mcpLimits: limits({ perIp: { requests: 5, windowMs: 60_000 } }) });
  try {
    const batch = Array.from({ length: 20 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call',
      params: { name: 'book', arguments: { ...ORDER, slot: SLOTS[i % SLOTS.length], customer_name: 'Batch', contact: 'b@example.com' } } }));
    const res = await post(door.url, batch);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, -32600);
    assert.equal(door.store.all('bookings').length, 0);
  } finally { await door.close(); }
});

// E3b: the same 3-bookings cap per caller on the human door. The scripted model books once per turn, on a new slot.
function bookingModel() {
  let n = 0;
  return { async complete({ messages }) {
    const message = messages.some((m) => m.role === 'tool') ? { role: 'assistant', content: 'Done.' }
      : { role: 'assistant', content: null, tool_calls: [{ id: `b${n}`, type: 'function', function: { name: 'book',
        arguments: JSON.stringify({ ...ORDER, slot: SLOTS[n++ % SLOTS.length], customer_name: 'Chat', contact: 'c@example.com' }) } }] };
    return { message, modelId: 'fake/scripted' };
  } };
}

test('chat door: one IP holds at most 3 bookings; the 4th chat is refused and handed to a person', async () => {
  const store = createMemoryStore();
  const desk = createDesk({ store, now: () => new Date(NOW) });
  const server = createHttpServer({ desk, model: bookingModel(), lang: 'en' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const chat = (message) => fetch(`http://127.0.0.1:${server.address().port}/chat`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
  try {
    for (let i = 0; i < 4; i += 1) assert.equal((await chat(`Book me, turn ${i + 1}`)).status, 200);
    assert.equal(store.all('bookings').length, 3);
    assert.ok(store.all('bookings').every((b) => b.door === 'human'));
    assert.equal(store.all('handovers').at(-1)?.reason_given, 'booking_limit');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
