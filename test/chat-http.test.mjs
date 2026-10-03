// The human door over HTTP: POST /chat on the same server as the agent door, with a scripted
// fake model (no network). The server keeps each session's history in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/mcp-server.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { PROFILES } from './profiles.mjs';

const at = (iso) => () => new Date(iso);
const NOW = '2026-10-04T08:00:00+03:00';
const SLOT = '2026-10-06T10:00:00+03:00';
const ORDER = PROFILES[1].input;

function scriptedModel(rounds) {
  const seen = [];
  return {
    seen,
    async complete({ messages }) {
      seen.push(structuredClone(messages));
      const next = rounds[Math.min(seen.length - 1, rounds.length - 1)];
      if (next instanceof Error) throw next;
      return { message: next, modelId: 'fake/scripted' };
    },
  };
}
const toolCall = (id, name, args) => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function withServer(model, fn) {
  const store = createMemoryStore();
  const server = createHttpServer({ desk: createDesk({ store, now: at(NOW) }), model });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/chat`;
  const post = async (body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try { await fn({ post, store, url }); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('POST /chat keeps a session, books with door human and stores the conversation', async () => {
  const model = scriptedModel([
    { role: 'assistant', content: '\n\nWhat is your name and email?' },
    toolCall('c1', 'book', { ...ORDER, slot: SLOT, customer_name: 'Sara', contact: 'sara@example.com' }),
    { role: 'assistant', content: 'Booked: BK-0001.' },
  ]);
  await withServer(model, async ({ post, store }) => {
    const first = await post({ sessionId: 's1', message: 'Full career pack, senior, Tuesday 10:00 please' });
    assert.equal(first.status, 200);
    assert.equal(first.json.reply, 'What is your name and email?'); // leading blank lines stripped
    assert.equal(first.json.booked, undefined);

    const second = await post({ sessionId: 's1', message: 'Sara, sara@example.com' });
    assert.equal(second.status, 200);
    assert.equal(second.json.reply, 'Booked: BK-0001.');
    assert.deepEqual(second.json.booked, store.all('bookings')[0]);
    assert.equal(second.json.booked.door, 'human');
    assert.equal(second.json.booked.price_quoted, PROFILES[1].total);
    // The second turn's model call saw the first turn, and the booking keeps both customer messages.
    assert.ok(model.seen[1].some((m) => m.role === 'user' && /Full career pack/.test(m.content)));
    assert.match(second.json.booked.transcript, /Full career pack[\s\S]*What is your name[\s\S]*sara@example.com/);
  });
});

test('separate sessions do not share history', async () => {
  const model = scriptedModel([{ role: 'assistant', content: 'Hello.' }]);
  await withServer(model, async ({ post }) => {
    await post({ sessionId: 'a', message: 'secret from a' });
    await post({ sessionId: 'b', message: 'hi from b' });
    assert.ok(!model.seen[1].some((m) => /secret from a/.test(m.content ?? '')));
  });
});

test('a handover through the chat is returned and keeps the conversation', async () => {
  const model = scriptedModel([toolCall('h1', 'handover', { reason: 'out_of_rules', summary: 'Wants a discount' }),
    { role: 'assistant', content: 'A person will reply.' }]);
  await withServer(model, async ({ post, store }) => {
    const out = await post({ sessionId: 'h', message: 'Can I get 50% off?' });
    assert.equal(out.status, 200);
    const [record] = store.all('handovers');
    assert.equal(out.json.handover.id, record.id); // the reply carries what to tell the customer, not the record
    assert.ok(out.json.handover.tell_customer_en);
    assert.equal(record.door, 'human');
    assert.match(record.transcript, /50% off/);
  });
});

test('malformed, incomplete or oversized bodies get a 4xx and never reach the model', async () => {
  const model = scriptedModel([{ role: 'assistant', content: 'never' }]);
  await withServer(model, async ({ post, url }) => {
    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post({ sessionId: 's' })).status, 400);
    assert.equal((await post({ message: 'hi' })).status, 400);
    assert.equal((await post({ sessionId: 's', message: 42 })).status, 400);
    assert.equal((await post({ sessionId: 's', message: 'x'.repeat(70 * 1024) })).status, 413);
    assert.equal((await fetch(url)).status, 405);
    assert.equal(model.seen.length, 0);
  });
});

test('a model timeout becomes a polite 503 reply in the customer language, and the turn is not kept', async () => {
  const slow = Object.assign(new Error('model timed out'), { code: 'model_timeout' });
  const model = scriptedModel([slow, { role: 'assistant', content: 'Back.' }]);
  await withServer(model, async ({ post }) => {
    const out = await post({ sessionId: 't', message: 'مرحبا' });
    assert.equal(out.status, 503);
    assert.equal(out.json.error.code, 'model_timeout');
    assert.match(out.json.reply, /[؀-ۿ]/);
    await post({ sessionId: 't', message: 'hello again' });
    assert.equal(model.seen[1].filter((m) => m.role === 'user').length, 1);
  });
});
