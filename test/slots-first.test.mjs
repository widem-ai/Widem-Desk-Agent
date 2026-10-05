// Slots first (Mohannad, 2026-10-05): the desk shows the free slots before it asks for a name and contact.
// A reply that asks for them before any slot was shown is held back once and the model is told to list the slots.
// Scripted fake model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChat } from '../src/chat.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';

const NOW = '2026-10-04T08:00:00+03:00'; // Sunday, before opening
const fresh = () => createDesk({ store: createMemoryStore(), now: () => new Date(NOW) });
function scriptedModel(rounds) {
  const seen = [];
  return { seen, async complete({ messages }) {
    seen.push(structuredClone(messages));
    return { message: rounds[Math.min(seen.length - 1, rounds.length - 1)], modelId: 'fake/scripted' };
  } };
}
const toolCall = (id, name, args) => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const say = (content) => ({ role: 'assistant', content });
const AVAIL = { from: '2026-10-06', days: 1 };
const firstLabel = () => fresh().checkAvailability(AVAIL).slots[0].label_ar;
const ASK_AR = 'لأعرض لك المواعيد أحتاج اسمك وبريدك الإلكتروني أو رقم هاتفك.';

test('a reply that asks for name and contact before any slot was shown is held back, and the slots come first', async () => {
  const label = firstLabel();
  const listed = `أقرب المواعيد:\n${label}\nاختر موعدًا وأرسل اسمك وبريدك.`;
  const model = scriptedModel([say(ASK_AR), toolCall('a', 'check_availability', AVAIL), say(listed)]);
  const out = await createChat({ desk: fresh(), model }).respond([], 'ما هي أقرب المواعيد؟');
  assert.equal(out.reply, listed);
  assert.equal(out.handover, undefined);
  // The model was told why, and the customer never saw the held-back reply or the desk's note.
  const note = model.seen[1].at(-1);
  assert.equal(note.role, 'user');
  assert.match(note.content, /check_availability/);
  assert.ok(!out.history.some((m) => m.content === ASK_AR || m.content === note.content));
});

test('after the slots were shown and the customer answered, asking for name and contact passes unchanged', async () => {
  const label = firstLabel();
  const reply = `أقرب المواعيد:\n${label}\nاختر موعدًا.`; // pick first: a same-turn ask is held (slot-pick.test.mjs)
  const model = scriptedModel([toolCall('a', 'check_availability', AVAIL), say(reply)]);
  const out = await createChat({ desk: fresh(), model }).respond([], 'متى المواعيد؟');
  assert.equal(out.reply, reply);
  assert.equal(model.seen.length, 2);
  // And on a later turn too: the slots shown earlier in the session count.
  const next = scriptedModel([say('ممتاز، أرسل اسمك ورقم هاتفك لأكمل الحجز.')]);
  const later = await createChat({ desk: fresh(), model: next }).respond(out.history, 'الموعد الأول مناسب');
  assert.equal(later.reply, 'ممتاز، أرسل اسمك ورقم هاتفك لأكمل الحجز.');
  assert.equal(next.seen.length, 1);
});

test('the desk asks once: if the model asks for contact again, that reply goes out and nothing is handed over', async () => {
  const ask = 'To show you the times I need your name and an email or phone number.';
  const model = scriptedModel([say(ask), say(ask)]);
  const out = await createChat({ desk: fresh(), model }).respond([], 'When are you free?');
  assert.equal(out.reply, ask);
  assert.equal(out.handover, undefined);
  assert.equal(model.seen.length, 2);
});

test('a reply that asks for nothing passes on the first round', async () => {
  const model = scriptedModel([say('أهلًا بك، كيف أساعدك؟')]);
  const out = await createChat({ desk: fresh(), model }).respond([], 'مرحبا');
  assert.equal(out.reply, 'أهلًا بك، كيف أساعدك؟');
  assert.equal(model.seen.length, 1);
  // Asking only for a name (no contact) is a greeting, not a hold on the slots.
  const greet = scriptedModel([say('أهلًا، ما اسمك الكريم؟')]);
  assert.equal((await createChat({ desk: fresh(), model: greet }).respond([], 'مرحبا')).reply, 'أهلًا، ما اسمك الكريم؟');
  assert.equal(greet.seen.length, 1);
});

// The run-4 regression (2026-10-05): the held-back reply stated the quoted price, the model's next reply listed
// the slots and dropped it. The customer must still see the total, taken from the quote result.
const ORDER = { services: ['cv_rewrite', 'cover_letter'], years_experience: 5, is_executive: false };

test('a reply held back for slots-first still carries the quoted total, from the quote result', async () => {
  const label = firstLabel();
  const slotsOnly = `المواعيد المتاحة:\n${label}\nاختر موعدًا وأرسل اسمك وبريدك.`;
  const model = scriptedModel([toolCall('q', 'quote', ORDER), say('السعر 750 ريال. أرسل اسمك وبريدك لأعرض المواعيد.'),
    toolCall('a', 'check_availability', AVAIL), say(slotsOnly)]);
  const out = await createChat({ desk: fresh(), model }).respond([], 'كم سعر السيرة الذاتية مع خطاب التقديم؟ خبرتي 5 سنوات');
  assert.equal(out.reply, `السعر الإجمالي: 750 ريال.\n\n${slotsOnly}`);
  const en = scriptedModel([toolCall('q', 'quote', ORDER), say('It is 750 SAR. Send your name and email for the times.'),
    toolCall('a', 'check_availability', AVAIL), say('Free: Tuesday 10:00 to 11:00. Which one?')]);
  const outEn = await createChat({ desk: fresh(), model: en }).respond([], 'Price for CV and cover letter? 5 years.');
  assert.equal(outEn.reply, 'Total: 750 SAR.\n\nFree: Tuesday 10:00 to 11:00. Which one?');
});

test('the total is not added twice when the reply after the hold states it, nor to a reply that was not held back', async () => {
  const label = firstLabel();
  const withPrice = `الإجمالي 750 ريال.\n${label}`;
  const held = scriptedModel([toolCall('q', 'quote', ORDER), say('السعر 750 ريال. أرسل اسمك وبريدك.'),
    toolCall('a', 'check_availability', AVAIL), say(withPrice)]);
  assert.equal((await createChat({ desk: fresh(), model: held }).respond([], 'كم السعر؟')).reply, withPrice);
  const plain = `المواعيد:\n${label}`;
  const notHeld = scriptedModel([toolCall('q', 'quote', ORDER), toolCall('a', 'check_availability', AVAIL), say(plain)]);
  assert.equal((await createChat({ desk: fresh(), model: notHeld }).respond([], 'متى؟')).reply, plain);
});

test('the added total is followed by exactly one blank line, even when the model reply starts with blank lines', async () => {
  const model = scriptedModel([toolCall('q', 'quote', ORDER), say('السعر 750 ريال. أرسل اسمك وبريدك.'),
    toolCall('a', 'check_availability', AVAIL), say('\n\nاختر موعدًا من القائمة.')]);
  const out = await createChat({ desk: fresh(), model }).respond([], 'كم السعر؟');
  assert.equal(out.reply, 'السعر الإجمالي: 750 ريال.\n\nاختر موعدًا من القائمة.');
});
