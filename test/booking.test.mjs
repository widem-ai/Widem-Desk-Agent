// book, handover and the automatic handover on a core refusal, plus storage that survives a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore, createFileStore } from '../src/store.mjs';
import { quote } from '../src/core.mjs';
import { PROFILES } from './profiles.mjs';

const at = (iso) => () => new Date(iso);
const NOW = '2026-10-04T08:00:00+03:00'; // Sunday, before opening
const SLOT = '2026-10-05T11:00:00+03:00'; // Monday 11:00 Riyadh
const newDesk = (store = createMemoryStore()) => ({ store, desk: createDesk({ store, now: at(NOW) }) });
const order = (extra = {}) => ({ ...PROFILES[1].order, slot: SLOT,
  customer_name: 'Test Customer', contact: 'test@example.com', ...extra });

test('book returns a reference and stores every field the owner needs', () => {
  const { desk, store } = newDesk();
  const r = desk.book(order(), { door: 'agent' });
  assert.equal(r.ok, true);
  assert.equal(r.demo, true);
  const b = r.booking;
  assert.equal(b.reference, 'BK-0001');
  assert.equal(b.status, 'booked');
  assert.equal(b.door, 'agent');
  assert.equal(b.created_at, '2026-10-04T05:00:00.000Z');
  assert.deepEqual(b.slot, { start: SLOT, end: '2026-10-05T12:00:00+03:00' });
  assert.equal(b.customer_name, 'Test Customer');
  assert.equal(b.contact, 'test@example.com');
  assert.equal(b.tier, 'senior');
  assert.deepEqual(b.services, PROFILES[1].input.services);
  assert.equal(b.price_quoted, PROFILES[1].total);
  assert.equal(b.currency, 'SAR');
  assert.deepEqual(b.quote, quote(PROFILES[1].input));
  assert.equal(b.transcript, null);
  assert.deepEqual(store.all('bookings'), [b]);
  assert.equal(desk.book(order({ slot: '2026-10-05T12:00:00+03:00' }), { door: 'human' }).booking.reference, 'BK-0002');
});

test('the same instant written in UTC books the same Riyadh slot', () => {
  const { desk } = newDesk();
  const r = desk.book(order({ slot: '2026-10-05T08:00:00Z' }), { door: 'agent' });
  assert.equal(r.ok, true);
  assert.equal(r.booking.slot.start, SLOT);
});

test('a slot cannot be booked twice, whoever asks and however the time is written', () => {
  const { desk, store } = newDesk();
  assert.equal(desk.book(order(), { door: 'human' }).ok, true);
  for (const slot of [SLOT, '2026-10-05T08:00:00.000Z']) {
    const again = desk.book(order({ slot, customer_name: 'Someone Else' }), { door: 'agent' });
    assert.equal(again.ok, false);
    assert.equal(again.error.code, 'slot_taken');
  }
  assert.equal(store.all('bookings').length, 1);
});

for (const [name, extra, code] of [
  ['no customer name', { customer_name: '  ' }, 'incomplete'],
  ['no contact', { contact: undefined }, 'incomplete'],
  ['no slot', { slot: undefined }, 'incomplete'],
  ['a slot that is not a time', { slot: 'Monday morning' }, 'invalid_slot'],
  ['a slot without its timezone offset', { slot: '2026-10-05T11:00:00' }, 'invalid_slot'],
  ['a slot off the hour grid', { slot: '2026-10-05T11:30:00+03:00' }, 'slot_unavailable'],
  ['the lunch hour', { slot: '2026-10-05T13:00:00+03:00' }, 'slot_unavailable'],
  ['a Friday', { slot: '2026-10-09T11:00:00+03:00' }, 'slot_unavailable'],
  ['a blocked date', { slot: '2026-10-08T11:00:00+03:00' }, 'slot_unavailable'],
  ['a slot that has already passed', { slot: '2026-10-01T11:00:00+03:00' }, 'slot_unavailable'],
  ['a slot beyond the booking window', { slot: '2026-10-26T11:00:00+03:00' }, 'slot_unavailable'],
  ['a duplicated service (fixable, no handover)', { services: ['cv_rewrite', 'cv_rewrite'] }, 'duplicate_service'],
]) {
  test(`book refuses ${name}, stores nothing and hands nothing over`, () => {
    const { desk, store } = newDesk();
    const r = desk.book(order(extra), { door: 'agent' });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, code);
    assert.equal(r.handover, undefined);
    assert.deepEqual(store.all('bookings'), []);
    assert.deepEqual(store.all('handovers'), []);
  });
}

// Decision for this slice: a refusal the rules cannot price goes to a person automatically, in code.
for (const [name, input, code] of [
  ['an unknown service', { services: ['salary_negotiation'], years_experience: 10 }, 'unknown_service'],
  ['an unknown add-on', { services: ['cv_rewrite'], years_experience: 5, addons: ['gold_frame'] }, 'unknown_addon'],
  ['an add-on that cannot apply', { services: ['interview_coaching'], years_experience: 5, addons: ['arabic_version'] },
    'addon_not_applicable'],
]) {
  test(`${name} is handed over automatically, from quote and from book`, () => {
    const { desk, store } = newDesk();
    const q = desk.quote(input, { door: 'agent' });
    assert.equal(q.ok, false);
    assert.equal(q.error.code, code);
    assert.equal(q.handover.reason, code);
    assert.equal(q.handover.id, 'HO-0001');
    assert.match(q.handover.tell_customer_en, /team will reply/);
    assert.match(q.handover.tell_customer_ar, /[؀-ۿ]/);
    const b = desk.book(order(input), { door: 'human' });
    assert.equal(b.error.code, code);
    assert.equal(b.handover.id, 'HO-0002');
    assert.deepEqual(store.all('bookings'), []);
    const [h1, h2] = store.all('handovers');
    assert.equal(h1.door, 'agent');
    assert.equal(h2.door, 'human');
    assert.equal(h2.customer_name, 'Test Customer');
    assert.equal(h2.contact, 'test@example.com');
    assert.deepEqual(h1.request, { services: input.services, years_experience: input.years_experience, is_executive: false, addons: input.addons ?? [] });
  });
}

test('a quote inside the rules is the slice 1 quote and hands nothing over', () => {
  const { desk, store } = newDesk();
  for (const p of PROFILES) assert.deepEqual(desk.quote(p.order, { door: 'agent' }), quote(p.input));
  assert.deepEqual(store.all('handovers'), []);
});

test('handover records the reason and tells the caller what to say, in both languages', () => {
  const { desk, store } = newDesk();
  const r = desk.handover({ reason: 'talk_to_a_person', summary: 'Wants to speak to someone first.',
    customer_name: 'Test Customer', contact: '+966 50 000 0000' }, { door: 'agent' });
  assert.equal(r.ok, true);
  assert.equal(r.handover.id, 'HO-0001');
  assert.equal(r.handover.reason, 'talk_to_a_person');
  assert.match(r.handover.tell_customer_ar, /[؀-ۿ]/);
  const [h] = store.all('handovers');
  assert.equal(h.status, 'open');
  assert.equal(h.summary, 'Wants to speak to someone first.');
  assert.equal(h.created_at, '2026-10-04T05:00:00.000Z');
});

test('handover never drops a customer: a missing or unknown reason is kept as out_of_rules', () => {
  const { desk, store } = newDesk();
  assert.equal(desk.handover({ reason: 'wants a discount' }, { door: 'human' }).handover.reason, 'out_of_rules');
  assert.equal(desk.handover({}, { door: 'human' }).handover.reason, 'out_of_rules');
  assert.equal(store.all('handovers')[0].reason_given, 'wants a discount');
});

test('handover text is capped so one caller cannot fill the store', () => {
  const { desk, store } = newDesk();
  desk.handover({ reason: 'out_of_rules', summary: 'x'.repeat(50_000) }, { door: 'agent' });
  assert.ok(store.all('handovers')[0].summary.length <= 2000);
});

test('the store hands out copies: editing a result cannot change what is stored', () => {
  const { desk, store } = newDesk();
  desk.book(order(), { door: 'agent' }).booking.status = 'cancelled';
  store.all('bookings')[0].status = 'cancelled';
  assert.equal(store.all('bookings')[0].status, 'booked');
});

test('the file store keeps bookings and handovers across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-store-'));
  try {
    const file = join(dir, 'store.json');
    const first = newDesk(createFileStore(file)).desk;
    assert.equal(first.book(order(), { door: 'agent' }).ok, true);
    first.handover({ reason: 'talk_to_a_person' }, { door: 'human' });

    const { desk, store } = newDesk(createFileStore(file)); // a fresh process would do exactly this
    assert.equal(store.all('bookings')[0].reference, 'BK-0001');
    assert.equal(store.all('handovers')[0].reason, 'talk_to_a_person');
    assert.equal(desk.book(order(), { door: 'human' }).error.code, 'slot_taken');
    assert.equal(desk.book(order({ slot: '2026-10-05T12:00:00+03:00' }), { door: 'human' }).booking.reference,
      'BK-0002');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt store file stops the desk instead of silently starting empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-store-'));
  try {
    const file = join(dir, 'store.json');
    writeFileSync(file, '{ not json');
    assert.throws(() => createFileStore(file), /store/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unknown door is a programming error, not a customer refusal', () => {
  const { desk } = newDesk();
  assert.throws(() => desk.book(order(), { door: 'fax' }), /door/);
});
