// checkAvailability: free kickoff-call slots from the rules in data/demo-business.json, in Asia/Riyadh (UTC+3).
// Fixed clocks only, so every expectation below is worked out by hand from the data file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';

const at = (iso) => () => new Date(iso);
// 2026-10-04 is a Sunday. 08:00 in Riyadh, before opening.
const SUNDAY_EARLY = '2026-10-04T08:00:00+03:00';
const newDesk = (now = SUNDAY_EARLY) => createDesk({ store: createMemoryStore(), now: at(now) });

const SUNDAY_STARTS = ['10', '11', '12', '14', '15', '16', '17'].map((h) => `2026-10-04T${h}:00:00+03:00`);

test('a working day has seven one-hour slots with the lunch hour left out, in Riyadh time', () => {
  const r = newDesk().checkAvailability({ from: '2026-10-04', days: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.demo, true);
  assert.equal(r.timezone, 'Asia/Riyadh');
  assert.equal(r.slot_minutes, 60);
  assert.deepEqual(r.slots.map((s) => s.start), SUNDAY_STARTS);
  assert.equal(r.slots[0].end, '2026-10-04T11:00:00+03:00');
  // the offset is real: 10:00 in Riyadh is 07:00 UTC
  assert.equal(new Date(r.slots[0].start).toISOString(), '2026-10-04T07:00:00.000Z');
});

test('Friday and Saturday are closed, and a blocked date has no slots', () => {
  const desk = newDesk();
  assert.deepEqual(desk.checkAvailability({ from: '2026-10-09', days: 2 }).slots, []); // Fri, Sat
  assert.deepEqual(desk.checkAvailability({ from: '2026-10-08', days: 1 }).slots, []); // Thu, demo closure
  const week = desk.checkAvailability({ from: '2026-10-04', days: 7 }).slots;
  const days = [...new Set(week.map((s) => s.start.slice(0, 10)))];
  assert.deepEqual(days, ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']); // Thu 8th blocked, Fri/Sat shut
  assert.equal(week.length, 28);
});

test('slots that have already started are not offered', () => {
  const r = newDesk('2026-10-04T10:30:00+03:00').checkAvailability({ from: '2026-10-04', days: 1 });
  assert.deepEqual(r.slots.map((s) => s.start), SUNDAY_STARTS.slice(1));
});

test('without a from date it starts from today in Riyadh, not today in UTC', () => {
  // 21:30 UTC on Sunday is already 00:30 on Monday in Riyadh
  const r = newDesk('2026-10-04T21:30:00Z').checkAvailability({});
  assert.equal(r.from, '2026-10-05');
  assert.equal(r.slots[0].start, '2026-10-05T10:00:00+03:00');
});

test('nothing is offered beyond the 21-day booking window', () => {
  // window: 2026-10-04 plus 21 days = up to and including 2026-10-25 (a Sunday)
  const desk = newDesk();
  assert.equal(desk.checkAvailability({ from: '2026-10-25', days: 1 }).slots.length, 7);
  assert.deepEqual(desk.checkAvailability({ from: '2026-10-26', days: 1 }).slots, []);
});

test('a booked slot is no longer offered', () => {
  const desk = newDesk();
  const b = desk.book({ services: ['cv_rewrite'], tier: 'senior', slot: SUNDAY_STARTS[2],
    customer_name: 'Test Customer', contact: 'test@example.com' }, { door: 'agent' });
  assert.equal(b.ok, true);
  const starts = desk.checkAvailability({ from: '2026-10-04', days: 1 }).slots.map((s) => s.start);
  assert.deepEqual(starts, SUNDAY_STARTS.filter((s) => s !== SUNDAY_STARTS[2]));
});

for (const [name, input, code] of [
  ['a date that is not YYYY-MM-DD', { from: '04/10/2026' }, 'invalid_date'],
  ['a date that does not exist', { from: '2026-02-30' }, 'invalid_date'],
  ['zero days', { from: '2026-10-04', days: 0 }, 'invalid_range'],
  ['more than seven days at once', { from: '2026-10-04', days: 8 }, 'invalid_range'],
  ['a fractional day count', { from: '2026-10-04', days: 1.5 }, 'invalid_range'],
]) {
  test(`refuses ${name}`, () => {
    const r = newDesk().checkAvailability(input);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, code);
  });
}
