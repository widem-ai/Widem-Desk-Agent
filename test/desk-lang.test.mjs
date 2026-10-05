// DESK_LANG (Mohannad, 2026-10-06): the hackathon demo replies in English even when the customer writes Arabic.
// "en" (the default when the server starts) makes the prompt, the fallbacks and the code-built lines English;
// "ar" keeps today's bilingual desk. The data and the widgets are the same in both: the *_ar fields stay as drafts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChat, langFromEnv, promptFor, sorryReply } from '../src/chat.mjs';
import { createHttpServer } from '../src/mcp-server.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const ARABIC = /[؀-ۿ]/;
const AR_MESSAGE = 'أبغى خصم على الباقة';
const toolCall = (id, name, args) => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function scriptedModel(rounds) {
  const seen = []; let i = 0;
  return { seen, async complete(req) { seen.push(JSON.stringify(req)); return { message: rounds[Math.min(i++, rounds.length - 1)], modelId: 'fake/scripted' }; } };
}
const desk = () => createDesk({ store: createMemoryStore(), now: () => new Date('2026-10-04T08:00:00+03:00') });

test('DESK_LANG: unset or anything but "ar" means en; "ar" keeps the bilingual desk', () => {
  assert.equal(langFromEnv({}), 'en');
  assert.equal(langFromEnv({ DESK_LANG: 'en' }), 'en');
  assert.equal(langFromEnv({ DESK_LANG: 'ar' }), 'ar');
  assert.equal(langFromEnv({ DESK_LANG: 'fr' }), 'en');
});

test('under en the system prompt says reply in English whatever the customer writes, with the English labels', () => {
  const en = promptFor('en');
  assert.match(en, /Always reply in English, even when the customer writes in Arabic/);
  assert.match(en, /name_en, tier_name_en, label_en, call_name_en/);
  assert.doesNotMatch(en, /name_ar|Reply in the language the customer writes in/);
  assert.match(promptFor('ar'), /Reply in the language the customer writes in: Arabic or English/);
});

test('under en an Arabic message gets the English prompt and an English handover line', async () => {
  const model = scriptedModel([toolCall('h', 'handover', { reason: 'discount', summary: 'Discount request.' }), { role: 'assistant', content: 'x' }]);
  const out = await createChat({ desk: desk(), model, lang: 'en' }).respond([], AR_MESSAGE);
  assert.ok(model.seen[0].includes('Always reply in English'), 'the model got the English-only prompt');
  const ack = DATA.handover.acknowledge.discount;
  assert.equal(out.reply, `${ack.en} ${DATA.handover.tell_customer_en}`);
  assert.doesNotMatch(out.reply, ARABIC);
});

test('the bilingual desk is unchanged under ar: the same Arabic message gets the Arabic handover line', async () => {
  const model = scriptedModel([toolCall('h', 'handover', { reason: 'discount', summary: 'Discount request.' }), { role: 'assistant', content: 'x' }]);
  const out = await createChat({ desk: desk(), model, lang: 'ar' }).respond([], AR_MESSAGE);
  assert.ok(model.seen[0].includes('Arabic or English'));
  assert.match(out.reply, ARABIC);
});

test('under en the fallbacks are English for an Arabic message, over HTTP too', async () => {
  assert.equal(sorryReply(AR_MESSAGE, 'en'), 'Sorry, I could not answer just now. Please try again in a moment.');
  assert.match(sorryReply(AR_MESSAGE, 'ar'), ARABIC);
  const server = createHttpServer({ desk: desk(), lang: 'en' }); // no model: the chat answers with the fallback
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/chat`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: AR_MESSAGE }) });
    const json = await res.json();
    assert.equal(res.status, 503);
    assert.doesNotMatch(json.reply, ARABIC);
  } finally { await new Promise((r) => server.close(r)); }
});
