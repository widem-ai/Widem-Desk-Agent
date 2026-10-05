// Pick first (playbook v1, guardrail 10): the desk asks for name and contact only after the customer picked a slot.
// A live run showed the model asking for them in the same reply that offered the slots. Such a reply is held back
// once and the model is told to let the customer pick first. Scripted fake model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChat, asksForContactBeforePick } from '../src/chat.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';

const NOW = '2026-10-04T08:00:00+03:00';
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
const BOTH_AR = 'اختر موعدًا من الأوقات بالأسفل، وأرسل اسمك ورقم جوالك أو بريدك لإتمام الحجز.';
const PICK_AR = 'اختر موعدًا من الأوقات بالأسفل لمكالمة البداية.';

test('a reply that offers slots and asks for name and contact in the same turn is held back once', async () => {
  const model = scriptedModel([toolCall('a', 'check_availability', AVAIL), say(BOTH_AR), say(PICK_AR)]);
  const out = await createChat({ desk: fresh(), model }).respond([], 'متى المواعيد المتاحة؟');
  assert.equal(out.reply, PICK_AR);
  assert.equal(out.handover, undefined);
  const note = model.seen[2].at(-1);
  assert.equal(note.role, 'user');
  assert.match(note.content, /pick/i);
  assert.ok(!out.history.some((m) => m.content === BOTH_AR || m.content === note.content), 'held reply and note stay hidden');
});

test('the desk asks once: if the model asks again, that reply goes out and nothing is handed over', async () => {
  const model = scriptedModel([toolCall('a', 'check_availability', AVAIL), say(BOTH_AR), say(BOTH_AR)]);
  const out = await createChat({ desk: fresh(), model }).respond([], 'متى المواعيد المتاحة؟');
  assert.equal(out.reply, BOTH_AR);
  assert.equal(out.handover, undefined);
  assert.equal(model.seen.length, 3);
});

test('after the customer answered the slots, asking for name and contact passes', async () => {
  const first = scriptedModel([toolCall('a', 'check_availability', AVAIL), say(PICK_AR)]);
  const desk = fresh();
  const out = await createChat({ desk, model: first }).respond([], 'متى المواعيد؟');
  const ask = 'تم. أرسل اسمك ورقم جوالك لأكمل الحجز.';
  const next = scriptedModel([say(ask)]);
  const later = await createChat({ desk, model: next }).respond(out.history, 'الموعد الأول مناسب');
  assert.equal(later.reply, ask);
  assert.equal(next.seen.length, 1);
});

test('asksForContactBeforePick: only name and contact together, only while the newest slots are unanswered', () => {
  const offered = [{ role: 'user', content: 'when?' }, toolCall('a', 'check_availability', AVAIL)];
  assert.equal(asksForContactBeforePick('Pick a time and send your name and email.', offered), true);
  assert.equal(asksForContactBeforePick('Pick a time below.', offered), false);
  assert.equal(asksForContactBeforePick('Send your name.', offered), false);
  const answered = [...offered, { role: 'user', content: 'Tuesday 10:00' }];
  assert.equal(asksForContactBeforePick('Send your name and email.', answered), false);
  assert.equal(asksForContactBeforePick('Send your name and email.', [{ role: 'user', content: 'hi' }]), false,
    'no slots at all is the slots-first hold, not this one');
});

test('a customer who named one of the offered times in the same message has picked: no hold', async () => {
  const desk = fresh();
  const start = desk.checkAvailability(AVAIL).slots[0].start.slice(11, 16);
  const ask = 'That time is free. What is your name and email?';
  const model = scriptedModel([toolCall('a', 'check_availability', AVAIL), say(ask)]);
  const out = await createChat({ desk, model }).respond([], `CV rewrite, 5 years, Tuesday ${start} please`);
  assert.equal(out.reply, ask);
  assert.equal(model.seen.length, 2);
  // A time that is not one of the offered slots is not a pick.
  const late = scriptedModel([toolCall('a', 'check_availability', AVAIL), say(ask), say('Pick a time below.')]);
  const held = await createChat({ desk: fresh(), model: late }).respond([], 'Tuesday 23:00 please');
  assert.equal(held.reply, 'Pick a time below.');
});
