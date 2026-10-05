// One recommendation (Alfred, 2026-10-05, per the playbook): in the turn the recommendation card appears, the model's
// own quote card is dropped and the stated total must be the card's, unless the customer's own messages named the
// extra services; then their quote card and total stay. Same setup as recommend-card.test.mjs (the live Arabic run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChat } from '../src/chat.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { widgetsFor, newWidgetState } from '../src/widgets.mjs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const MID = DATA.tiers.find((t) => t.id === 'mid').name_ar;
const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const say = (content) => ({ role: 'assistant', content });
const HISTORY = [
  { role: 'user', content: 'أفكر أطور مساري، وش تقترحون؟' }, call('g', 'ask_choice', { topic: 'goal' }),
  { role: 'tool', tool_call_id: 'g', content: '{"ok":true,"topic":"goal","options":[]}' }, say('ما هدفك الآن؟'),
  { role: 'user', content: 'وظيفة جديدة' }, call('y', 'ask_choice', { topic: 'years' }),
  { role: 'tool', tool_call_id: 'y', content: '{"ok":true,"topic":"years","options":[]}' }, say('كم سنة خبرتك؟'),
];
function chatWith(rounds) {
  let i = 0;
  const desk = createDesk({ store: createMemoryStore(), now: () => new Date('2026-10-04T08:00:00+03:00') });
  return createChat({ desk, model: { async complete() { return { message: rounds[Math.min(i++, rounds.length - 1)], modelId: 'fake' }; } } });
}
const types = (out) => widgetsFor({ toolCalls: out.toolCalls, state: newWidgetState() }).ui.map((w) => w.type);

test('an uninvited LinkedIn quote shows no second card, and its 950 is held back for the card total 550', async () => {
  const out = await chatWith([call('q', 'quote', { services: ['cv_rewrite', 'linkedin_profile'], years_experience: 6 }),
    say('السعر الإجمالي 950 ريال.'), say('هدفك وظيفة جديدة. السعر 550 ريال، اختر موعدًا.')]).respond(HISTORY, MID);
  assert.deepEqual(types(out), ['recommend']);
  assert.match(out.reply, /550/);
  assert.doesNotMatch(out.reply, /950/);
});

test('extras the customer named keep their quote card and their total', async () => {
  const asked = [...HISTORY]; asked[4] = { role: 'user', content: 'وظيفة جديدة، وعندي مقابلة قريبًا' };
  const out = await chatWith([call('q', 'quote', { services: ['cv_rewrite', 'interview_coaching'], years_experience: 3 }),
    say('المجموع 1000 ريال.')]).respond(asked, MID);
  assert.deepEqual(types(out), ['recommend', 'quote']);
  assert.equal(out.reply, 'المجموع 1000 ريال.');
});

test('a later turn without a card is not pinned: a new quote the customer asks for shows and its total passes', async () => {
  const first = await chatWith([say('هدفك وظيفة جديدة. اختر موعدًا.')]).respond(HISTORY, MID);
  const out = await chatWith([call('q', 'quote', { services: ['cv_rewrite', 'linkedin_profile'], years_experience: 3 }),
    say('مع ملف LinkedIn يصبح المجموع 950 ريال.')]).respond(first.history, 'أبغى أضيف ملف لينكد إن');
  assert.deepEqual(types(out), ['quote']);
  assert.match(out.reply, /950/);
});
