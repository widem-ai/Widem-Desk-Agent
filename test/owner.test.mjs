// Spec A6, slice 1: the owner page. Off unless OWNER_TOKEN is set; the token comes in a header or a form post, never
// the URL; failed attempts are limited per address; customer text is escaped; the page is never cached or framed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/mcp-server.mjs';
import { createFailures, addressKey } from '../src/owner.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { PROFILES } from './profiles.mjs';

const NOW = '2026-10-04T08:00:00+03:00'; // Sunday, before opening
const TOKEN = 'test-owner-token-not-a-real-one-0123456789'; // 32+ characters, as the page requires
const ORDER = PROFILES[0].order;

async function open({ ownerToken, ownerLimits, seed, trustProxy } = {}) {
  const store = createMemoryStore();
  const desk = createDesk({ store, now: () => new Date(NOW) });
  seed?.(desk);
  const server = createHttpServer({ desk, ownerToken, ownerLimits, trustProxy, now: () => Date.parse(NOW) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}
const withHeader = (base, token) => fetch(`${base}/owner`, { headers: { authorization: `Bearer ${token}` } });
const withForm = (base, token) => fetch(`${base}/owner`, { method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() });

function seedBothDoors(desk) {
  desk.book({ ...ORDER, slot: '2026-10-06T10:00:00+03:00', customer_name: 'Human Customer', contact: 'human@example.com',
    transcript: 'Customer: I need my CV done.' }, { door: 'human' });
  desk.book({ ...ORDER, slot: '2026-10-06T11:00:00+03:00', customer_name: 'Agent Customer', contact: 'agent@example.com' },
    { door: 'agent' });
  desk.handover({ reason: 'discount', summary: 'Asked for 50% off.', customer_name: 'Haggler', contact: 'h@example.com' },
    { door: 'human' });
}

test('no OWNER_TOKEN configured: the owner page does not exist (404), never open', async () => {
  const door = await open({ seed: seedBothDoors });
  try {
    assert.equal((await fetch(`${door.base}/owner`)).status, 404);
    assert.equal((await withHeader(door.base, '')).status, 404);
    assert.equal((await withForm(door.base, 'anything')).status, 404);
  } finally { await door.close(); }
});

test('wrong token: 401, and failed attempts per address run into a limit that holds even for the right token', async () => {
  const door = await open({ ownerToken: TOKEN, seed: seedBothDoors, ownerLimits: { failedPerIp: { count: 2, windowMs: 60_000 } } });
  try {
    const first = await withHeader(door.base, 'wrong');
    assert.equal(first.status, 401);
    assert.doesNotMatch(await first.text(), /Human Customer/);
    assert.equal((await withForm(door.base, 'wrong again')).status, 401);
    assert.equal((await withHeader(door.base, TOKEN)).status, 429);
  } finally { await door.close(); }
});

test('the token in the URL is ignored: the login form comes back, no data', async () => {
  const door = await open({ ownerToken: TOKEN, seed: seedBothDoors });
  try {
    const res = await fetch(`${door.base}/owner?token=${TOKEN}`);
    const html = await res.text();
    assert.match(html, /<form method="post" action="\/owner">/);
    assert.doesNotMatch(html, /Human Customer/);
  } finally { await door.close(); }
});

test('right token (header or form): bookings from both doors and the handover, newest first, never cached or framed', async () => {
  const door = await open({ ownerToken: TOKEN, seed: seedBothDoors });
  try {
    for (const res of [await withHeader(door.base, TOKEN), await withForm(door.base, TOKEN)]) {
      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control'), /no-store/);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.match(res.headers.get('x-robots-tag'), /noindex/);
      const html = await res.text();
      assert.match(html, /BK-0001[\s\S]*Human Customer[\s\S]*human@example\.com/);
      assert.match(html, /BK-0002[\s\S]*Agent Customer/);
      assert.match(html, /data-door="human"/);
      assert.match(html, /data-door="agent"/);
      assert.ok(html.indexOf('BK-0002') < html.indexOf('BK-0001'), 'newest first');
      assert.match(html, /850 SAR/);
      assert.match(html, /Held for payment/);
      assert.match(html, /Customer: I need my CV done\./);
      assert.match(html, /HO-0001[\s\S]*discount[\s\S]*Asked for 50% off\./);
    }
  } finally { await door.close(); }
});

test('customer text is escaped: a name holding a script tag is shown as text', async () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const door = await open({ ownerToken: TOKEN, seed: (desk) => {
    desk.book({ ...ORDER, slot: '2026-10-06T10:00:00+03:00', customer_name: evil, contact: '"><b>x</b>', transcript: evil },
      { door: 'agent' });
  } });
  try {
    const html = await (await withHeader(door.base, TOKEN)).text();
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /"><b>x<\/b>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  } finally { await door.close(); }
});

// E4b: limits that many addresses cannot get around, a token strong enough to guard contacts, bounded memory.
const fromIp = (base, token, ip) => fetch(`${base}/owner`, { headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': ip } });

test('distributed guessing from 40 addresses hits the global lock; then even the right token gets 429; one log line, no IPs', async (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const door = await open({ ownerToken: TOKEN, seed: seedBothDoors, trustProxy: 'cloudflare' });
  try {
    const statuses = [];
    for (let i = 1; i <= 40; i += 1) statuses.push((await fromIp(door.base, `guess-${i}`, `203.0.113.${i}`)).status);
    assert.deepEqual(statuses.slice(0, 30), Array(30).fill(401), 'the first 30 failures are plain 401s');
    assert.deepEqual(statuses.slice(30), Array(10).fill(429), 'after 30 failures across addresses everyone is locked');
    const right = await fromIp(door.base, TOKEN, '198.51.100.7');
    assert.equal(right.status, 429);
    assert.doesNotMatch(await right.text(), /Human Customer/);
    assert.deepEqual(logged, ['owner sign-in locked: too many failures']);
  } finally { await door.close(); }
});

test('a token shorter than 32 characters keeps the page off (404), even when it is sent', async () => {
  const short = 'only-twenty-eight-characters';
  const door = await open({ ownerToken: short, seed: seedBothDoors });
  try {
    assert.equal((await withHeader(door.base, short)).status, 404);
    assert.equal((await withForm(door.base, short)).status, 404);
  } finally { await door.close(); }
});

test('the failure map stays at or under its cap after 20,000 distinct failing addresses', () => {
  let t = 0;
  const f = createFailures({ failedPerIp: { count: 5, windowMs: 60_000 }, failedGlobal: { count: 1e9, windowMs: 60_000 },
    maxTrackedAddresses: 100 }, () => t);
  for (let i = 0; i < 20_000; i += 1) { t += 1; f.add(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`); }
  assert.ok(f.size() <= 100, `size ${f.size()}`);
  t += 120_000; // every entry has expired
  f.add('192.0.2.1');
  assert.equal(f.size(), 1, 'expired addresses are pruned');
});

test('an IPv6 address counts by its /64; IPv4 and IPv4-mapped addresses count as themselves', () => {
  assert.equal(addressKey('2001:db8:1:2:aaaa::1'), addressKey('2001:DB8:1:2:ffff:1:2:3'));
  assert.notEqual(addressKey('2001:db8:1:2::1'), addressKey('2001:db8:1:3::1'));
  assert.equal(addressKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.notEqual(addressKey('203.0.113.9'), addressKey('203.0.113.10'));
});

test('the booking and handover times are shown in Riyadh time, not raw UTC', async () => {
  const door = await open({ ownerToken: TOKEN, seed: seedBothDoors });
  try {
    const html = await (await withHeader(door.base, TOKEN)).text();
    assert.doesNotMatch(html, /T05:00:00\.000Z/);
    assert.match(html, /Sun 4 Oct, 08:00 Riyadh time/);
  } finally { await door.close(); }
});
