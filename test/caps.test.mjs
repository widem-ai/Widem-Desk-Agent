// The two caps that protect the public demo (hosting plan 2026-10-11, E7):
// 1. a total cap on stored records (bookings + handovers), so the one JSON file cannot grow without end;
// 2. a daily cap on model calls (Riyadh day), so the USD 25 Token Factory credit lasts until judging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore, createMemoryStore } from '../src/store.mjs';
import { createDesk, STORE_FULL } from '../src/desk.mjs';
import { handoverReply } from '../src/chat.mjs';
import { limitModelCalls, riyadhDay, RESTING } from '../src/model-budget.mjs';
import { createHttpServer } from '../src/mcp-server.mjs';
import { PROFILES } from './profiles.mjs';

const NOW = '2026-10-04T08:00:00+03:00';
const SLOT = '2026-10-06T10:00:00+03:00';
const order = (extra = {}) => ({ ...PROFILES[1].order, slot: SLOT, customer_name: 'Test Customer', contact: 'test@example.com', ...extra });
const tmp = () => mkdtempSync(join(tmpdir(), 'desk-caps-'));

test('store: both stores refuse a record past the total cap (bookings + handovers together)', () => {
  const dir = tmp();
  try {
    for (const store of [createMemoryStore({ maxRecords: 2 }), createFileStore(join(dir, 's.json'), { maxRecords: 2 })]) {
      store.add('bookings', { reference: 'BK-0001' });
      store.add('handovers', { id: 'HO-0001' });
      assert.throws(() => store.add('handovers', { id: 'HO-0002' }), (e) => e.code === 'store_full');
      assert.equal(store.all('handovers').length, 1);
      assert.ok(store.update('bookings', 'reference', 'BK-0001', { status: 'paid' }), 'updates still work when full');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('store: a file already over the cap loads whole (nothing deleted) and takes no more', () => {
  const dir = tmp();
  try {
    const file = join(dir, 's.json');
    writeFileSync(file, JSON.stringify({ bookings: [{ reference: 'BK-0001' }], handovers: [{ id: 'HO-0001' }, { id: 'HO-0002' }] }));
    const store = createFileStore(file, { maxRecords: 2 });
    assert.equal(store.all('handovers').length, 2);
    assert.throws(() => store.add('bookings', { reference: 'BK-0002' }), (e) => e.code === 'store_full');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).handovers.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('desk: when the store is full, book and handover refuse cleanly and the owner view still reads', () => {
  const desk = createDesk({ store: createMemoryStore({ maxRecords: 1 }), now: () => new Date(NOW) });
  assert.equal(desk.handover({ reason: 'out_of_rules', summary: 'first' }, { door: 'agent' }).handover.id, 'HO-0001');
  const b = desk.book(order(), { door: 'agent' });
  assert.equal(b.ok, false);
  assert.equal(b.error.code, 'store_full');
  const h = desk.handover({ reason: 'out_of_rules', summary: 'second' }, { door: 'human' }).handover;
  assert.equal(h.id, null);
  assert.equal(h.reason, 'store_full');
  assert.equal(h.tell_customer_en, STORE_FULL.en);
  assert.equal(handoverReply('store_full', false), STORE_FULL.en, 'the chat tells the customer, not "a person will reply"');
  assert.equal(desk.ownerView().handovers.length, 1);
});

function countingModel() {
  let calls = 0;
  return { get calls() { return calls; }, async complete() { calls += 1; return { message: { role: 'assistant', content: 'Hello.' }, modelId: 'fake' }; } };
}

test('model budget: the Riyadh day turns at 21:00 UTC', () => {
  assert.equal(riyadhDay(Date.parse('2026-10-11T20:59:59Z')), '2026-10-11');
  assert.equal(riyadhDay(Date.parse('2026-10-11T21:00:00Z')), '2026-10-12');
});

test('model budget: calls past the daily cap never reach the model; the count survives a restart and resets next day', async () => {
  const dir = tmp();
  try {
    const file = join(dir, 'calls.json');
    let t = Date.parse('2026-10-11T10:00:00Z');
    const inner = countingModel();
    const m = limitModelCalls(inner, { perDay: 2, file, now: () => t });
    await m.complete({ messages: [] });
    assert.equal(m.exhausted(), false);
    await m.complete({ messages: [] });
    assert.equal(m.exhausted(), true);
    await assert.rejects(m.complete({ messages: [] }), (e) => e.code === 'daily_limit');
    assert.equal(inner.calls, 2);
    const restarted = limitModelCalls(inner, { perDay: 2, file, now: () => t });
    assert.equal(restarted.exhausted(), true, 'a restart does not refill the day');
    t = Date.parse('2026-10-11T21:00:00Z');
    assert.equal(restarted.exhausted(), false);
    await restarted.complete({ messages: [] });
    assert.equal(inner.calls, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('chat door: once the day is spent it answers the resting line without calling the model', async () => {
  const dir = tmp();
  const inner = countingModel();
  const model = limitModelCalls(inner, { perDay: 1, file: join(dir, 'calls.json'), now: () => Date.parse('2026-10-11T10:00:00Z') });
  const server = createHttpServer({ desk: createDesk({ store: createMemoryStore(), now: () => new Date(NOW) }), model, lang: 'en' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const post = async (message) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/chat`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
    return { status: res.status, json: await res.json() };
  };
  try {
    assert.equal((await post('Hi')).status, 200);
    const out = await post('Hi again');
    assert.equal(out.status, 503);
    assert.equal(out.json.error.code, 'daily_limit');
    assert.equal(out.json.reply, RESTING.en);
    assert.match(RESTING.en, /resting until tomorrow \(Riyadh time\)/);
    assert.equal(inner.calls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
