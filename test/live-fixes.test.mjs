// Fixes from the live Arabic sales run (vault: output/nebius-hackathon/sales-live-run-2026-10-05.md), 2026-10-05.
// Each case replays what the real model did in that run with a scripted model:
// 1. run 1 turn 6: "السعر الإجمالي: 550 ريال" with no quote call; 550 was only a line price of the earlier 950 quote.
// 2. run 1 turn 5: a loop reply with no tools showed the name-and-contact form before any slot was picked.
// 3. run 1 turn 8: "تم حجز مكالفتك" after book, before payment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChat } from '../src/chat.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { widgetsFor, newWidgetState } from '../src/widgets.mjs';

const NOW = '2026-10-04T08:00:00+03:00';
const AVAIL = { from: '2026-10-06', days: 1 };
const toolCall = (id, name, args) => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const say = (content) => ({ role: 'assistant', content });
const types = (ui) => ui.map((w) => w.type);

function session() {
  const desk = createDesk({ store: createMemoryStore(), now: () => new Date(NOW) });
  let history = []; let state = newWidgetState();
  return { desk, async turn(text, rounds) {
    const seen = [];
    const model = { async complete({ messages }) { seen.push(structuredClone(messages)); const s = rounds[Math.min(seen.length - 1, rounds.length - 1)]; return { message: typeof s === 'function' ? s(messages) : s, modelId: 'fake' }; } };
    const out = await createChat({ desk, model }).respond(history, text);
    history = out.history;
    const w = widgetsFor({ toolCalls: out.toolCalls, state, booked: out.booked, picked: out.picked });
    state = w.state;
    return { ...out, ui: w.ui, seen, tools: out.toolCalls.map((c) => c.name) };
  } };
}
// Run 1 up to the quote: CV rewrite and LinkedIn, 6 years (mid), quoted 950, slots offered.
async function quoted950(s) {
  const t = await s.turn('خبرتي ٦ سنوات في التسويق', [
    toolCall('q', 'quote', { services: ['cv_rewrite', 'linkedin_profile'], years_experience: 6 }), toolCall('a', 'check_availability', AVAIL),
    say('السعر الإجمالي: 950 ريال. يمكنك اختيار وقت من الخيارات أدناه.'),
  ]);
  assert.equal(t.toolCalls[0].result.total, 950);
  assert.ok(t.toolCalls[0].result.lines.some((l) => l.price === 550), 'the CV line price is 550, the case the guard let through');
  return t;
}
const desksNote = (seen) => seen.flat().filter((m) => m.role === 'user' && /^Desk check/.test(m.content ?? '')).map((m) => m.content);

test('a total from an old quote line, with no quote this turn, is held once and the model is told to call quote', async () => {
  const s = session();
  await quoted950(s);
  const t = await s.turn('تمام، نبدأ بإعادة كتابة السيرة الذاتية', [
    say('جيد، نبدأ بإعادة كتابة السيرة الذاتية فقط. السعر الإجمالي: 550 ريال.'),
    toolCall('q2', 'quote', { services: ['cv_rewrite'], years_experience: 6 }),
    say('نبدأ بإعادة كتابة السيرة الذاتية فقط. السعر الإجمالي: 550 ريال. اختر وقتًا من الأوقات أدناه.'),
  ]);
  assert.equal(t.seen.length, 3, 'the first reply was held back');
  assert.ok(desksNote(t.seen).some((n) => /call quote/i.test(n)), 'the note asks for quote');
  assert.deepEqual(t.tools, ['quote']);
  assert.equal(t.toolCalls[0].result.total, 550);
  assert.ok(types(t.ui).includes('quote'), 'the customer now sees the 550 card');
  assert.ok(!t.history.some((m) => m.content === 'جيد، نبدأ بإعادة كتابة السيرة الذاتية فقط. السعر الإجمالي: 550 ريال.'), 'the held reply is not in history');
});

test('held once only: a model that repeats the stale total gets its second reply out, no handover', async () => {
  const s = session();
  await quoted950(s);
  const t = await s.turn('تمام، نبدأ بإعادة كتابة السيرة الذاتية', [say('السعر الإجمالي: 550 ريال.')]);
  assert.equal(t.seen.length, 2);
  assert.equal(t.reply, 'السعر الإجمالي: 550 ريال.');
  assert.equal(t.handover, undefined);
});

test('the latest quote total said again on a later turn goes out without a hold', async () => {
  const s = session();
  await quoted950(s);
  const t = await s.turn('كم المجموع مرة ثانية؟', [say('المجموع 950 ريال. اختر وقتًا من الأوقات أعلاه.')]);
  assert.equal(t.seen.length, 1);
  assert.equal(t.reply, 'المجموع 950 ريال. اختر وقتًا من الأوقات أعلاه.');
});

test('no contact form under a loop reply: slots shown, nothing picked yet', async () => {
  const s = session();
  await quoted950(s);
  const t = await s.turn('السعر شوي غالي', [say('أفهم ذلك. يمكننا البدء بخدمة واحدة فقط. هل ترغب في ذلك؟')]);
  assert.ok(!types(t.ui).includes('contact'), 'contact waits for a picked slot');
});

test('the contact form comes after the customer picks one of the offered slots (the page chip message)', async () => {
  const s = session();
  const t1 = await quoted950(s);
  const slot = t1.toolCalls[1].result.slots[0];
  const t = await s.turn(`أختار موعد ${slot.label_ar}`, [say('من فضلك أخبرني باسمك ووسيلة تواصل.')]);
  assert.equal(t.picked, true);
  assert.deepEqual(types(t.ui), ['contact']);
});

test('after book the reply is built in code: held until payment, pay below; never "booked" before payment', async () => {
  const s = session();
  const t1 = await quoted950(s);
  const slot = t1.toolCalls[1].result.slots[0];
  await s.turn(`أختار موعد ${slot.label_ar}`, [say('من فضلك أخبرني باسمك ووسيلة تواصل.')]);
  const t = await s.turn('اسمي سارة تجربة، والتواصل: test@example.com', [
    toolCall('b', 'book', { services: ['cv_rewrite', 'linkedin_profile'], years_experience: 6, slot: slot.start, customer_name: 'سارة تجربة', contact: 'test@example.com' }),
    say('تم حجز مكالفتك تحت المرجع BK-0001؛ يرجى استخدام زر الدفع أدناه.'),
  ]);
  const booking = t.toolCalls.find((c) => c.name === 'book').result.booking;
  assert.ok(booking, `book ran: ${JSON.stringify(t.toolCalls[0].result.error ?? '')}`);
  assert.doesNotMatch(t.reply, /تم حجز|تم تأكيد|مؤكد|\bbooked\b|\bconfirmed\b/i);
  assert.ok(t.reply.includes(booking.reference));
  assert.ok(t.reply.includes(String(booking.amount_due)));
  assert.ok(t.reply.includes(slot.label_ar), 'the slot label from the tool');
  assert.match(t.reply, /الدفع|ادفع/);
  assert.deepEqual(types(t.ui), ['pay']);
});

test('the English post-book line says held and pay below, with no "booked"', async () => {
  const s = session();
  const t1 = await s.turn('CV rewrite, 6 years. How much?', [
    toolCall('q', 'quote', { services: ['cv_rewrite'], years_experience: 6 }), toolCall('a', 'check_availability', AVAIL), say('Total 550 SAR. Pick a time below.')]);
  const slot = t1.toolCalls[1].result.slots[0];
  const t = await s.turn('Sara Test, test@example.com', [
    toolCall('b', 'book', { services: ['cv_rewrite'], years_experience: 6, slot: slot.start, customer_name: 'Sara Test', contact: 'test@example.com' }),
    say('You are booked! Reference BK-0001.'),
  ]);
  const booking = t.toolCalls[0].result.booking;
  assert.ok(booking, JSON.stringify(t.toolCalls[0].result.error ?? ''));
  assert.doesNotMatch(t.reply, /\bbooked\b|\bconfirmed\b/i);
  assert.match(t.reply, /held/i);
  assert.match(t.reply, /pay/i);
  assert.ok(t.reply.includes(booking.reference) && t.reply.includes(slot.label_en));
});
