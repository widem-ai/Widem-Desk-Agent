// The chat page for people (slice 3 prototype): GET / serves the page; POST /chat also returns
// what the desk did under the hood (activity), so the page can show the quote engine and handover working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/mcp-server.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { PROFILES } from './profiles.mjs';

const ORDER = PROFILES[1].order;
const toolCall = (id, name, args) => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function scriptedModel(rounds) {
  let i = 0;
  return { async complete() { return { message: rounds[Math.min(i++, rounds.length - 1)], modelId: 'fake/scripted' }; } };
}
async function withServer(model, fn) {
  const server = createHttpServer({ desk: createDesk({ store: createMemoryStore(), now: () => new Date('2026-10-04T08:00:00+03:00') }), model });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

test('GET / serves the chat page: Arabic and right-to-left by default, labelled as a fictional demo', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html; charset=utf-8/);
    const html = await res.text();
    assert.match(html, /<html[^>]*lang="ar"[^>]*dir="rtl"/);
    assert.match(html, /fictional/i);
    assert.match(html, /\/chat/);
  });
});

test('POST /chat reports the desk activity: the quote it priced, with the total from the engine', async () => {
  const model = scriptedModel([toolCall('c1', 'quote', ORDER), { role: 'assistant', content: 'Here is your price.' }]);
  await withServer(model, async (base) => {
    const res = await fetch(`${base}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'How much?' }) });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(json.activity), 'activity is a list');
    const q = json.activity.find((a) => a.tool === 'quote');
    assert.ok(q, 'the quote call is listed');
    assert.equal(q.ok, true);
    assert.equal(typeof q.total, 'number');
    assert.equal(q.currency, 'SAR');
  });
});
