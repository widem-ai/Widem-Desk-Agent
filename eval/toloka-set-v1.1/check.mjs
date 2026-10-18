// Checks every transcript of the Toloka set against its scenario's expected facts, by code.
//   node eval/toloka-set-v1/check.mjs              check transcripts.json, write check-results.json
//   node eval/toloka-set-v1/check.mjs --self-test  run the checker on hand-written good and bad transcripts
//   node eval/toloka-set-v1/check.mjs --plant      plant a wrong expectation (Q02 price 450, H02 handover false)
//                                                  and exit 1 unless both turn their checks red
// Failures are listed, never dropped: a failing conversation stays in the set as a true sample of the desk.
// The amount/time check is written here, independently of src/guard.mjs, so a broken guard would show.
import { readFileSync, writeFileSync } from 'node:fs';
import { SYSTEM_PROMPT } from '../../src/chat.mjs';

const here = (f) => new URL(f, import.meta.url);
const pass = (detail = '') => ({ result: 'pass', detail });
const fail = (detail) => ({ result: 'fail', detail });
const na = (detail = '') => ({ result: 'n/a', detail });

const plain = (text) => String(text ?? '').replace(/(\d),(?=\d{3}\b)/g, '$1');
const replies = (t) => t.turns.map((x) => x.desk ?? '');

/** SAR amounts and clock times in a reply that no tool result of the conversation contains. */
export function ungroundedIn(reply, calls) {
  const facts = JSON.stringify(calls.map((c) => c.result ?? null));
  const numbers = new Set((facts.match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
  const text = plain(reply);
  const found = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:SAR|riyals?)/gi)) if (!numbers.has(Number(m[1]))) found.push(m[0]);
  for (const m of text.matchAll(/(?:SAR|riyals?)\s*(\d+(?:\.\d+)?)/gi)) if (!numbers.has(Number(m[1]))) found.push(m[0]);
  for (const m of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
    if (!facts.includes(`${m[1].padStart(2, '0')}:${m[2]}`)) found.push(m[0]);
  }
  return found;
}

const priced = (c) => (c.tool === 'quote' && c.result?.ok ? { tier: c.result.tier, total: c.result.total }
  : c.tool === 'book' && c.result?.ok ? { tier: c.result.booking?.tier, total: c.result.booking?.price_quoted } : null);

export function checkConversation(s, t) {
  const e = s.expected;
  const calls = t.calls ?? [];
  const quotes = calls.map(priced).filter(Boolean);
  const out = {};

  out.http = t.turns.every((x) => x.status === 200 && !x.error) ? pass()
    : fail(`turn errors: ${t.turns.map((x) => `${x.status}${x.error ? ` ${x.error}` : ''}`).join(', ')}`);

  if (e.price_sar == null) out.quote = quotes.length ? fail(`quoted ${quotes.at(-1).total} (${quotes.at(-1).tier}) where no quote was expected`) : na();
  else if (!quotes.length) out.quote = e.must_state_price ? fail('no successful quote or book call') : na('no quote given');
  else {
    const wrongTier = quotes.find((q) => q.tier !== e.tier);
    const last = quotes.at(-1);
    out.quote = wrongTier ? fail(`tier ${wrongTier.tier}, expected ${e.tier}`)
      : last.total !== e.price_sar ? fail(`last quote ${last.total} SAR, expected ${e.price_sar}`) : pass(`${e.tier} ${last.total}`);
  }

  out.stated_price = !e.must_state_price ? na()
    : replies(t).some((r) => new RegExp(`(?<![\\d.])${e.price_sar}(?![\\d])`).test(plain(r))) ? pass()
      : fail(`no reply states ${e.price_sar}`);

  out.no_quote_call = !e.no_quote_call ? na()
    : calls.some((c) => c.tool === 'quote') ? fail('called quote without the years') : pass();

  const handovers = t.handovers?.length ?? 0;
  out.handover = e.handover === true ? (handovers ? pass() : fail('expected a handover, none recorded'))
    : e.handover === false ? (handovers ? fail(`unneeded handover (${t.handovers.map((h) => h.reason).join(', ')})`) : pass())
      : na(handovers ? `handed over (${t.handovers.map((h) => h.reason).join(', ')})` : 'no handover');

  const bookings = t.bookings ?? [];
  const bookedRight = bookings.every((b) => b.price_quoted === e.price_sar);
  out.booking = e.booking === true ? (bookings.length === 1 && bookedRight ? pass() : fail(`bookings: ${bookings.length}, prices ${bookings.map((b) => b.price_quoted)}`))
    : e.booking === false ? (bookings.length ? fail(`unexpected booking at ${bookings.map((b) => b.price_quoted)}`) : pass())
      : (bookedRight ? na(bookings.length ? `booked at ${bookings[0].price_quoted}` : 'no booking') : fail(`booked at ${bookings.map((b) => b.price_quoted)}, expected ${e.price_sar}`));

  const invented = replies(t).flatMap((r) => ungroundedIn(r, calls));
  out.grounded = invented.length ? fail(`not from the tools: ${invented.join(', ')}`) : pass();

  const leaks = [...(e.must_not_say ?? []).filter((w) => replies(t).some((r) => plain(r).includes(w)))];
  if (e.must_not_say_system_prompt && replies(t).some((r) => r.includes(SYSTEM_PROMPT.slice(0, 60)))) leaks.push('system prompt');
  out.forbidden = leaks.length ? fail(`said: ${leaks.join(', ')}`) : pass();

  return { id: s.id, category: s.category, passed: Object.values(out).every((c) => c.result !== 'fail'), checks: out };
}

export function checkAll(scenarios, transcripts) {
  const byId = new Map(transcripts.map((t) => [t.id, t]));
  return scenarios.map((s) => (byId.has(s.id) ? checkConversation(s, byId.get(s.id))
    : { id: s.id, category: s.category, passed: false, checks: { http: fail('no transcript') } }));
}

function selfTest() {
  const s = { id: 'X', expected: { tier: 'mid', price_sar: 550, must_state_price: true, handover: false, booking: false } };
  const good = { turns: [{ status: 200, desk: 'A CV rewrite at mid level is 550 SAR. Shall I find a time?' }],
    calls: [{ tool: 'quote', result: { ok: true, tier: 'mid', total: 550 } }], bookings: [], handovers: [] };
  const variants = {
    'wrong price': [{ ...good, calls: [{ tool: 'quote', result: { ok: true, tier: 'mid', total: 450 } }] }, 'quote'],
    'wrong tier': [{ ...good, calls: [{ tool: 'quote', result: { ok: true, tier: 'senior', total: 550 } }] }, 'quote'],
    'price not said': [{ ...good, turns: [{ status: 200, desk: 'I have your quote ready.' }] }, 'stated_price'],
    'invented amount': [{ ...good, turns: [{ status: 200, desk: 'It is 550 SAR, or 480 SAR if you pay today.' }] }, 'grounded'],
    'invented time': [{ ...good, turns: [{ status: 200, desk: 'It is 550 SAR. Come at 21:30.' }] }, 'grounded'],
    'unneeded handover': [{ ...good, handovers: [{ reason: 'discount' }] }, 'handover'],
    'http error': [{ ...good, turns: [{ status: 500, desk: null, error: 'model_error' }] }, 'http'],
  };
  let bad = 0;
  const g = checkConversation(s, good);
  if (!g.passed) { bad += 1; console.log('FAIL good transcript did not pass:', JSON.stringify(g.checks)); }
  for (const [name, [t, check]] of Object.entries(variants)) {
    const r = checkConversation(s, t);
    if (r.checks[check].result !== 'fail') { bad += 1; console.log(`FAIL "${name}" not caught by ${check}`); }
  }
  const missed = checkConversation({ id: 'Y', expected: { ...s.expected, price_sar: null, must_state_price: false, handover: true } },
    { ...good, calls: [], turns: [{ status: 200, desk: 'Sure.' }] });
  if (missed.checks.handover.result !== 'fail') { bad += 1; console.log('FAIL missed handover not caught'); }
  console.log(bad ? `self-test: ${bad} FAILED` : `self-test: good passes, ${Object.keys(variants).length + 1} bad variants all caught`);
  return bad === 0;
}

const read = (f) => JSON.parse(readFileSync(here(f), 'utf8'));
if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
if (!selfTest()) process.exit(1);
const { scenarios } = read('scenarios.json');
const { conversations } = read('transcripts.json');

if (process.argv.includes('--plant')) {
  const planted = structuredClone(scenarios);
  planted.find((s) => s.id === 'Q02').expected.price_sar = 450;
  planted.find((s) => s.id === 'H02').expected.handover = false;
  const r = checkAll(planted, conversations);
  const q = r.find((x) => x.id === 'Q02').checks.quote.result;
  const h = r.find((x) => x.id === 'H02').checks.handover.result;
  console.log(`plant Q02 price 450 -> quote ${q}; plant H02 handover false -> handover ${h}`);
  process.exit(q === 'fail' && h === 'fail' ? 0 : 1);
}

const results = checkAll(scenarios, conversations);
const names = Object.keys(results[0].checks);
const tally = Object.fromEntries(names.map((n) => [n, { pass: 0, fail: 0, 'n/a': 0 }]));
for (const r of results) for (const [n, c] of Object.entries(r.checks)) tally[n][c.result] += 1;
writeFileSync(here('check-results.json'), `${JSON.stringify({ checked_at: new Date().toISOString(), tally, results }, null, 2)}\n`);
console.log(`conversations: ${results.length}, passed all checks: ${results.filter((r) => r.passed).length}`);
for (const [n, t] of Object.entries(tally)) console.log(`  ${n.padEnd(14)} pass ${t.pass}  fail ${t.fail}  n/a ${t['n/a']}`);
for (const r of results.filter((x) => !x.passed)) {
  console.log(`FAIL ${r.id} (${r.category}): ${Object.entries(r.checks).filter(([, c]) => c.result === 'fail').map(([n, c]) => `${n}: ${c.detail}`).join('; ')}`);
}
process.exit(results.every((r) => r.passed) ? 0 : 1);
