// Runs the Toloka set through the chat door's real path: POST /chat on a local server (memory store, nothing kept),
// the real model on Nebius Token Factory, one fresh server per conversation. Same harness as smoke/sample-transcripts.mjs.
//   node --env-file=.env eval/toloka-set-v1/run.mjs [--only Q02,K01] [--out transcripts.json] [--stop-usd 0.25]
// Writes <out> and a readable .md next to it. Token counts come from the API's usage field. The key is never printed.
// Spend guard: before each conversation, if spend so far plus the most expensive conversation yet would pass
// --stop-usd, it stops and writes what it has.
import { writeFileSync, readFileSync } from 'node:fs';
import { createHttpServer } from '../../src/mcp-server.mjs';
import { createNebiusModel, modelFromEnv } from '../../src/chat.mjs';
import { createDesk } from '../../src/desk.mjs';
import { createMemoryStore } from '../../src/store.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; };
const ONLY = arg('--only', null)?.split(',');
const OUT = arg('--out', 'transcripts.json');
const STOP_USD = Number(arg('--stop-usd', '0.25'));
// Estimate only: Nemotron 3 Super's Token Factory price (models.dev, 2026-10-10), as in scripts/live-adversarial.mjs.
// The price of nvidia/Nemotron-3.5-Super-VL is not confirmed; STOP_USD is set at half the USD 0.50 cap to absorb that.
const PRICE_IN = 0.30;
const PRICE_OUT = 0.90;
const usd = (u) => (u.prompt * PRICE_IN + u.completion * PRICE_OUT) / 1e6;

const { scenarios } = JSON.parse(readFileSync(new URL('scenarios.json', import.meta.url), 'utf8'));
const MODEL = modelFromEnv();

async function run({ id, turns }) {
  const usage = { calls: 0, prompt: 0, completion: 0 };
  const countingFetch = async (url, options) => {
    const res = await fetch(url, options);
    try {
      const data = await res.clone().json();
      usage.calls += 1; usage.prompt += data.usage?.prompt_tokens ?? 0; usage.completion += data.usage?.completion_tokens ?? 0;
    } catch { /* the model client reports the failure itself */ }
    return res;
  };
  const store = createMemoryStore();
  const desk = createDesk({ store });
  const calls = [];
  const recorded = new Proxy(desk, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== 'function') return value;
      return (...args) => { const result = value.apply(target, args); calls.push({ tool: name, args: args[0], result }); return result; };
    },
  });
  const server = createHttpServer({ desk: recorded, model: createNebiusModel({ model: MODEL, fetchImpl: countingFetch }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/chat`;
  const ranAt = new Date().toISOString();
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
  return { id, model: MODEL, temperature: 0, ran_at: ranAt, turns: log,
    calls: calls.map((c) => ({ ...c, args: c.args && typeof c.args === 'object' ? pick(c.args) : c.args })),
    bookings: store.all('bookings').map(pick), handovers: store.all('handovers').map(pick), usage };
}

const conversations = [];
const total = { calls: 0, prompt: 0, completion: 0 };
let worst = 0;
let stopped = null;
for (const s of scenarios.filter((x) => !ONLY || ONLY.includes(x.id))) {
  if (usd(total) + worst > STOP_USD) { stopped = `stopped before ${s.id}: USD ${usd(total).toFixed(4)} spent + ${worst.toFixed(4)} worst case > ${STOP_USD}`; break; }
  const c = await run(s);
  conversations.push(c);
  for (const k of Object.keys(total)) total[k] += c.usage[k];
  worst = Math.max(worst, usd(c.usage));
  console.error(`${s.id}: ${c.usage.calls} calls, ${c.usage.prompt} in, ${c.usage.completion} out; total USD ${usd(total).toFixed(4)}`);
}

const meta = { set: 'toloka-set-v1', model: MODEL, temperature: 0, door: 'chat (POST /chat, local server, memory store)',
  price_estimate_usd_per_1m: { input: PRICE_IN, output: PRICE_OUT, source: 'models.dev Nemotron 3 Super, unconfirmed for this model' },
  usage: { ...total, usd_estimate: Number(usd(total).toFixed(4)) }, stopped };
const outPath = new URL(OUT, import.meta.url);
writeFileSync(outPath, `${JSON.stringify({ ...meta, conversations }, null, 2)}\n`);

const md = [`# Toloka set v1: transcripts`, '', `Model \`${MODEL}\`, temperature 0, through the chat door (POST /chat) on a local server. Demo business, fictional.`, ''];
for (const c of conversations) {
  const s = scenarios.find((x) => x.id === c.id);
  md.push(`## ${c.id} (${s.category})`, '', `Model \`${c.model}\`, ran at ${c.ran_at}.`, '');
  for (const t of c.turns) md.push(`**Customer:** ${t.customer}`, '', `**Desk:** ${t.desk ?? `(error: ${t.error}, HTTP ${t.status})`}`, '');
  md.push(`Tools called: ${c.calls.map((x) => x.tool).join(', ') || 'none'}. Bookings: ${c.bookings.length}. Handovers: ${c.handovers.map((h) => h.reason).join(', ') || 'none'}.`, '');
}
writeFileSync(new URL(OUT.replace(/\.json$/, '.md'), import.meta.url), md.join('\n'));
console.error(`model ${MODEL}; ${conversations.length} conversations; ${total.calls} model calls, ${total.prompt} in, ${total.completion} out; about USD ${usd(total).toFixed(4)}${stopped ? `; ${stopped}` : ''}`);
