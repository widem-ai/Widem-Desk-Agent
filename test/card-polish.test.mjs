// Card polish after the live run of 2026-10-05 (Alfred): the model restated the card's price beside it
// ("السعر الإجمالي هو 550 ريال سعودي."), so when a recommendation card shows, code trims the sentences that state an
// amount or only restate the service, and keeps the goal sentence and the booking ask (like the slot-line trim).
// The activity panel names the recommend and ask_choice steps in both languages, and the card's tier line is the
// tier name without the years range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trimRecReply } from '../src/widgets.mjs';
import { createHttpServer } from '../src/mcp-server.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const CARD = { goal_line_en: 'Your goal: new job', goal_line_ar: 'هدفك: وظيفة جديدة',
  services: [{ id: 'cv_rewrite', name_en: 'CV rewrite', name_ar: 'إعادة كتابة السيرة الذاتية' }] };
const LIVE = 'هدفك هو الحصول على وظيفة جديدة، ونوصي بإعادة كتابة السيرة الذاتية لتناسب المستوى المتوسط. السعر الإجمالي هو 550 ريال سعودي. يمكنك اختيار وقت مناسب من الخيارات أدناه لحجز مكالمة البداية التي مدتها 60 دقيقة.';

test('live reply: the price sentence goes, the goal sentence and the booking ask stay', () => {
  assert.equal(trimRecReply(LIVE, CARD),
    'هدفك هو الحصول على وظيفة جديدة، ونوصي بإعادة كتابة السيرة الذاتية لتناسب المستوى المتوسط. يمكنك اختيار وقت مناسب من الخيارات أدناه لحجز مكالمة البداية التي مدتها 60 دقيقة.');
});

test('English, a service-only sentence, and a reply with nothing else left', () => {
  assert.equal(trimRecReply('Your goal is a new job. We recommend a CV rewrite. It costs 550 SAR. Pick a time below to book.', CARD),
    'Your goal is a new job. Pick a time below to book.');
  assert.equal(trimRecReply('السعر 550 ريال.', CARD), 'هدفك: وظيفة جديدة.');
  assert.equal(trimRecReply('Total: 550 SAR.', CARD), 'Your goal: new job.');
  assert.equal(trimRecReply('هدفك وظيفة جديدة. اختر موعدًا أدناه.', CARD), 'هدفك وظيفة جديدة. اختر موعدًا أدناه.', 'nothing to trim');
});

const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const say = (content) => ({ role: 'assistant', content });
test('over HTTP: the turn with the card goes out trimmed, and the card\'s tier line is the name without the range', async () => {
  const rounds = [call('g', 'ask_choice', { topic: 'goal' }), say('ما هدفك؟'), call('y', 'ask_choice', { topic: 'years' }), say('ما مستوى خبرتك؟'), say(LIVE)];
  let i = 0;
  const model = { async complete() { return { message: rounds[Math.min(i++, rounds.length - 1)], modelId: 'fake' }; } };
  const server = createHttpServer({ desk: createDesk({ store: createMemoryStore(), now: () => new Date('2026-10-04T08:00:00+03:00') }), model });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/chat`;
    let sessionId;
    const post = async (message) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sessionId ? { sessionId, message } : { message }) });
      const body = await res.json(); sessionId = body.sessionId; return body;
    };
    await post('أفكر أطور مساري، وش تقترحون؟');
    await post('وظيفة جديدة');
    const out = await post(DATA.tiers.find((t) => t.id === 'mid').name_ar);
    assert.equal(out.ui[0].type, 'recommend');
    assert.doesNotMatch(out.reply, /550/);
    assert.match(out.reply, /وظيفة جديدة/);
    assert.match(out.reply, /اختيار وقت/);
    assert.equal(out.ui[0].tier_name_ar, 'مستوى متوسط');
    assert.equal(out.ui[0].tier_name_en, 'Mid-level');
  } finally { server.close(); }
});

test('the activity panel names recommend and ask_choice in both languages', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /recommend: 'recommend', ask_choice: 'choice'/);
  assert.match(page, /recommend: 'التوصية', choice: 'أزرار الإجابة'/);
  assert.match(page, /recommend: 'Recommendation', choice: 'Answer buttons'/);
});
