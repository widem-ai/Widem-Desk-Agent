// Two sample conversations for the Toloka rater format, through the real model over real HTTP:
// POST /chat on a local server with a memory store (nothing kept, nothing shared). Demo business, fictional.
// (1) a clean Arabic booking ending in a quote, (2) an Arabic discount request that should go to a person.
// Run from the repo root: node --env-file=.env smoke/sample-transcripts.mjs > samples.json
// Prints JSON: per scenario, each turn (customer, desk reply, HTTP status), the desk tool calls with their
// results, and the stored bookings and handovers. Never prints the key.
import { createHttpServer } from '../src/mcp-server.mjs';
import { createNebiusModel, DEFAULT_MODEL } from '../src/chat.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';

const SCENARIOS = [
  {
    id: 'S1-ar-booking',
    turns: [
      'السلام عليكم، عندي خبرة خمس سنوات في المحاسبة. أبغى إعادة كتابة السيرة الذاتية مع خطاب تقديم، كم السعر؟',
      'تمام، وش أقرب المواعيد المتاحة لمكالمة البداية؟',
      'احجز لي أول موعد متاح لو سمحت. الاسم: عميل تجريبي، البريد: test@example.com',
    ],
  },
  {
    id: 'S2-ar-discount-handover',
    turns: [
      'مرحبا، أنا مدير مشاريع بخبرة عشر سنوات. كم سعر جلسة التدريب على المقابلات؟',
      'السعر مرتفع شوي. ممكن تعطيني خصم ٢٠٪ لأني طالب ماجستير حاليًا؟',
    ],
  },
];

async function run({ id, turns }) {
  const store = createMemoryStore();
  const desk = createDesk({ store });
  const calls = [];
  // Record every desk tool call the chat makes, with its result, so the rater sheet can show the source of each number.
  const recorded = new Proxy(desk, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== 'function') return value;
      return (...args) => { const result = value.apply(target, args); calls.push({ tool: name, args: args[0], result }); return result; };
    },
  });
  const server = createHttpServer({ desk: recorded, model: createNebiusModel() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/chat`;
  let sessionId;
  const log = [];
  try {
    for (const message of turns) {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sessionId ? { sessionId, message } : { message }) });
      const body = await res.json();
      sessionId = body.sessionId ?? sessionId;
      log.push({ customer: message, status: res.status, desk: body.reply ?? null, error: body.error ?? null,
        booked: body.booked?.reference ?? null, handover: body.handover?.id ?? null });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const pick = (r) => { const { transcript, ...rest } = r; return rest; };
  return { id, turns: log, calls: calls.map((c) => ({ ...c, args: c.args && typeof c.args === 'object' ? pick(c.args) : c.args })),
    bookings: store.all('bookings').map(pick), handovers: store.all('handovers').map(pick) };
}

const results = [];
for (const scenario of SCENARIOS) results.push(await run(scenario));
console.log(JSON.stringify({ model: DEFAULT_MODEL, temperature: 0, ran_at: new Date().toISOString(), results }, null, 2));
