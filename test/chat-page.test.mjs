// The chat page for people (slice 3 prototype): GET / serves the page; POST /chat also returns
import { readFileSync } from 'node:fs';
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

// Changed 2026-10-06 (Mohannad): the desk is English only. This test used to require lang="ar" dir="rtl"; it now
// requires an English, left-to-right page with no language toggle and no Arabic text anywhere in it.
test('GET / serves the chat page: English and left-to-right only, no language toggle, labelled as a fictional demo', async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html; charset=utf-8/);
    const html = await res.text();
    assert.match(html, /<html lang="en">/);
    assert.ok(!/dir="rtl"|'rtl'|id="lang"|\$\('lang'\)|state\.lang|applyLang/.test(html), 'no RTL branch and no language toggle');
    assert.ok(!/[؀-ۿ]/.test(html), 'no Arabic text in the page');
    assert.ok(!/\$\{lang\}|\(w, lang\)|_ar\b/.test(html), 'widgets read the English fields only');
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

test('the page renders the ui widgets from /chat: chips, price card, details picker, contact form', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const t of ['quote', 'slots', 'details', 'contact', 'choices']) assert.ok(html.includes(`w.type === '${t}'`), t);
  assert.match(html, /renderUi\(json\.ui/);
  assert.match(html, /choice\('radio'/); assert.match(html, /choice\('checkbox'/);
  assert.match(html, /aria-expanded/);
});

test('the page renders the pay step: amount card and the demo button from the widget, POST /chat/pay, no card fields', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /w\.type === 'pay'\) box\.append\(payCard\(w\)\)/);
  const body = html.slice(html.indexOf('function payCard'), html.indexOf('function renderUi'));
  assert.ok(body.length > 100, 'payCard is defined before renderUi');
  assert.match(body, /fetch\('\/chat\/pay'/);
  assert.match(body, /sessionId: state\.sessionId/);
  assert.match(body, /w\.button_en/, 'the button label comes from the data file via the widget');
  assert.ok(!/el\('(?:input|select|textarea)'|card ?number|iban|cvv/i.test(body), 'no card or bank fields are created');
  assert.match(body, /disabled = true/, 'the button disables after use');
  for (const status of ['409', '400']) assert.ok(body.includes(status), `handles ${status}`);
});

test('used forms do not stay as empty fields: a sent contact form becomes a one-line summary, an unused one is hidden', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /\.widgets\[inert\] form\.picker \{ display: none; \}/);
  const body = html.slice(html.indexOf('function contactForm'), html.indexOf('function renderUi'));
  assert.match(body, /f\.replaceWith\(el\('p', 'sent', s\.sentAs\(n, c\)\)\)/);
  assert.match(html, /sentAs: \(n, c\) => `Sent: \$\{n\} · \$\{c\}`/);
  assert.match(html, /w\.held_en/, 'the pay card shows the hold time from the widget');
});

// Found 2026-10-05: the activity panel looked empty after the page was opened at phone width and then widened. It is
// a <details> opened once at load for wide screens; it stayed closed on a later resize. It must follow the width.
test('the activity panel opens and closes with the width, not only at load', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /const wide = matchMedia\('\(min-width: 900px\)'\);/);
  assert.match(html, /wide\.addEventListener\('change', \(e\) => \{ \$\('act'\)\.open = e\.matches; \}\);/);
});
