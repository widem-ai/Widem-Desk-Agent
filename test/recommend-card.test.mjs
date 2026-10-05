// The recommendation card through the chat (slice C, Alfred 2026-10-05). Once the customer has answered the goal
// (a goal button, or typed text naming a goal label) and tapped a years button (tier from the button, never from a
// number of years), the desk quotes the fit table's recommendation itself before the model replies, and the page
// shows one card: the goal said back, the services, the why line, and the total from that quote. From the live Arabic
// run: new job + mid, LinkedIn never mentioned, so CV rewrite only even if the model quotes LinkedIn as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChat, SYSTEM_PROMPT } from '../src/chat.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { widgetsFor, newWidgetState } from '../src/widgets.mjs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const tierLabel = (id, lang = 'ar') => DATA.tiers.find((t) => t.id === id)[`name_${lang}`];
const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const say = (content) => ({ role: 'assistant', content });
const HISTORY = [
  { role: 'user', content: 'أفكر أطور مساري، وش تقترحون؟' }, call('g', 'ask_choice', { topic: 'goal' }),
  { role: 'tool', tool_call_id: 'g', content: '{"ok":true,"topic":"goal","options":[]}' }, say('ما هدفك الآن؟'),
  { role: 'user', content: 'وظيفة جديدة' }, call('y', 'ask_choice', { topic: 'years' }),
  { role: 'tool', tool_call_id: 'y', content: '{"ok":true,"topic":"years","options":[]}' }, say('كم سنة خبرتك؟'),
];

function chatWith(rounds) {
  const seen = []; let i = 0;
  const desk = createDesk({ store: createMemoryStore(), now: () => new Date('2026-10-04T08:00:00+03:00') });
  const model = { async complete({ messages }) { seen.push(messages.map((m) => ({ ...m }))); return { message: rounds[Math.min(i++, rounds.length - 1)], modelId: 'fake' }; } };
  return { chat: createChat({ desk, model }), seen };
}
const recOf = (out) => out.toolCalls.find((c) => c.name === 'recommend')?.result;
const card = (out) => widgetsFor({ toolCalls: out.toolCalls, state: newWidgetState() }).ui.find((w) => w.type === 'recommend');

test('live run: goal button then the mid years button: the desk quotes CV rewrite itself and the model sees that quote', async () => {
  const { chat, seen } = chatWith([say('هدفك وظيفة جديدة، وأنصحك بإعادة كتابة السيرة الذاتية. اختر موعدًا لمكالمة البداية.')]);
  const out = await chat.respond(HISTORY, tierLabel('mid'));
  const rec = recOf(out);
  assert.ok(rec, 'a recommendation this turn');
  assert.deepEqual(rec.services.map((s) => s.id), ['cv_rewrite']);
  assert.equal(rec.quote.total, 550, 'CV rewrite at mid, from quote');
  const deskQuote = seen[0].find((m) => m.role === 'tool' && m.tool_call_id.startsWith('desk_rec'));
  assert.equal(JSON.parse(deskQuote.content).total, 550, 'the model is shown the desk quote before it replies');
  const c = card(out);
  assert.equal(c.goal_line_ar, 'هدفك: وظيفة جديدة');
  assert.equal(c.goal_line_en, 'Your goal: new job');
  assert.equal(c.why_ar, DATA.fit.rules.find((r) => r.goal === 'new_job' && !r.linkedin).why_ar);
  assert.equal(c.total, 550); assert.equal(c.currency, 'SAR');
  assert.equal(c.status, 'default');
  const { ui } = widgetsFor({ toolCalls: out.toolCalls, state: newWidgetState() });
  assert.ok(!ui.some((w) => w.type === 'details'), 'no services picker under the card');
});

test('the model adding LinkedIn on its own does not change the card', async () => {
  const { chat } = chatWith([call('q', 'quote', { services: ['cv_rewrite', 'linkedin_profile'], years_experience: 6 }), say('السعر الإجمالي 950 ريال.')]);
  const out = await chat.respond(HISTORY, tierLabel('mid'));
  assert.deepEqual(card(out).services.map((s) => s.id), ['cv_rewrite']);
  assert.equal(card(out).total, 550);
});

test('LinkedIn counts only when the customer said it: career pack then; a desk message naming it does not count', async () => {
  const said = [...HISTORY]; said[4] = { role: 'user', content: 'وظيفة جديدة، وحسابي في لينكد إن ضعيف' };
  const a = await chatWith([say('حسنًا.')]).chat.respond(said, tierLabel('mid'));
  assert.deepEqual(recOf(a).services.map((s) => s.id), ['cv_rewrite', 'linkedin_profile', 'cover_letter']);
  const deskSaid = [...HISTORY]; deskSaid[7] = say('كم سنة خبرتك؟ ونقدم أيضًا تحسين ملف LinkedIn.');
  const b = await chatWith([say('حسنًا.')]).chat.respond(deskSaid, tierLabel('mid'));
  assert.deepEqual(recOf(b).services.map((s) => s.id), ['cv_rewrite']);
});

test('the tier comes from the tapped button: executive is is_executive, junior is never priced as mid', async () => {
  const exec = await chatWith([say('حسنًا.')]).chat.respond(HISTORY, tierLabel('executive'));
  assert.equal(recOf(exec).quote.tier, 'executive');
  assert.equal(recOf(exec).quote.total, 1400);
  const junior = await chatWith([say('Sure.')]).chat.respond(HISTORY, tierLabel('junior', 'en'));
  assert.equal(recOf(junior).quote.tier, 'junior');
  assert.equal(recOf(junior).quote.total, 350);
});

test('no card without both answers, for "something else", or a second time in the session', async () => {
  const typedYears = await chatWith([say('حسنًا.')]).chat.respond(HISTORY, 'خبرتي ٦ سنوات');
  assert.equal(recOf(typedYears), undefined, 'typed years: no tier button, no card (the model may still quote)');
  // A surviving planted break (any digit read as a tier) showed the line above only tried Arabic-Indic digits.
  for (const typed of ['خبرتي 6 سنوات', 'I have 3 years', '0 to 3']) {
    assert.equal(recOf(await chatWith([say('ok')]).chat.respond(HISTORY, typed)), undefined, typed);
  }
  const other = [...HISTORY]; other[4] = { role: 'user', content: 'هدف آخر' };
  assert.equal(recOf(await chatWith([say('حسنًا.')]).chat.respond(other, tierLabel('mid'))), undefined);
  const first = await chatWith([say('حسنًا.')]).chat.respond(HISTORY, tierLabel('mid'));
  const again = await chatWith([say('حسنًا.')]).chat.respond(first.history, 'وظيفة جديدة');
  assert.equal(recOf(again), undefined, 'once per session');
});

test('the prompt tells the model the card exists: goal back in one sentence, the booking ask, no prices re-listed', () => {
  assert.match(SYSTEM_PROMPT, /desk_rec/);
  assert.match(SYSTEM_PROMPT, /card/);
  assert.match(SYSTEM_PROMPT, /goal back in one short sentence/);
  assert.match(SYSTEM_PROMPT, /do not list the services or prices again/);
});

test('the page draws the recommendation card', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /w\.type === 'recommend'/);
  assert.match(page, /function recommendCard/);
});
