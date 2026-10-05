// The human door over HTTP: POST /chat on the same server as the agent door, with a scripted
// fake model (no network) and a fake clock (no real waiting). The server issues session ids and
// keeps each session's history in memory; per-IP and global limits protect the model credit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHttpServer } from '../src/mcp-server.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { PROFILES } from './profiles.mjs';

const at = (iso) => () => new Date(iso);
const NOW = '2026-10-04T08:00:00+03:00';
const SLOT = '2026-10-06T10:00:00+03:00';
const ORDER = PROFILES[1].order;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

async function withServer(model, fn, { limits, clock = { t: 0 } } = {}) {
  const store = createMemoryStore();
  const server = createHttpServer({ desk: createDesk({ store, now: at(NOW) }), model, limits, now: () => clock.t });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/chat`;
  const post = async (body) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
  };
  // A customer: the first message opens a session, the rest send back the id the server issued.
  const customer = () => {
    let sessionId;
    return async (message) => {
      const out = await post(sessionId ? { sessionId, message } : { message });
      if (out.json?.sessionId) sessionId = out.json.sessionId;
      return out;
    };
  };
  try { await fn({ post, customer, store, url, clock }); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('the server issues the session id; a booking keeps the facts and the whole turn, confirmation included', async () => {
  const model = scriptedModel([
    // Slots first (2026-10-05): the desk checks the free slots before it asks for name and contact.
    toolCall('c0', 'check_availability', { from: '2026-10-06', days: 1 }),
    { role: 'assistant', content: '\n\nWhat is your name and email?' },
    toolCall('c1', 'book', { ...ORDER, slot: SLOT, customer_name: 'Sara', contact: 'sara@example.com' }),
    { role: 'assistant', content: 'Booked: BK-0001, Tuesday 10:00 to 11:00, 1575 SAR.' },
  ]);
  await withServer(model, async ({ customer, store }) => {
    const say = customer();
    const first = await say('Full career pack, 10 years, Tuesday 10:00 please');
    assert.equal(first.status, 200);
    assert.match(first.json.sessionId, UUID);
    assert.equal(first.json.reply, 'What is your name and email?'); // leading blank lines stripped
    assert.equal(first.json.booked, undefined);

    const second = await say('Sara, sara@example.com');
    assert.equal(second.status, 200);
    assert.equal(second.json.sessionId, first.json.sessionId);
    // Since 2026-10-05 the post-book reply is built in code (held until payment), never the model's "booked" line.
    assert.match(second.json.reply, /held for you until payment\. The amount is 1575 SAR, reference BK-0001\./);
    const [stored] = store.all('bookings');
    assert.deepEqual(second.json.booked, stored);
    assert.equal(stored.door, 'human');
    assert.equal(stored.price_quoted, PROFILES[1].total);
    assert.equal(stored.years_experience, 10);
    assert.equal(stored.is_executive, false);
    assert.ok(model.seen[1].some((m) => m.role === 'user' && /Full career pack/.test(m.content)));
    // The stored conversation runs to the end of the turn, so the owner sees the confirmation too.
    assert.match(stored.transcript, /Full career pack[\s\S]*What is your name[\s\S]*sara@example.com[\s\S]*Desk: Your time, .+ is held for you until payment\. The amount is 1575 SAR, reference BK-0001\. Pay with the button below to confirm the call\.$/);
  });
});

test('a made-up or guessed session id cannot read or continue another session', async () => {
  const model = scriptedModel([{ role: 'assistant', content: 'Hello.' }]);
  await withServer(model, async ({ post, customer }) => {
    const real = customer();
    const opened = await real('my secret order');
    for (const sessionId of ['s1', 'a', randomUUID(), opened.json.sessionId.replace(/.$/, (c) => (c === '0' ? '1' : '0'))]) {
      const out = await post({ sessionId, message: 'what did I say?' });
      assert.equal(out.status, 400, sessionId);
      assert.equal(out.json.error.code, 'unknown_session');
    }
    assert.equal(model.seen.length, 1, 'no guessed id reached the model');
    const fresh = await post({ message: 'hi' });
    assert.notEqual(fresh.json.sessionId, opened.json.sessionId);
    assert.ok(!model.seen[1].some((m) => /my secret order/.test(m.content ?? '')));
  });
});

test('a handover through the chat is returned and keeps the conversation', async () => {
  const model = scriptedModel([toolCall('h1', 'handover', { reason: 'out_of_rules', summary: 'Wants a discount' }),
    { role: 'assistant', content: 'A person will reply.' }]);
  await withServer(model, async ({ customer, store }) => {
    const out = await customer()('Can I get 50% off?');
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
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ message: 42 })).status, 400);
    assert.equal((await post({ sessionId: 7, message: 'hi' })).status, 400);
    assert.equal((await post({ message: 'x'.repeat(70 * 1024) })).status, 413);
    assert.equal((await fetch(url)).status, 405);
    assert.equal(model.seen.length, 0);
  });
});

test('a model timeout becomes a polite 503 reply in the customer language, and the turn is not kept', async () => {
  const slow = Object.assign(new Error('model timed out'), { code: 'model_timeout' });
  const model = scriptedModel([slow, { role: 'assistant', content: 'Back.' }]);
  await withServer(model, async ({ customer }) => {
    const say = customer();
    const out = await say('مرحبا');
    assert.equal(out.status, 503);
    assert.equal(out.json.error.code, 'model_timeout');
    assert.match(out.json.reply, /[؀-ۿ]/);
    await say('hello again');
    assert.equal(model.seen[1].filter((m) => m.role === 'user').length, 1);
  });
});

const LIMITS = { perIp: { messages: 3, windowMs: 600_000 }, global: { messages: 100, windowMs: 60_000 },
  newSessionsPerIp: { count: 5, windowMs: 600_000 }, maxSessions: 500, maxHistoryMessages: 40 };

test('per-IP limit: the fourth message in ten minutes gets a polite bilingual 429, and the bucket refills', async () => {
  const model = scriptedModel([{ role: 'assistant', content: 'ok' }]);
  await withServer(model, async ({ customer, clock }) => {
    const say = customer();
    for (let i = 0; i < 3; i += 1) assert.equal((await say(`m${i}`)).status, 200);
    const limited = await say('one more');
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.code, 'rate_limited');
    assert.match(limited.json.reply, /try again/i);
    assert.match(limited.json.reply, /[؀-ۿ]/);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(model.seen.length, 3);
    clock.t += 600_000;
    assert.equal((await say('after the wait')).status, 200);
  }, { limits: LIMITS });
});

test('global limit per minute protects the model credit across all callers', async () => {
  const model = scriptedModel([{ role: 'assistant', content: 'ok' }]);
  const limits = { ...LIMITS, perIp: { messages: 100, windowMs: 600_000 }, global: { messages: 2, windowMs: 60_000 } };
  await withServer(model, async ({ customer }) => {
    assert.equal((await customer()('a')).status, 200);
    assert.equal((await customer()('b')).status, 200);
    const out = await customer()('c');
    assert.equal(out.status, 429);
    assert.equal(model.seen.length, 2);
  }, { limits });
});

test('one IP cannot flood new sessions and push real ones out', async () => {
  const model = scriptedModel([{ role: 'assistant', content: 'ok' }]);
  const limits = { ...LIMITS, perIp: { messages: 100, windowMs: 600_000 }, newSessionsPerIp: { count: 2, windowMs: 600_000 }, maxSessions: 3 };
  await withServer(model, async ({ customer }) => {
    const real = customer();
    assert.equal((await real('I am real')).status, 200);
    const flood = [];
    for (let i = 0; i < 10; i += 1) flood.push((await customer()(`flood ${i}`)).status);
    assert.equal(flood.filter((s) => s === 200).length, 1);
    assert.equal(flood.filter((s) => s === 429).length, 9);
    assert.equal((await real('still here')).status, 200);
  }, { limits });
});

test('history is capped: the oldest turns are trimmed, starting at a customer message', async () => {
  const model = scriptedModel([toolCall('q', 'quote', ORDER), { role: 'assistant', content: 'ok' }]);
  const limits = { ...LIMITS, perIp: { messages: 100, windowMs: 600_000 }, maxHistoryMessages: 3 }; // odd, so a plain cut lands mid-turn
  await withServer(model, async ({ customer }) => {
    const say = customer();
    for (let i = 1; i <= 5; i += 1) assert.equal((await say(`message ${i}`)).status, 200);
    const last = model.seen.at(-1);
    assert.equal(last[0].role, 'system');
    assert.ok(last.length <= 1 + 3 + 1, `sent ${last.length} messages`);
    assert.equal(last[1].role, 'user');
    assert.ok(!last.some((m) => m.content === 'message 1'));
  }, { limits });
});

test('POST /chat/pay: the demo pay button marks this session\'s booking paid and the desk confirms reference, slot and amount', async () => {
  const model = scriptedModel([
    toolCall('c0', 'check_availability', { from: '2026-10-06', days: 1 }),
    { role: 'assistant', content: 'Pick a time below.' },
    toolCall('c1', 'book', { ...ORDER, slot: SLOT, customer_name: 'Sara', contact: 'sara@example.com' }),
    { role: 'assistant', content: 'Your time is held. Pay below to confirm it.' },
  ]);
  await withServer(model, async ({ customer, store, url }) => {
    const say = customer();
    await say('Full career pack, 10 years');
    const held = await say('Tuesday 10:00, Sara, sara@example.com');
    assert.deepEqual(held.json.ui.map((w) => w.type), ['pay']);
    const pay = async (body) => {
      const res = await fetch(`${url}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    assert.equal((await pay({})).status, 400, 'a session is required');
    assert.equal((await pay({ sessionId: 'not-issued' })).status, 400);
    const [booking] = store.all('bookings');
    assert.equal(booking.status, 'awaiting_payment');
    const paid = await pay({ sessionId: held.json.sessionId });
    assert.equal(paid.status, 200);
    assert.equal(store.all('bookings')[0].status, 'paid');
    for (const part of [booking.reference, '10:00', String(booking.price_quoted)]) assert.ok(paid.json.reply.includes(part), paid.json.reply);
    assert.deepEqual(paid.json.ui, []);
    assert.equal((await pay({ sessionId: held.json.sessionId })).status, 409, 'nothing left to pay');
  });
});
