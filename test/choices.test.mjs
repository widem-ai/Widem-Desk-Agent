// Discovery answers as tappable buttons (desk playbook v1, slice 2, 2026-10-05). The model signals the question
// type with the ask_choice tool and a topic from a fixed list; code checks the topic and builds the buttons from the
// rules file. Nothing is parsed from the model's text. "declined" marks a clear no: that turn shows no widget at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toolsFor } from '../src/tools.mjs';
import { widgetsFor, newWidgetState } from '../src/widgets.mjs';
import { CHAT_TOOLS, createChat } from '../src/chat.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const ask = toolsFor('human').find((t) => t.name === 'ask_choice');
const run = (topic) => ask.run(null, { topic });
const types = (ui) => ui.map((w) => w.type);
const ids = (r) => r.options.map((o) => o.id);

test('ask_choice is a tool for the human door only: agents on the MCP door are not sold to', () => {
  assert.ok(ask, 'the chat door has ask_choice');
  assert.ok(CHAT_TOOLS.some((t) => t.function.name === 'ask_choice'), 'the chat model is offered it');
  assert.ok(!toolsFor('agent').some((t) => t.name === 'ask_choice'), 'the agent door does not get it');
});

test('goal and timeline return the fixed options from the rules file, in both languages', () => {
  const goal = run('goal');
  assert.equal(goal.ok, true);
  assert.deepEqual(ids(goal), ['new_job', 'promotion', 'career_switch', 'other']);
  assert.deepEqual(ids(run('timeline')), ['this_month', 'one_to_three_months', 'later']);
  assert.deepEqual(goal.options, DATA.choices.goal.options, 'options come from the data file, not code');
  for (const topic of ['goal', 'timeline']) {
    for (const o of run(topic).options) {
      assert.ok(o.en && o.ar, `${topic}.${o.id} has both labels`);
      assert.doesNotMatch(o.ar, /[A-Za-z]/, `${topic}.${o.id}: no Latin letters in Arabic`);
      assert.doesNotMatch(`${o.en}${o.ar}`, /[–—]/, `${topic}.${o.id}: no en or em dashes`);
    }
  }
  assert.deepEqual(run('declined'), { ok: true, topic: 'declined', options: [] });
});

test('a topic outside the fixed list is refused, so budget or contact can never become buttons', () => {
  for (const topic of ['budget', 'contact', 'Goal', '']) {
    const r = run(topic);
    assert.equal(r.ok, false, topic);
    assert.equal(r.error.code, 'unknown_topic');
  }
});

test('a discovery question shows the choice buttons and turns off the services-and-tiers picker', () => {
  const { ui } = widgetsFor({ toolCalls: [{ name: 'ask_choice', result: run('goal') }], state: newWidgetState() });
  assert.deepEqual(types(ui), ['choices']);
  assert.equal(ui[0].topic, 'goal');
  assert.deepEqual(ui[0].options, DATA.choices.goal.options);
  const refused = widgetsFor({ toolCalls: [{ name: 'ask_choice', result: run('budget') }], state: newWidgetState() });
  assert.ok(!types(refused.ui).includes('choices'), 'a refused topic shows no buttons');
});

test('declined: no widget that turn, not even the contact form after slots or a quote shown the same turn', () => {
  const shown = { ...newWidgetState(), quoted: true, slotsOffered: true };
  assert.deepEqual(widgetsFor({ toolCalls: [{ name: 'ask_choice', result: run('declined') }], state: shown }).ui, []);
  const fresh = widgetsFor({ toolCalls: [{ name: 'ask_choice', result: run('declined') }], state: newWidgetState() });
  assert.deepEqual(fresh.ui, [], 'no details picker either');
  const sameTurn = widgetsFor({ toolCalls: [
    { name: 'quote', result: { ok: true, total: 350, lines: [] } },
    { name: 'ask_choice', result: run('declined') },
  ], state: newWidgetState() });
  assert.deepEqual(sameTurn.ui, []);
});

test('through the chat: a goal question comes back with buttons, and the topic is checked before anything is shown', async () => {
  const desk = createDesk({ store: createMemoryStore(), now: () => new Date('2026-10-04T08:00:00+03:00') });
  const rounds = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'ask_choice', arguments: '{"topic":"goal"}' } }] },
    { role: 'assistant', content: 'ما الهدف الأقرب لك الآن؟' },
  ];
  let i = 0;
  const chat = createChat({ desk, model: { async complete() { return { message: rounds[Math.min(i++, 1)], modelId: 'fake' }; } } });
  const out = await chat.respond([], 'أفكر أطور مساري، وش تقترحون؟');
  assert.equal(out.reply, 'ما الهدف الأقرب لك الآن؟');
  assert.equal(out.toolCalls[0].result.topic, 'goal');
});

// Alfred, 2026-10-05: "declined" holds for the rest of the session. No slot, contact, picker or pay widget afterwards,
// until the customer asks to book again; code sees that as the model calling quote, check_availability or book.
test('declined holds for the rest of the session: later turns without a booking tool show no widget', () => {
  let { state } = widgetsFor({ toolCalls: [{ name: 'ask_choice', result: run('declined') }], state: { ...newWidgetState(), quoted: true, slotsOffered: true } });
  assert.equal(state.declined, true);
  for (const toolCalls of [[], [{ name: 'list_services', result: { ok: true, services: [] } }], [{ name: 'ask_choice', result: run('goal') }]]) {
    const w = widgetsFor({ toolCalls, state });
    assert.deepEqual(w.ui, [], 'no contact form, picker or buttons after a no');
    assert.equal(w.state.declined, true);
    state = w.state;
  }
});

test('declined resets when the customer asks to book again: slots come back and the state clears', () => {
  const { state } = widgetsFor({ toolCalls: [{ name: 'ask_choice', result: run('declined') }], state: newWidgetState() });
  const slots = { ok: true, slots: [{ start: '2026-10-06T10:00:00+03:00', end: '2026-10-06T11:00:00+03:00', label_en: 'Tue, 10:00', label_ar: 'الثلاثاء، 10:00' }] };
  const w = widgetsFor({ toolCalls: [{ name: 'check_availability', result: slots }], state });
  assert.deepEqual(types(w.ui), ['slots']);
  assert.equal(w.state.declined, false);
  const q = widgetsFor({ toolCalls: [{ name: 'quote', result: { ok: true, total: 350, lines: [] } }], state });
  assert.deepEqual(types(q.ui), ['quote'], 'a new quote after a no also counts as asking again');
});
