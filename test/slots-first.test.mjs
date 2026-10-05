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

test('after the slots were shown, asking for name and contact passes unchanged', async () => {
  const label = firstLabel();
  const reply = `أقرب المواعيد:\n${label}\nلحجز الموعد أحتاج اسمك وبريدك.`;
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
