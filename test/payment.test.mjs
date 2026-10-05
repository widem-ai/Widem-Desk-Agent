// Payment at booking (Mohannad, 2026-10-05, option b): a booking is created awaiting payment for the quoted total,
// a demo pay button (no card fields, nothing charged) marks it paid, and an unpaid hold frees its slot after the
// window in data/demo-business.json. The desk never tells a customer the call is free or that no payment is due.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { widgetsFor, newWidgetState } from '../src/widgets.mjs';
import { paymentClaims } from '../src/guard.mjs';
import { createChat } from '../src/chat.mjs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const PAY = DATA.payment;
const HUMAN = { door: 'human' };
function clockDesk() {
  const clock = { t: Date.parse('2026-10-04T08:00:00+03:00') };
  return { clock, desk: createDesk({ store: createMemoryStore(), now: () => new Date(clock.t) }) };
}
const ORDER = { services: ['cv_rewrite', 'linkedin_profile', 'cover_letter'], years_experience: 4 };
const bookFirst = (desk) => {
  const slot = desk.checkAvailability({ from: '2026-10-06', days: 1 }).slots[0].start;
  return { slot, out: desk.book({ ...ORDER, slot, customer_name: 'Sara Test', contact: 'sara@example.com' }, HUMAN) };
};

test('the data states the demo payment rules in both languages', () => {
  assert.equal(PAY.when, 'at_booking');
  assert.equal(PAY.hold_minutes, 30);
  assert.deepEqual(PAY.reschedule, { times: 1, min_hours_before: 24 });
  for (const k of ['rule', 'reschedule', 'pay_button', 'note']) {
    assert.ok(PAY[`${k}_en`] && PAY[`${k}_ar`], `${k}_en and ${k}_ar`);
  }
  assert.match(PAY.pay_button_en, /demo/i);
});

test('a booking is created awaiting payment for the quoted total, and pay confirms it', () => {
  const { desk } = clockDesk();
  const total = desk.quote(ORDER, HUMAN).total;
  const { out } = bookFirst(desk);
  assert.equal(out.booking.status, 'awaiting_payment');
  assert.equal(out.booking.amount_due, total);
  assert.equal(out.booking.price_quoted, total);
  const paid = desk.pay(out.booking.reference, HUMAN);
  assert.equal(paid.ok, true);
  assert.equal(paid.booking.status, 'paid');
  assert.equal(desk.pay(out.booking.reference, HUMAN).booking.status, 'paid', 'paying twice changes nothing');
  assert.equal(desk.pay('BK-9999', HUMAN).error.code, 'unknown_booking');
  assert.equal(desk.pay(out.booking.reference, { door: 'agent' }).error.code, 'unknown_booking', 'only the door that booked');
});

test('an unpaid hold keeps the slot inside the window and frees it after; a late pay is refused', () => {
  const { clock, desk } = clockDesk();
  const { slot, out } = bookFirst(desk);
  const free = () => desk.checkAvailability({ from: '2026-10-06', days: 1 }).slots.map((s) => s.start);
  assert.ok(!free().includes(slot), 'held while unpaid');
  clock.t += (PAY.hold_minutes - 1) * 60_000;
  assert.ok(!free().includes(slot));
  clock.t += 2 * 60_000;
  assert.ok(free().includes(slot), 'freed after the window');
  assert.equal(desk.pay(out.booking.reference, HUMAN).error.code, 'hold_expired');
});

test('a paid booking keeps its slot after the window', () => {
  const { clock, desk } = clockDesk();
  const { slot, out } = bookFirst(desk);
  desk.pay(out.booking.reference, HUMAN);
  clock.t += (PAY.hold_minutes + 5) * 60_000;
  assert.ok(!desk.checkAvailability({ from: '2026-10-06', days: 1 }).slots.some((s) => s.start === slot));
});

test('after a booking awaiting payment the page gets a pay widget built from the booking, with no card fields', () => {
  const { desk } = clockDesk();
  const { out } = bookFirst(desk);
  const { ui, state } = widgetsFor({ toolCalls: [{ name: 'book', result: out }], state: newWidgetState(), booked: out.booking });
  assert.equal(ui.length, 1);
  const [w] = ui;
  assert.equal(w.type, 'pay');
  assert.equal(w.reference, out.booking.reference);
  assert.equal(w.amount, out.booking.amount_due);
  assert.equal(w.button_en, PAY.pay_button_en);
  assert.equal(w.button_ar, PAY.pay_button_ar);
  assert.ok(!Object.keys(w).some((k) => /card|iban|cvv|expir|account|fields|input/i.test(k)), 'no card or bank fields');
  assert.equal(state.awaitingPayment, out.booking.reference);
  assert.deepEqual(widgetsFor({ toolCalls: [], state }).ui, [], 'nothing more until the pay button is pressed');
});

test('paymentClaims flags "free" and "no payment now" claims in both languages, not free slots', () => {
  for (const s of ['The kickoff call is free.', 'You can book for free.', 'No payment is needed now.', 'You can pay later.',
    'Book now without paying.', 'المكالمة مجانية.', 'الحجز مجانًا', 'لا حاجة للدفع الآن', 'بدون دفع', 'يمكنك الدفع لاحقًا']) {
    assert.ok(paymentClaims(s).length, s);
  }
  for (const s of ['Pick a free time below.', 'Tuesday is open.', 'أوقات متاحة بالأسفل.', HO_EN(), HO_AR(), PAY.rule_en, PAY.rule_ar]) {
    assert.deepEqual(paymentClaims(s), [], s);
  }
});
function HO_EN() { return DATA.handover.tell_customer_en; }
function HO_AR() { return DATA.handover.tell_customer_ar; }

test('a reply that says the call is free is stopped like an invented price: corrected once, then handed over', async () => {
  const { desk } = clockDesk();
  const claim = { role: 'assistant', content: 'المكالمة مجانية، اختر موعدًا.' };
  const seen = [];
  const model = { async complete({ messages }) { seen.push(messages.length); return { message: claim, modelId: 'fake' }; } };
  const out = await createChat({ desk, model }).respond([], 'كم سعر المكالمة؟');
  assert.equal(seen.length, 2);
  assert.equal(out.guarded, true);
  assert.equal(out.reply, DATA.handover.tell_customer_ar);
});

test('the prompt and the book tool tell the model a booking is held until paid and to point to the pay button', async () => {
  const { SYSTEM_PROMPT } = await import('../src/chat.mjs');
  const { TOOLS } = await import('../src/tools.mjs');
  for (const text of [SYSTEM_PROMPT, TOOLS.find((t) => t.name === 'book').description]) {
    assert.match(text, /held until (?:it is )?paid/i);
    assert.match(text, /pay button below/i);
  }
  assert.match(SYSTEM_PROMPT, /never say .*booked.* before/i);
});
