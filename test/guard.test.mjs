// The invented-price and invented-slot guard: a reply may state a SAR amount or a time only when a
// desk tool returned it in this turn or earlier in the session. Scripted fake model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChat } from '../src/chat.mjs';
import { ungrounded } from '../src/guard.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { PROFILES } from './profiles.mjs';

const at = (iso) => () => new Date(iso);
const NOW = '2026-10-04T08:00:00+03:00';
const ORDER = PROFILES[1].order; // total 1575

function scriptedModel(rounds) {
  const seen = [];
  return {
    seen,
    async complete({ messages }) {
      seen.push(structuredClone(messages));
      return { message: rounds[Math.min(seen.length - 1, rounds.length - 1)], modelId: 'fake/scripted' };
    },
  };
}
const toolCall = (id, name, args) => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const say = (content) => ({ role: 'assistant', content });
const fresh = () => {
  const store = createMemoryStore();
  return { store, desk: createDesk({ store, now: at(NOW) }) };
};

test('ungrounded() finds amounts and times in Western and Arabic digits, and ignores harmless numbers', () => {
  const results = [{ total: 1575, lines: [{ price: 850 }] }, { slots: [{ start: '2026-10-06T14:00:00+03:00' }] }];
  assert.deepEqual(ungrounded('The total is 1,575 SAR.', results), []);
  assert.deepEqual(ungrounded('المجموع ١٥٧٥ ريال', results), []);
  assert.deepEqual(ungrounded('SAR 850 for the CV.', results), []);
  assert.deepEqual(ungrounded('Tuesday at 2:00 pm or 14:00 works.', results), []);
  assert.deepEqual(ungrounded('With 12 years of experience you are senior; the kickoff is a 60-minute call in 2026.', results), []);
  assert.deepEqual(ungrounded('It is 999 SAR.', results), ['999 SAR']);
  assert.deepEqual(ungrounded('السعر ٩٩٩ ريال', results), ['999 SAR']);
  assert.deepEqual(ungrounded('I can do 09:30.', results), ['09:30']);
  assert.deepEqual(ungrounded('الساعة ١١:٠٠ متاحة', results), ['11:00']);
  assert.deepEqual(ungrounded('How about 3 pm?', results), ['15:00']);
});

test('a correct quoted price passes byte-identical', async () => {
  const { desk } = fresh();
  const text = '\nThe full career pack at the senior tier is 1575 SAR (10% bundle discount applied).';
  const model = scriptedModel([toolCall('q', 'quote', ORDER), say(text)]);
  const out = await createChat({ desk, model }).respond([], 'Full pack, senior. Price?');
  assert.equal(out.reply, text);
  assert.equal(model.seen.length, 2);
});

test('harmless numbers with no tool call pass untouched', async () => {
  const { desk } = fresh();
  const text = 'With 12 years of experience you are on the senior tier. The kickoff is a 60-minute call.';
  const out = await createChat({ desk, model: scriptedModel([say(text)]) }).respond([], 'I have 12 years');
  assert.equal(out.reply, text);
});

test('an invented price is re-asked once, and a corrected reply goes out without the bad one in history', async () => {
  const { desk } = fresh();
  const model = scriptedModel([say('That is 999 SAR.'), toolCall('q', 'quote', ORDER), say('That is 1575 SAR.')]);
  const out = await createChat({ desk, model }).respond([], 'Full pack, senior. Price?');
  assert.equal(out.reply, 'That is 1575 SAR.');
  const correction = model.seen[1].at(-1);
  assert.equal(correction.role, 'user');
  assert.match(correction.content, /999 SAR/);
  assert.ok(!JSON.stringify(out.history).includes('999'), 'the invented reply and the correction stay out of history');
});

test('a price grounded earlier in the session passes in a later turn', async () => {
  const { desk } = fresh();
  const chat = createChat({ desk, model: scriptedModel([toolCall('q', 'quote', ORDER), say('1575 SAR.'), say('Yes, still 1575 SAR.')]) });
  const first = await chat.respond([], 'Price?');
  const second = await chat.respond(first.history, 'Still the same?');
  assert.equal(second.reply, 'Yes, still 1575 SAR.');
});

test('an invented slot twice in a row never reaches the customer: it is handed to a person', async () => {
  const { desk, store } = fresh();
  const model = scriptedModel([toolCall('a', 'check_availability', { from: '2026-10-06', days: 1 }),
    say('موعدك الساعة ٠٩:٣٠'), say('موعدك الساعة ٠٩:٣٠')]);
  const out = await createChat({ desk, model }).respond([], 'متى أقرب موعد؟');
  assert.ok(!out.reply.includes('٠٩:٣٠'));
  assert.equal(out.guarded, true);
  const [ho] = store.all('handovers');
  assert.equal(ho.door, 'human');
  assert.ok(!ho.transcript.includes('٠٩:٣٠'));
  assert.match(out.reply, /[؀-ۿ]/);
});

test('a quote refusal handed over through the chat keeps the transcript', async () => {
  const { desk, store } = fresh();
  const model = scriptedModel([toolCall('q', 'quote', { services: ['tax_advice'], years_experience: 10 }), say('A person will reply.')]);
  await createChat({ desk, model }).respond([], 'I need tax advice');
  const [ho] = store.all('handovers');
  assert.equal(ho.reason, 'unknown_service');
  assert.match(ho.transcript, /tax advice/);
});

test('dashes and non-breaking hyphens in a reply are replaced with plain characters', async () => {
  const { desk } = fresh();
  const model = scriptedModel([toolCall('a', 'check_availability', { from: '2026-10-06', days: 1 }),
    say('Free on 2026\u201110\u201106: 10:00 \u2013 11:00 or 14:00\u201415:00. Great \u2014 shall I book one?')]);
  const out = await createChat({ desk, model }).respond([], 'When are you free?');
  assert.equal(out.reply, 'Free on 2026-10-06: 10:00 to 11:00 or 14:00 to 15:00. Great, shall I book one?');
  assert.ok(!JSON.stringify(out.history).match(/[\u2010-\u2015]/), 'the cleaned reply is what history keeps');
});

test('an Arabic range reads with a plain word, and the guard still checks the cleaned reply', async () => {
  const { desk } = fresh();
  const model = scriptedModel([toolCall('a', 'check_availability', { from: '2026-10-06', days: 1 }),
    say('متاح من 10:00 \u2013 11:00'), say('متاح من 09:30 \u2013 10:30'), say('متاح من 09:30 \u2013 10:30')]);
  const chat = createChat({ desk, model });
  assert.equal((await chat.respond([], 'متى؟')).reply, 'متاح من 10:00 إلى 11:00');
  const invented = await createChat({ desk, model: scriptedModel([say('متاح من 09:30 \u2013 10:30')]) }).respond([], 'متى؟');
  assert.equal(invented.guarded, true);
});
