// Display labels per language, so an Arabic reply never needs an id or an English word, and two
// deterministic post-steps on chat replies: the booking confirmation always restates slot and price,
// and a teaser line ("and more...") never reaches the customer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChat } from '../src/chat.mjs';
import { ungrounded } from '../src/guard.mjs';
import { latinWords } from '../src/latin.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { PROFILES } from './profiles.mjs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const at = (iso) => () => new Date(iso);
const NOW = '2026-10-04T08:00:00+03:00';
const SLOT = '2026-10-06T10:00:00+03:00';
const ORDER = PROFILES[1].order; // 1575
const CUSTOMER = { customer_name: 'سارة', contact: 'sara@example.com' };
const fresh = () => { const store = createMemoryStore(); return { store, desk: createDesk({ store, now: at(NOW) }) }; };
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
const toolResults = (model) => model.seen.at(-1).filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));

test('free slots carry a label in each language, and the call has a name in each language', () => {
  const r = fresh().desk.checkAvailability({ from: '2026-10-06', days: 1 });
  const [first] = r.slots;
  assert.equal(first.start, SLOT);
  assert.match(first.label_en, /Tuesday/);
  assert.match(first.label_en, /6 October/);
  assert.match(first.label_en, /10:00 to 11:00/);
  assert.match(first.label_en, /Riyadh/);
  assert.match(first.label_ar, /الثلاثاء/);
  assert.match(first.label_ar, /أكتوبر/);
  assert.match(first.label_ar, /10:00 إلى 11:00/);
  assert.match(first.label_ar, /بتوقيت الرياض/);
  assert.deepEqual(latinWords(first.label_ar), []);
  assert.equal(r.call_name_en, DATA.availability.call_name_en);
  assert.equal(r.call_name_ar, DATA.availability.call_name_ar);
  assert.deepEqual(latinWords(r.call_name_ar), []);
});

test('a quote names its tier and add-ons in both languages, from the data', () => {
  const q = fresh().desk.quote(PROFILES[3].order, { door: 'agent' });
  const tier = DATA.tiers.find((t) => t.id === 'executive');
  assert.equal(q.tier_name_en, tier.name_en);
  assert.equal(q.tier_name_ar, tier.name_ar);
  for (const a of q.addons) {
    const source = DATA.addons.find((x) => x.id === a.id);
    assert.equal(a.name_en, source.name_en);
    assert.equal(a.name_ar, source.name_ar);
  }
});

test('a confirmation without slot or price gets them added from the book result, and the guard still passes', async () => {
  const { desk, store } = fresh();
  const model = scriptedModel([toolCall('b', 'book', { ...ORDER, slot: SLOT, ...CUSTOMER }), say('تم الحجز. رقم الحجز BK-0001.')]);
  const out = await createChat({ desk, model }).respond([], 'احجز لي الثلاثاء الساعة 10');
  assert.ok(out.reply.startsWith('تم الحجز. رقم الحجز BK-0001.'));
  assert.match(out.reply, /الثلاثاء/);
  assert.match(out.reply, /10:00 إلى 11:00/);
  assert.match(out.reply, /1575 ريال/);
  assert.deepEqual(latinWords(out.reply), []);
  assert.deepEqual(ungrounded(out.reply, toolResults(model)), []);
  assert.ok(store.all('bookings')[0].transcript.endsWith(out.reply), 'the stored conversation has what the customer saw');
});

test('a confirmation that already states slot and price passes byte-identical', async () => {
  const { desk } = fresh();
  const text = 'Booked: BK-0001, Tuesday 6 October 10:00 to 11:00 Riyadh time, 1575 SAR.';
  const model = scriptedModel([toolCall('b', 'book', { ...ORDER, slot: SLOT, ...CUSTOMER }), say(text)]);
  assert.equal((await createChat({ desk, model }).respond([], 'Book Tuesday 10:00')).reply, text);
});

test('teaser lines ("and more", an ellipsis) are dropped from a slot list; the slots stay', async () => {
  const { desk } = fresh();
  const model = scriptedModel([toolCall('a', 'check_availability', { from: '2026-10-06', days: 1 }), say([
    'أقرب المواعيد:', '', '- الثلاثاء 10:00 إلى 11:00', '- الثلاثاء 11:00 إلى 12:00', '- … (وغيرها من الفترات المذكورة في القائمة)',
    '', '(وهناك مواعيد إضافية في الأيام التالية إذا لم تناسبك هذه.)', '', 'لحجز الموعد، أرسل اسمك وبريدك.'].join('\n'))]);
  const out = await createChat({ desk, model }).respond([], 'متى؟');
  assert.equal(out.reply, 'أقرب المواعيد:\n\n- الثلاثاء 10:00 إلى 11:00\n- الثلاثاء 11:00 إلى 12:00\n\nلحجز الموعد، أرسل اسمك وبريدك.');
  const en = scriptedModel([toolCall('a', 'check_availability', { from: '2026-10-06', days: 1 }),
    say('Free:\n- 10:00 to 11:00\n...\n(More slots are available later in the week.)\nWhich one?')]);
  assert.equal((await createChat({ desk: fresh().desk, model: en }).respond([], 'When?')).reply, 'Free:\n- 10:00 to 11:00\nWhich one?');
});
