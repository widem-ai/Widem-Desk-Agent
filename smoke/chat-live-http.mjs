// One live Arabic conversation through the real model, over real HTTP: POST /chat on a local server
// with a memory store (nothing is kept, nothing shared). Acceptance A5, first evidence.
// Run from the repo root: node --env-file=.env smoke/chat-live-http.mjs
// Prints each reply, then the stored booking. Never prints the key.
import { createHttpServer } from '../src/mcp-server.mjs';
import { createNebiusModel } from '../src/chat.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';

const TURNS = [
  'مرحبا، أنا مدير بخبرة ١٢ سنة. كم سعر إعادة كتابة السيرة الذاتية مع ملف لينكدإن؟',
  'ممتاز. ما هي أقرب المواعيد المتاحة لمكالمة البداية؟',
  'احجز لي أول موعد متاح من فضلك. الاسم: عميل تجريبي، البريد: test@example.com',
];

const store = createMemoryStore();
const server = createHttpServer({ desk: createDesk({ store }), model: createNebiusModel() });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/chat`;
console.log(`POST ${url} (memory store)`);

let sessionId; // issued by the server on the first reply
try {
  for (const message of TURNS) {
    const started = Date.now();
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sessionId ? { sessionId, message } : { message }) });
    const body = await res.json();
    sessionId = body.sessionId ?? sessionId;
    console.log(`\n> ${message}`);
    console.log(`< HTTP ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)} s${body.booked ? ` booked ${body.booked.reference}` : ''}${body.handover ? ` handover ${body.handover.id}` : ''}`);
    console.log(body.reply ?? JSON.stringify(body.error));
  }
  const [booking] = store.all('bookings');
  console.log('\nStored bookings:', store.all('bookings').length, '| handovers:', store.all('handovers').length);
  if (booking) {
    const { reference, door, customer_name, contact, services, tier, years_experience, is_executive, price_quoted, currency, slot, transcript } = booking;
    console.log(JSON.stringify({ reference, door, customer_name, contact, services, tier, years_experience, is_executive, price_quoted, currency, slot }, null, 2));
    console.log('transcript:\n' + transcript);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
