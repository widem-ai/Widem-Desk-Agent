// The agent door: a real MCP client talks to the server over Streamable HTTP on a free port,
// and every answer must be exactly what the core returns for the same input.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/mcp-server.mjs';
import { listServices, quote } from '../src/core.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore, createFileStore } from '../src/store.mjs';
import { PROFILES } from './profiles.mjs';

const at = (iso) => () => new Date(iso);
const NOW = '2026-10-04T08:00:00+03:00'; // Sunday, before opening

// One running agent door over a given desk. Port 0: the OS picks a free one.
async function openDoor(desk) {
  const server = createHttpServer({ desk });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'agent-door-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  return {
    server,
    client,
    async close() { await client.close(); await new Promise((resolve) => server.close(resolve)); },
  };
}

let store;
let desk;
let server;
let client;
let door;

before(async () => {
  store = createMemoryStore();
  desk = createDesk({ store, now: at(NOW) });
  door = await openDoor(desk);
  ({ server, client } = door);
});

after(async () => { await door?.close(); });

const parse = (result) => JSON.parse(result.content[0].text);
const call = (name, args) => client.callTool({ name, arguments: args });

test('the agent door lists exactly the five tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['book', 'check_availability', 'handover', 'list_services', 'quote']);
  for (const t of tools) assert.ok(t.description.length > 20, `${t.name} needs a description an agent can act on`);
});

test('list_services over HTTP returns exactly the core result', async () => {
  const result = await call('list_services', {});
  assert.deepEqual(parse(result), listServices());
});

for (const p of PROFILES) {
  test(`quote over HTTP equals the core: ${p.name}`, async () => {
    const result = await call('quote', p.order);
    assert.ok(!result.isError);
    assert.deepEqual(parse(result), quote(p.input));
    assert.equal(parse(result).total, p.total);
  });
}

// Changed in slice 2 on purpose: an unpriceable request now also carries the automatic handover.
test('a refused quote over HTTP carries the core refusal and an automatic handover from the agent door', async () => {
  const input = { services: ['salary_negotiation'], years_experience: 10 };
  const before = store.all('handovers').length;
  const result = await call('quote', input);
  assert.equal(result.isError, true);
  const body = parse(result);
  assert.deepEqual(body.error, quote({ ...input, tier: 'senior' }).error); // the desk works out senior from 10 years
  assert.equal(body.handover.reason, 'unknown_service');
  const stored = store.all('handovers');
  assert.equal(stored.length, before + 1);
  assert.equal(stored.at(-1).door, 'agent');
  assert.equal(stored.at(-1).id, body.handover.id);
});

test('check_availability over HTTP equals the core for the same input', async () => {
  for (const input of [{ from: '2026-10-04', days: 2 }, {}]) {
    const result = await call('check_availability', input);
    assert.ok(!result.isError);
    assert.deepEqual(parse(result), desk.checkAvailability(input));
  }
  const bad = await call('check_availability', { from: 'tomorrow' });
  assert.equal(bad.isError, true);
  assert.equal(parse(bad).error.code, 'invalid_date');
});

test('book over HTTP records an agent booking at the quoted price and refuses the same slot twice', async () => {
  const slot = (await call('check_availability', { from: '2026-10-06', days: 1 })).content[0].text;
  const first = JSON.parse(slot).slots[0].start;
  const args = { ...PROFILES[3].order, slot: first, customer_name: 'Test Agent Customer', contact: 'agent@example.com' };
  const result = await call('book', args);
  assert.ok(!result.isError, result.content[0].text);
  const { booking } = parse(result);
  assert.equal(booking.door, 'agent');
  assert.equal(booking.price_quoted, PROFILES[3].total);
  assert.deepEqual(store.all('bookings').at(-1), booking);
  const again = await call('book', { ...args, customer_name: 'Second Agent' });
  assert.equal(again.isError, true);
  assert.equal(parse(again).error.code, 'slot_taken');
  const left = parse(await call('check_availability', { from: '2026-10-06', days: 1 })).slots.map((s) => s.start);
  assert.ok(!left.includes(first));
});

test('handover over HTTP records the reason from the agent door and returns what to tell the customer', async () => {
  const result = await call('handover', { reason: 'talk_to_a_person', summary: 'Asked for a human.' });
  assert.ok(!result.isError);
  const { handover } = parse(result);
  assert.equal(handover.reason, 'talk_to_a_person');
  assert.match(handover.tell_customer_ar, /[؀-ۿ]/);
  const stored = store.all('handovers').at(-1);
  assert.equal(stored.door, 'agent');
  assert.equal(stored.summary, 'Asked for a human.');
});

test('bookings and handovers made through the door survive a server restart (file store)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-door-'));
  const file = join(dir, 'store.json');
  try {
    const slot = '2026-10-07T15:00:00+03:00';
    const args = { ...PROFILES[0].order, slot, customer_name: 'Restart Test', contact: 'restart@example.com' };
    const first = await openDoor(createDesk({ store: createFileStore(file), now: at(NOW) }));
    try {
      assert.ok(!(await first.client.callTool({ name: 'book', arguments: args })).isError);
      await first.client.callTool({ name: 'handover', arguments: { reason: 'talk_to_a_person' } });
    } finally { await first.close(); }

    const second = await openDoor(createDesk({ store: createFileStore(file), now: at(NOW) }));
    try {
      const free = parse(await second.client.callTool({ name: 'check_availability',
        arguments: { from: '2026-10-07', days: 1 } })).slots.map((s) => s.start);
      assert.ok(!free.includes(slot), 'the booked slot must stay taken after a restart');
      const again = await second.client.callTool({ name: 'book', arguments: args });
      assert.equal(parse(again).error.code, 'slot_taken');
      const h = await second.client.callTool({ name: 'handover', arguments: { reason: 'out_of_rules' } });
      assert.equal(parse(h).handover.id, 'HO-0002');
    } finally { await second.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('anything other than /mcp is a 404', async () => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/admin`);
  assert.equal(res.status, 404);
});

test('a malformed body gets a 400, not a crash', async () => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  // the server is still up afterwards
  const again = await call('quote', PROFILES[0].order);
  assert.equal(parse(again).total, PROFILES[0].total);
});
