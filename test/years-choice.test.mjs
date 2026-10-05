// Years as answer buttons, and a refused ask_choice still counts as a discovery turn (Alfred, 2026-10-05).
// From the live Arabic run (sales-live-run-2026-10-05, turn 3): after the timeline answer the model asked for years
// and called ask_choice with a topic outside the list. The refusal left the turn with no widget, so the old
// services-and-tiers picker came back on a discovery turn. Now "years" is a topic whose buttons are the tiers from
// the rules file, and any ask_choice call, refused or not, keeps the picker away that turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toolsFor } from '../src/tools.mjs';
import { widgetsFor, newWidgetState } from '../src/widgets.mjs';
import { createChat, SYSTEM_PROMPT } from '../src/chat.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const ask = toolsFor('human').find((t) => t.name === 'ask_choice');
const run = (topic) => ask.run(null, { topic });
const types = (ui) => ui.map((w) => w.type);

test('years: one button per tier from the rules file, labels in both languages, executive its own button', () => {
  const r = run('years');
  assert.equal(r.ok, true);
  assert.equal(r.topic, 'years');
  assert.deepEqual(r.options, DATA.tiers.map((t) => ({ id: t.id, en: t.name_en, ar: t.name_ar })), 'built from tiers, not code');
  assert.deepEqual(r.options.map((o) => o.id), ['junior', 'mid', 'senior', 'executive']);
  for (const o of r.options) {
    assert.doesNotMatch(o.ar, /[A-Za-z]/, `${o.id}: no Latin letters in Arabic`);
    assert.doesNotMatch(`${o.en}${o.ar}`, /[–—]/, `${o.id}: no en or em dashes`);
  }
  const { ui } = widgetsFor({ toolCalls: [{ name: 'ask_choice', result: r }], state: newWidgetState() });
  assert.deepEqual(types(ui), ['choices']);
  assert.equal(ui[0].topic, 'years');
});

test('the tool and the prompt name years as a topic, and say how a tapped tier becomes the quote arguments', () => {
  assert.match(ask.params.topic.describe, /\byears\b/);
  assert.match(ask.description, /years/);
  assert.match(ask.description, /is_executive/, 'the executive button maps to is_executive');
  assert.match(SYSTEM_PROMPT, /ask_choice with topic years/);
});

test('live run turn 3: a refused ask_choice shows no widget at all, not the services-and-tiers picker', () => {
  for (const topic of ['experience', 'budget', 'سنوات']) {
    const refused = run(topic);
    assert.equal(refused.ok, false, topic);
    const { ui } = widgetsFor({ toolCalls: [{ name: 'ask_choice', result: refused }], state: newWidgetState() });
    assert.deepEqual(ui, [], `${topic}: a discovery turn, so no picker`);
  }
  const mixed = widgetsFor({ toolCalls: [{ name: 'ask_choice', result: run('experience') }, { name: 'ask_choice', result: run('years') }], state: newWidgetState() });
  assert.deepEqual(types(mixed.ui), ['choices'], 'a retry with a good topic still shows its buttons');
  const plain = widgetsFor({ toolCalls: [], state: newWidgetState() });
  assert.deepEqual(types(plain.ui), ['details'], 'a turn with no ask_choice still gets the picker before any quote');
});

test('through the chat: after the timeline answer, the years question comes back with the tier buttons', async () => {
  const desk = createDesk({ store: createMemoryStore(), now: () => new Date('2026-10-04T08:00:00+03:00') });
  const rounds = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'y', type: 'function', function: { name: 'ask_choice', arguments: '{"topic":"years"}' } }] },
    { role: 'assistant', content: 'كم سنة خبرتك العملية؟' },
  ];
  let i = 0;
  const chat = createChat({ desk, model: { async complete() { return { message: rounds[Math.min(i++, 1)], modelId: 'fake' }; } } });
  const out = await chat.respond([], 'هذا الشهر');
  assert.equal(out.toolCalls[0].result.topic, 'years');
  const { ui } = widgetsFor({ toolCalls: out.toolCalls, state: newWidgetState() });
  assert.deepEqual(ui[0].options.map((o) => o.ar), DATA.tiers.map((t) => t.name_ar));
});
