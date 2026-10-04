// Deterministic post-steps on the text a customer sees: no markdown symbols, Arabic punctuation in Arabic
// replies, and a logged (not blocking) count of Latin words in Arabic replies. Scripted fake model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/mcp-server.mjs';
import { createChat, plainMarkdown, arabicPunctuation } from '../src/chat.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';

const replyModel = (content) => ({ async complete() { return { message: { role: 'assistant', content }, modelId: 'fake/scripted' }; } });

test('markdown symbols never reach the customer: bold, italics, headings, bullet markers, code ticks', () => {
  assert.equal(plainMarkdown('السعر هو **750 ريال سعودي**.'), 'السعر هو 750 ريال سعودي.');
  assert.equal(plainMarkdown('رقم الحجز: __BK-0001__ و *مؤكد*'), 'رقم الحجز: BK-0001 و مؤكد');
  assert.equal(plainMarkdown('## المواعيد\n- الاثنين 10:00  \n* الثلاثاء 11:00\n+ الأربعاء\n• الخميس'),
    'المواعيد\nالاثنين 10:00\nالثلاثاء 11:00\nالأربعاء\nالخميس');
  assert.equal(plainMarkdown('Use `book` now **please**'), 'Use book now please');
  // A stray, unpaired marker goes too.
  assert.equal(plainMarkdown('Total: 750 SAR**'), 'Total: 750 SAR');
  // Things that look close but are content stay: references, emails, a hyphen inside a line, numbered steps.
  assert.equal(plainMarkdown('BK-0001, test@example.com, 1. first\n2. second'), 'BK-0001, test@example.com, 1. first\n2. second');
});

test('Arabic replies use the Arabic comma and say ranges with "إلى"; English replies and dates stay as they are', () => {
  assert.equal(arabicPunctuation('(المستوى: متوسط, 3-8 سنوات خبرة)'), '(المستوى: متوسط، 3 إلى 8 سنوات خبرة)');
  assert.equal(arabicPunctuation('من 10:00-11:00 بتوقيت الرياض'), 'من 10:00 إلى 11:00 بتوقيت الرياض');
  // Not ranges: a thousands separator, an ISO date, a booking reference.
  assert.equal(arabicPunctuation('المجموع 1,450 ريال, موعد 2026-10-05, رقم BK-0001'), 'المجموع 1,450 ريال، موعد 2026-10-05، رقم BK-0001');
  assert.equal(arabicPunctuation('Mid-level, 3-8 years'), 'Mid-level, 3-8 years');
});

test('the chat applies both post-steps before the reply reaches the customer and reports Latin words', async () => {
  const chat = createChat({ desk: createDesk({ store: createMemoryStore() }), model: replyModel('## أهلًا\n- **مرحبا** بك, مكالمة kickoff مدتها 60 دقيقة (3-8 سنوات)') });
  const out = await chat.respond([], 'مرحبا');
  assert.equal(out.reply, 'أهلًا\nمرحبا بك، مكالمة kickoff مدتها 60 دقيقة (3 إلى 8 سنوات)');
  assert.deepEqual(out.latin, ['kickoff']);
  // The history keeps what the customer saw, so the model does not copy its own markdown forward.
  assert.equal(out.history.at(-1).content, out.reply);
});

test('POST /chat logs Latin words in an Arabic reply and still answers 200 with the reply', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const server = createHttpServer({ model: replyModel('مكالمة kickoff مدتها 60 دقيقة') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/chat`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'مرحبا' }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reply, 'مكالمة kickoff مدتها 60 دقيقة');
    const logged = warn.mock.calls.map((c) => c.arguments.join(' '));
    assert.ok(logged.some((line) => line.includes('Latin') && line.includes('kickoff')), `logged: ${logged}`);
    // The customer's message is not written to the log.
    assert.ok(!logged.some((line) => line.includes('مرحبا')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an English reply logs nothing', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const out = await createChat({ desk: createDesk({ store: createMemoryStore() }), model: replyModel('A **kickoff** call, 3-8 years') }).respond([], 'hi');
  assert.equal(out.reply, 'A kickoff call, 3-8 years');
  assert.deepEqual(out.latin, []);
  assert.equal(warn.mock.callCount(), 0);
});
