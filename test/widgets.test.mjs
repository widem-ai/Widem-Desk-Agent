// Widgets under the desk's message (slice 3, 2026-10-05): built in code from tool results and session state,
// never parsed from the model's text. Slots become chips, a quote a price card, missing details a picker,
// and the step before booking a contact form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { widgetsFor, trimSlotLines, newWidgetState } from '../src/widgets.mjs';
import { createHttpServer } from '../src/mcp-server.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { PROFILES } from './profiles.mjs';

const ORDER = PROFILES[1].order;
const NOW = () => new Date('2026-10-04T08:00:00+03:00');
const desk = () => createDesk({ store: createMemoryStore(), now: NOW });
const types = (ui) => ui.map((w) => w.type);

test('no quote yet: a details picker built from the services and tiers in the rules file', () => {
  const { ui } = widgetsFor({ toolCalls: [], state: newWidgetState() });
  const d = ui.find((w) => w.type === 'details');
  assert.ok(d, 'details picker offered');
  assert.deepEqual(d.services.map((s) => s.id), ['cv_rewrite', 'linkedin_profile', 'cover_letter', 'interview_coaching']);
  assert.deepEqual(d.tiers.map((t) => t.id), ['junior', 'mid', 'senior', 'executive']);
  assert.ok(d.services.every((s) => s.name_en && s.name_ar) && d.tiers.every((t) => t.name_en && t.name_ar));
});

test('a quote becomes a price card with the engine figures; free slots become chips; no picker after a quote', () => {
  const d = desk();
  const quote = d.quote(ORDER, { door: 'human' });
  const toolCalls = [
    { name: 'quote', result: quote ?? { ok: true, lines: [{ service: 'cv_rewrite', name_en: 'CV rewrite', name_ar: 'x', price: 550 }], tier: 'mid', tier_name_en: 'Mid', tier_name_ar: 'م', subtotal: 550, discount: 0, addons: [], total: 550, currency: 'SAR' } },
    { name: 'check_availability', result: d.checkAvailability({}, { door: 'human' }) },
  ];
  const { ui, state } = widgetsFor({ toolCalls, state: newWidgetState() });
  assert.deepEqual(types(ui), ['quote', 'slots']);
  const card = ui[0];
  assert.equal(card.total, toolCalls[0].result.total);
  assert.equal(card.currency, 'SAR');
  assert.ok(card.lines.length >= 1 && card.tier_name_ar);
  const chips = ui[1];
  assert.ok(chips.slots.length > 5, 'all slots are sent; the page shows five and reveals the rest');
  assert.ok(chips.slots.every((s) => s.start && s.label_en && s.label_ar));
  assert.equal(state.quoted, true);
  assert.equal(state.slotsOffered, true);
});

test('after slots were offered and the customer picked one: a contact form; after booking or handover: nothing', () => {
  const state = { ...newWidgetState(), quoted: true, slotsOffered: true };
  assert.deepEqual(types(widgetsFor({ toolCalls: [], state }).ui), ['contact']);
  assert.deepEqual(widgetsFor({ toolCalls: [], state, booked: { reference: 'BK-0001' } }).ui, []);
  assert.deepEqual(widgetsFor({ toolCalls: [], state: newWidgetState(), handover: { id: 'HO-0001' } }).ui, []);
});

test('the slot list the model wrote is trimmed when chips carry it; prices and other lines stay', () => {
  const reply = 'الإجمالي: 550 ريال\n\nالمواعيد المتاحة:\nالثلاثاء، 6 أكتوبر، 10:00 إلى 11:00 بتوقيت الرياض\n- Tuesday 6 October, 11:00 to 12:00 Riyadh time\n\nاختر موعدًا.';
  const out = trimSlotLines(reply);
  assert.doesNotMatch(out, /10:00|11:00/);
  assert.match(out, /550 ريال/);
  assert.match(out, /اختر موعدًا/);
});

test('POST /chat returns ui: slot chips from check_availability, and the reply no longer lists the times', async () => {
  const rounds = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'check_availability', arguments: '{}' } }] },
    { role: 'assistant', content: 'Free times:\nTuesday 6 October, 10:00 to 11:00 Riyadh time\nPick one.' },
  ];
  let i = 0;
  const model = { async complete() { return { message: rounds[Math.min(i++, rounds.length - 1)], modelId: 'fake' }; } };
  const server = createHttpServer({ desk: desk(), model });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/chat`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'When are you free?' }) });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.ok(json.ui.some((w) => w.type === 'slots'), 'slot chips sent');
    assert.doesNotMatch(json.reply, /10:00/);
  } finally { await new Promise((r) => server.close(r)); }
});
