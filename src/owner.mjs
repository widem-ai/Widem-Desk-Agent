// The owner page (spec A6): every booking from both doors and every handover, newest first, with the conversation
// behind each. It shows customer contacts, so: off unless OWNER_TOKEN is set, the token only in a header or a form
// post (never the URL, which lands in logs), failed attempts limited per address, all customer text escaped, never
// cached, indexed or framed, and no customer text in any log line.
import { createHash, timingSafeEqual } from 'node:crypto';
import { slotLabels } from './labels.mjs';
import { RULES } from './core.mjs';

export const OWNER_LIMITS = {
  failedPerIp: { count: 5, windowMs: 15 * 60_000 }, // 5 wrong tokens per address per 15 minutes, then 429
  failedGlobal: { count: 30, windowMs: 15 * 60_000 }, // 30 across all addresses: then every sign-in is locked
  maxTrackedAddresses: 10_000, // past this the oldest addresses are forgotten
};
/** Shorter tokens leave the page off: it guards customer contacts. */
export const MIN_TOKEN_LENGTH = 32;
const TZ = RULES.availability.timezone;
const whenFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** "Sun 4 Oct, 08:00 Riyadh time" for an ISO instant; the raw value if it is not one. */
const when = (iso) => (Number.isNaN(Date.parse(iso)) ? String(iso ?? '')
  : `${whenFmt.format(new Date(iso))} Riyadh time`);

/** The bucket for an address: IPv4 (also IPv4-mapped IPv6) as itself, any other IPv6 by its /64, since one
 * customer line usually gets a whole /64 and could otherwise rotate through it. */
export function addressKey(ip) {
  const s = String(ip ?? 'unknown').trim().toLowerCase().split('%')[0];
  if (s.startsWith('::ffff:') && s.includes('.')) return s.slice(7);
  if (!s.includes(':')) return s;
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = s.includes('::') && tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}
const MAX_FORM_BYTES = 4096;

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

/** Text for HTML: every customer-supplied string goes through this. */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const digest = (s) => createHash('sha256').update(String(s)).digest();
/** Constant-time comparison: both sides hashed to the same length first. */
const sameToken = (given, expected) => typeof given === 'string' && given.length > 0
  && timingSafeEqual(digest(given), digest(expected));

/** Failed attempts per address and across all addresses, each within its window. The per-address map forgets
 * expired entries and never holds more than maxTrackedAddresses (the least recently failing go first). */
export function createFailures({ failedPerIp, failedGlobal, maxTrackedAddresses }, now, onLock = () => {}) {
  const seen = new Map();
  let all = [];
  let lockReported = false;
  const recent = (key) => (seen.get(key) ?? []).filter((t) => now() - t < failedPerIp.windowMs);
  // Global failure times, oldest first: expired ones leave from the front, and more than count are never needed.
  const recentAll = () => {
    while (all.length && (now() - all[0] >= failedGlobal.windowMs || all.length > failedGlobal.count)) all.shift();
    return all;
  };
  // The map is ordered by last failure, so expired addresses are always at the front: drop from the front while
  // the first one has expired or the map is over its cap. Cheap per call, however many addresses there are.
  function prune() {
    for (const [key, list] of seen) {
      if (seen.size > maxTrackedAddresses || now() - list.at(-1) >= failedPerIp.windowMs) seen.delete(key);
      else break;
    }
  }
  return {
    locked() {
      const on = recentAll().length >= failedGlobal.count;
      if (!on) lockReported = false;
      return on;
    },
    blocked: (ip) => recent(addressKey(ip)).length >= failedPerIp.count,
    add(ip) {
      const key = addressKey(ip);
      const list = [...recent(key), now()];
      seen.delete(key); // re-inserted at the end: the map's order is least recently failing first
      seen.set(key, list);
      prune();
      all.push(now());
      if (recentAll().length >= failedGlobal.count && !lockReported) { lockReported = true; onLock(); }
    },
    size: () => seen.size,
  };
}

async function readForm(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_FORM_BYTES) return null;
  }
  return new URLSearchParams(body);
}

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${title}</title>
<style>
:root { --bg: #eef1f0; --surface: #fbfcfb; --ink: #13212e; --muted: #4c5a64; --line: #d3dad8;
  --accent: #0f6e5a; --accent-soft: #dcebe5; --warn: #8a3b12; --warn-soft: #f6e6dc; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #0e1920; --surface: #15232c; --ink: #e4ebe9; --muted: #9caeb5;
  --line: #2a3a44; --accent: #5fc3a4; --accent-soft: #183a31; --warn: #f0a37c; --warn-soft: #3a2419; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 400 16px/1.6 "IBM Plex Sans", system-ui, "Segoe UI", Tahoma, sans-serif; }
main { max-width: 880px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; } h2 { font-size: 1.1rem; margin: 32px 0 12px; }
.note { color: var(--muted); margin: 0 0 16px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; margin: 0 0 12px; }
.row { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.ref { font-weight: 600; } .muted { color: var(--muted); }
.tag { font-size: 0.8rem; font-weight: 500; padding: 1px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); }
.tag.warn { background: var(--warn-soft); color: var(--warn); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0 0; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
details { margin-top: 8px; } summary { cursor: pointer; color: var(--accent); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 0.9rem; margin: 8px 0 0; }
form { display: flex; flex-wrap: wrap; gap: 8px; } input, button { font: inherit; padding: 8px 12px; border-radius: 10px; }
input { flex: 1 1 220px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
button { border: 0; background: var(--accent); color: var(--surface); font-weight: 600; cursor: pointer; }
.error { color: var(--warn); }
</style></head><body><main>${body}</main></body></html>`;

const loginPage = (message) => page('Owner sign-in', `<h1>Owner sign-in</h1>
<p class="note">Darb Career Studio (demo). Bookings and handovers from both doors.</p>
${message ? `<p class="error">${esc(message)}</p>` : ''}
<form method="post" action="/owner"><input type="password" name="token" autocomplete="current-password"
aria-label="Owner token" placeholder="Owner token" required><button type="submit">Sign in</button></form>`);

function bookingStatus(b, now) {
  if (b.status === 'paid' || b.status === 'booked') return ['Paid', ''];
  if (b.status === 'awaiting_payment') {
    return Date.parse(b.hold_until) > now ? ['Held for payment', 'warn'] : ['Hold ran out, unpaid', 'warn'];
  }
  return [b.status ?? 'unknown', 'warn'];
}

const transcript = (t) => (t ? `<details><summary>Conversation</summary><pre>${esc(t)}</pre></details>` : '');

function bookingCard(b, now) {
  const [status, kind] = bookingStatus(b, now);
  const services = (b.quote?.lines ?? []).map((l) => l.name_en).join(', ') || (b.services ?? []).join(', ');
  const slot = b.slot?.start && b.slot?.end ? slotLabels(b.slot.start, b.slot.end, RULES.availability).label_en : '';
  return `<article class="card" data-door="${esc(b.door)}">
<div class="row"><span class="ref">${esc(b.reference)}</span><span class="tag">${b.door === 'agent' ? 'Agent door' : 'Chat door'}</span>
<span class="tag ${kind}">${esc(status)}</span><span class="muted">${esc(when(b.created_at))}</span></div>
<dl><dt>Customer</dt><dd>${esc(b.customer_name)}</dd><dt>Contact</dt><dd>${esc(b.contact)}</dd>
<dt>Service</dt><dd>${esc(services)}</dd><dt>Tier</dt><dd>${esc(b.quote?.tier_name_en ?? b.tier)}</dd>
<dt>Price</dt><dd>${esc(b.price_quoted)} ${esc(b.currency)}</dd><dt>Slot</dt><dd>${esc(slot)}</dd></dl>
${transcript(b.transcript)}</article>`;
}

function handoverCard(h) {
  return `<article class="card" data-door="${esc(h.door)}">
<div class="row"><span class="ref">${esc(h.id)}</span><span class="tag">${h.door === 'agent' ? 'Agent door' : 'Chat door'}</span>
<span class="tag warn">${esc(h.reason_given ?? h.reason)}</span><span class="muted">${esc(when(h.created_at))}</span></div>
<dl><dt>Customer</dt><dd>${esc(h.customer_name ?? '')}</dd><dt>Contact</dt><dd>${esc(h.contact ?? '')}</dd>
<dt>Summary</dt><dd>${esc(h.summary ?? '')}</dd></dl>${transcript(h.transcript)}</article>`;
}

const newestFirst = (list) => [...list].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))
  || String(b.reference ?? b.id).localeCompare(String(a.reference ?? a.id)));

export function renderOwnerPage({ bookings, handovers }, now) {
  const b = newestFirst(bookings);
  const h = newestFirst(handovers);
  return page('Owner: bookings', `<h1>Bookings and handovers</h1>
<p class="note">Darb Career Studio (demo). Newest first. Chat door: people on the page. Agent door: customers' AI agents over MCP.</p>
<h2>Bookings (${b.length})</h2>${b.map((x) => bookingCard(x, now)).join('') || '<p class="muted">No bookings yet.</p>'}
<h2>Handovers (${h.length})</h2>${h.map(handoverCard).join('') || '<p class="muted">No handovers yet.</p>'}`);
}

/** GET /owner (token in an Authorization: Bearer header) or POST /owner (form field token). */
export function createOwnerRoute({ desk, token, limits = OWNER_LIMITS, now = Date.now, ipOf }) {
  const failures = createFailures({ ...OWNER_LIMITS, ...limits }, now,
    () => console.error('owner sign-in locked: too many failures')); // nothing else: no IPs, no tokens
  const enabled = typeof token === 'string' && token.length >= MIN_TOKEN_LENGTH;
  const send = (res, status, html) => res.writeHead(status, HEADERS).end(html);
  return async (req, res) => {
    if (!enabled) { res.writeHead(404).end(); return; } // not configured, or too weak: the page does not exist
    if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }).end(); return; }
    let given;
    if (req.method === 'POST') {
      const form = await readForm(req);
      if (!form) { send(res, 413, loginPage('That request was too large.')); return; }
      given = form.get('token');
    } else {
      const auth = req.headers.authorization;
      given = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
    }
    if (given === undefined || given === null) { send(res, 200, loginPage()); return; } // a plain visit: the form
    const ip = ipOf(req);
    if (failures.locked()) { send(res, 429, loginPage('Sign-in is locked for a while. Try again later.')); return; }
    if (failures.blocked(ip)) { send(res, 429, loginPage('Too many wrong tokens. Try again later.')); return; }
    if (!sameToken(given, token)) {
      failures.add(ip);
      send(res, 401, loginPage('That token is not right.'));
      return;
    }
    send(res, 200, renderOwnerPage(desk.ownerView(), now()));
  };
}
