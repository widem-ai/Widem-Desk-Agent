// npm run check: every gate in one command (spec A-last). Add -- --live for the adversarial set on the real model (costs credit).
//   npm run check            the gates: tests, secret scan (tree + history), README tools, ARCHITECTURE warning
//   npm run check -- --plant also plants one break per guard, asserts its gate goes red, and restores the file
// It never leaves the tree dirty: --plant refuses to start on a dirty tree, keeps every original in memory,
// restores in finally (and on Ctrl+C), and fails if `git status` is not clean at the end.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLANT = process.argv.includes('--plant');
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts });
const gitStatus = () => sh('git', ['status', '--porcelain']).stdout.trim();

// ---- gates -------------------------------------------------------------------------------------------------------

/** The full test suite. Returns { ok, pass, fail, line }. */
function testsGate() {
  const r = sh(process.execPath, ['--test', '--test-reporter=spec', 'test/*.test.mjs']);
  const out = `${r.stdout}\n${r.stderr}`;
  const num = (k) => Number((out.match(new RegExp(`ℹ ${k} (\\d+)`)) ?? [])[1] ?? NaN);
  const pass = num('pass');
  const fail = num('fail');
  const ok = r.status === 0 && fail === 0 && pass > 0;
  return { ok, pass, fail, line: `tests: ${pass} pass, ${fail} fail` };
}

// Shapes of real secrets. A value must be present: `NEBIUS_API_KEY=` with nothing after it is the example file.
const SECRET_PATTERNS = [
  // [ \t] not \s: an empty `KEY=` must not run on into the next line's text.
  ['an assigned Nebius key', /NEBIUS_API_KEY[ \t]*=[ \t]*['"]?[A-Za-z0-9._\-]{8,}/],
  ['an assigned owner token', /OWNER_TOKEN[ \t]*=[ \t]*['"]?[A-Za-z0-9+/=._\-]{8,}/],
  ['an sk- API key', /\bsk-[A-Za-z0-9_\-]{20,}/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['an AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['a private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a JWT', /\beyJ[A-Za-z0-9_\-]{15,}\.eyJ[A-Za-z0-9_\-]{15,}\.[A-Za-z0-9_\-]{10,}/],
  ['a bearer credential', /Bearer\s+[A-Za-z0-9._\-]{32,}/],
];

/** Real values from the local .env (never printed): none may appear anywhere outside .env. */
function localSecretValues() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*['"]?(.*?)['"]?\s*$/))
    .filter((m) => m && /KEY|TOKEN|SECRET|PASSWORD/.test(m[1]) && m[2].length >= 12)
    .map((m) => ({ name: m[1], value: m[2] }));
}

/** Secret scan of every file in the tree (tracked and untracked, not ignored) and of all git history. */
function secretsGate() {
  const problems = [];
  const files = sh('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).stdout.split('\0').filter(Boolean);
  const values = localSecretValues();
  for (const f of files) {
    const p = join(ROOT, f);
    if (!existsSync(p) || statSync(p).size > 2 * 1024 * 1024) continue;
    const text = readFileSync(p, 'utf8');
    for (const [what, re] of SECRET_PATTERNS) if (re.test(text)) problems.push(`${what} in ${f}`);
    for (const { name } of values.filter((v) => text.includes(v.value))) problems.push(`the local ${name} value in ${f}`);
  }
  const history = sh('git', ['log', '--all', '-p', '--no-color', '--no-ext-diff']).stdout;
  for (const [what, re] of SECRET_PATTERNS) if (re.test(history)) problems.push(`${what} in git history`);
  for (const { name } of values.filter((v) => history.includes(v.value))) problems.push(`the local ${name} value in git history`);
  if (sh('git', ['ls-files', '--error-unmatch', '.env']).status === 0) problems.push('.env is tracked');
  if (sh('git', ['log', '--all', '--format=%H', '--', '.env']).stdout.trim()) problems.push('.env was committed in the past');
  if (existsSync(join(ROOT, '.env')) && sh('git', ['check-ignore', '-q', '.env']).status !== 0) problems.push('.env is not gitignored');
  return { ok: problems.length === 0, problems,
    line: problems.length ? `secrets: ${problems.length} problem(s): ${problems.join('; ')}`
      : `secrets: clean (${files.length} files, all history, ${values.length} local value(s) checked, .env untracked)` };
}

/** The README names every tool the agent door serves, and there are six. */
async function readmeGate() {
  const { toolsFor } = await import(`${pathToFileURL(join(ROOT, 'src/tools.mjs')).href}?t=${Date.now()}`);
  const names = toolsFor('agent').map((t) => t.name);
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  // Each tool needs its own row in the tools table, not just a mention somewhere in the text.
  const missing = names.filter((n) => !readme.includes(`| \`${n}\` |`));
  const ok = names.length === 6 && missing.length === 0;
  return { ok, line: ok ? `readme: names all 6 agent-door tools (${names.join(', ')})`
    : `readme: ${names.length} agent-door tools in code; missing from README: ${missing.join(', ') || 'none'}` };
}

function architectureWarning() {
  return existsSync(join(ROOT, 'ARCHITECTURE.md')) ? null
    : 'warning: no ARCHITECTURE.md (owners, boundaries and what must never break are not written down)';
}

// ---- planted breaks: one per guard, each must turn its gate red ---------------------------------------------------

const PLANTS = [
  ['A2b', 'agent door rounds the booked price to 100', 'src/desk.mjs',
    '        price_quoted: q.total,', "        price_quoted: d === 'agent' ? Math.round(q.total / 100) * 100 : q.total,"],
  ['A3', 'quote ignores the bundle discount', 'src/core.mjs',
    '    total: subtotal - discount + addonsTotal,', '    total: subtotal + addonsTotal,'],
  ['A4', 'a refusal the rules cannot price is not handed over', 'src/desk.mjs',
    '    if (!HO.refusal_codes.includes(refusal.error.code)) return refusal;', '    return refusal;'],
  ['A4', 'the invented-price guard checks no amounts', 'src/guard.mjs',
    '  for (const re of [AMOUNT_AFTER, AMOUNT_BEFORE]) {', '  for (const re of []) {'],
  ['A6', 'owner page open without OWNER_TOKEN', 'src/owner.mjs',
    '    if (!enabled) { res.writeHead(404).end(); return; }', '    if (false) { res.writeHead(404).end(); return; }'],
  ['A6', 'owner page accepts a short token', 'src/owner.mjs',
    'token.length >= MIN_TOKEN_LENGTH;', 'token.length >= 1;'],
  ['A6', 'wrong owner tokens are not counted', 'src/owner.mjs', '      failures.add(ip);', '      void ip;'],
  ['A6', 'the global sign-in lock is never checked', 'src/owner.mjs',
    '    if (failures.locked()) {', '    if (false && failures.locked()) {'],
  ['A6', 'customer text is not escaped', 'src/owner.mjs',
    "export const esc = (v) => String(v ?? '').replace(", "export const esc = (v) => String(v ?? ''); export const escOff = (v) => String(v ?? '').replace("],
  ['A6', 'owner token taken from the URL', 'src/owner.mjs',
    '? auth.slice(7) : undefined;', "? auth.slice(7) : new URL(req.url, 'http://x').searchParams.get('token') ?? undefined;"],
  ['A6', 'x-frame-options dropped from the owner page', 'src/owner.mjs', "  'x-frame-options': 'DENY',\n", ''],
  ['A7', '/mcp per-IP limit removed', 'src/mcp-server.mjs',
    "const wait = mcpPerIp.take(ip) || mcpGlobal.take('all');", "const wait = mcpGlobal.take('all');"],
  ['A7', '/mcp global limit removed', 'src/mcp-server.mjs',
    "const wait = mcpPerIp.take(ip) || mcpGlobal.take('all');", 'const wait = mcpPerIp.take(ip);'],
  ['A7', '/mcp initialize limit skipped', 'src/mcp-server.mjs',
    'const waitNew = starts ? mcpNewSessions.take(ip) : 0;', 'const waitNew = 0;'],
  ['A7', '/mcp accepts JSON-RPC batches', 'src/mcp-server.mjs',
    'Array.isArray(parsed) && parsed.length > 1)', 'Array.isArray(parsed) && parsed.length > 1000)'],
  ['A7', '/chat limits removed', 'src/mcp-server.mjs',
    "const wait = perIp.take(ip) || (sessionId === undefined && newSessions.take(ip)) || global.take('all');", 'const wait = 0;'],
  ['A7', 'the 3-bookings cap switched off', 'src/desk.mjs',
    'if (client && activeFor(client) >= maxActivePerClient)', 'if (false && client && activeFor(client) >= maxActivePerClient)'],
  ['A7', 'the chat door does not pass the caller to the cap', 'src/mcp-server.mjs',
    'message, { client: ip });', 'message, {});'],
  ['A7', 'CF-Connecting-IP trusted without TRUST_PROXY', 'src/mcp-server.mjs',
    "if (trustProxy === 'cloudflare' && typeof header", 'if (typeof header'],
];

const originals = new Map(); // file -> original text, restored in finally
function restoreAll() {
  for (const [file, text] of originals) writeFileSync(join(ROOT, file), text);
  originals.clear();
}
const SECRET_FILE = 'plant-secret.check.tmp';
function cleanupPlantFiles() { rmSync(join(ROOT, SECRET_FILE), { force: true }); }

async function runPlants() {
  const rows = [];
  for (const [criterion, name, file, find, replace] of PLANTS) {
    const path = join(ROOT, file);
    const text = readFileSync(path, 'utf8');
    const count = text.split(find).length - 1;
    if (count !== 1) { rows.push({ ok: false, line: `NOT APPLIED [${criterion}] ${name}: the code to break was found ${count} times` }); continue; }
    originals.set(file, text);
    try {
      writeFileSync(path, text.replace(find, replace));
      const t = testsGate();
      rows.push({ ok: t.fail > 0, line: `${t.fail > 0 ? 'CAUGHT' : 'MISSED'} [${criterion}] ${name}: ${t.line}` });
    } finally { restoreAll(); }
    if (readFileSync(path, 'utf8') !== text) throw new Error(`${file} was not restored`);
  }
  // The non-test gates get their own breaks.
  try {
    writeFileSync(join(ROOT, SECRET_FILE), `NEBIUS_API_KEY=${'x'.repeat(40)}\n`);
    const s = secretsGate();
    rows.push({ ok: !s.ok, line: `${!s.ok ? 'CAUGHT' : 'MISSED'} [A8] a key in an untracked file: ${s.ok ? 'scan clean' : s.problems.join('; ')}` });
  } finally { cleanupPlantFiles(); }
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  if (readme.split('| `pay` |').length - 1 !== 1) {
    rows.push({ ok: false, line: 'NOT APPLIED [A8] README tool row: "| `pay` |" not found once' });
  } else {
    originals.set('README.md', readme);
    try {
      writeFileSync(join(ROOT, 'README.md'), readme.replace('| `pay` |', '| pay |'));
      const r = await readmeGate();
      rows.push({ ok: !r.ok, line: `${!r.ok ? 'CAUGHT' : 'MISSED'} [A8] README loses a tool name: ${r.line}` });
    } finally { restoreAll(); }
  }
  return rows;
}

// ---- main ---------------------------------------------------------------------------------------------------------

process.on('SIGINT', () => { restoreAll(); cleanupPlantFiles(); process.exit(130); });

async function main() {
  const startStatus = gitStatus();
  if (PLANT && startStatus) {
    console.log('check --plant needs a clean tree (it rewrites source files and restores them). Commit or stash first:');
    console.log(startStatus);
    return 2;
  }
  let failed = 0;
  const report = (ok, line) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`); if (!ok) failed += 1; };
  const t = testsGate(); report(t.ok, t.line);
  const s = secretsGate(); report(s.ok, s.line);
  const r = await readmeGate(); report(r.ok, r.line);
  const warn = architectureWarning(); if (warn) console.log(`WARN  ${warn}`);
  // The live set's checkers, tested on hand-written replies (no model, no credit).
  const self = sh(process.execPath, ['scripts/live-adversarial.mjs', '--self-test']);
  report(self.status === 0, `live-set checkers: ${self.stdout.trim().split('\n').at(-1)}`);
  if (process.argv.includes('--live')) { // spends Token Factory credit: only on request
    if (!existsSync(join(ROOT, '.env'))) console.log('WARN  live: skipped, no .env with the Token Factory key');
    else {
      const live = sh(process.execPath, ['--env-file=.env', 'scripts/live-adversarial.mjs', '--runs', '2']);
      const lines = live.stdout.trim().split('\n');
      for (const l of lines.filter((x) => /^(FAIL #|  prompt|  reply|tokens:)/.test(x))) console.log(`      ${l}`);
      report(live.status === 0, lines.at(-1));
    }
  }

  if (PLANT) {
    console.log('\nPlanted breaks (each must turn its gate red; every file is restored after its run):');
    let rows;
    try { rows = await runPlants(); } finally { restoreAll(); cleanupPlantFiles(); }
    for (const row of rows) { console.log(`  ${row.line}`); if (!row.ok) failed += 1; }
    console.log(`  ${rows.filter((x) => x.ok).length} of ${rows.length} caught`);
  }

  const endStatus = gitStatus();
  const clean = endStatus === startStatus;
  report(clean, clean ? `git status unchanged by the check (${endStatus ? 'it was already dirty' : 'clean'})`
    : `git status changed during the check:\n${endStatus}`);
  console.log(failed ? `\ncheck: ${failed} problem(s)` : '\ncheck: all gates green');
  return failed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (err) => {
  restoreAll(); cleanupPlantFiles();
  console.error('check crashed; files restored:', err.message);
  process.exitCode = 1;
});
