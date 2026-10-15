// The server reads its two caps from the environment (DESK_MAX_RECORDS, DESK_MODEL_CALLS_PER_DAY).
// A typo in positiveInt once made every env value fall back to the default (1000 / 150), so these tests
// check the parse and that a value set in the environment is the cap the store and the model wrapper enforce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../src/mcp-server.mjs';
import { createMemoryStore, DEFAULT_MAX_RECORDS } from '../src/store.mjs';
import { limitModelCalls, DEFAULT_MODEL_CALLS_PER_DAY } from '../src/model-budget.mjs';

const { positiveInt } = server;

test('positiveInt: a whole number above zero is used', () => {
  assert.equal(positiveInt('2', 1000), 2);
  assert.equal(positiveInt(' 40 ', 1000), 40);
  assert.equal(positiveInt('150', 7), 150);
});

test('positiveInt: zero, negative, text, empty and missing fall back to the default', () => {
  for (const v of ['0', '-1', 'abc', '', undefined, '2.5', '1e3', 'd', 'dd']) {
    assert.equal(positiveInt(v, 1000), 1000, `value ${JSON.stringify(v)}`);
  }
});

test('limitsFromEnv: no env gives the defaults', () => {
  assert.deepEqual(server.limitsFromEnv({}), { maxRecords: DEFAULT_MAX_RECORDS, perDay: DEFAULT_MODEL_CALLS_PER_DAY });
});

test('DESK_MAX_RECORDS=2 in the env: the third record is refused', () => {
  const { maxRecords } = server.limitsFromEnv({ DESK_MAX_RECORDS: '2' });
  const store = createMemoryStore({ maxRecords });
  store.add('bookings', { reference: 'BK-0001' });
  store.add('handovers', { id: 'HO-0001' });
  assert.throws(() => store.add('bookings', { reference: 'BK-0002' }), (e) => e.code === 'store_full');
});

test('DESK_MODEL_CALLS_PER_DAY=2 in the env: the third model call that day is refused', async () => {
  const { perDay } = server.limitsFromEnv({ DESK_MODEL_CALLS_PER_DAY: '2' });
  let reached = 0;
  const model = limitModelCalls({ complete: async () => { reached += 1; return { content: 'ok' }; } },
    { perDay, now: () => Date.parse('2026-10-16T09:00:00+03:00') });
  await model.complete([]);
  await model.complete([]);
  await assert.rejects(() => model.complete([]), (e) => e.code === 'daily_limit');
  assert.equal(reached, 2);
});
