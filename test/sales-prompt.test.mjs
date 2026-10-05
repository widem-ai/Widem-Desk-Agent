// Prompt rule 6 per desk sales playbook v1 (section 4 and the conflicts section), slice 1, 2026-10-05.
// The sales stages are for people on the chat door only; agents on the MCP door call the tools and are not sold to.
// The fit table lives in the rules file, marked as the default mapping until Mohannad confirms it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SYSTEM_PROMPT } from '../src/chat.mjs';
import { toolsFor } from '../src/tools.mjs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const SERVICE_IDS = new Set(DATA.services.map((s) => s.id));
const ADDON_IDS = new Set(DATA.addons.map((a) => a.id));

test('the fit table is in the rules file, marked as the default mapping, and names only real services and add-ons', () => {
  const fit = DATA.fit;
  assert.equal(fit.status, 'default');
  assert.match(fit.note, /not yet confirmed/i);
  assert.ok(fit.rules.length >= 8, 'every row of the playbook table');
  for (const r of fit.rules) {
    assert.ok(r.when && r.recommend, 'each rule has a when and a recommend');
    for (const id of r.services ?? []) assert.ok(SERVICE_IDS.has(id), `unknown service ${id}`);
    for (const id of r.addons ?? []) assert.ok(ADDON_IDS.has(id), `unknown add-on ${id}`);
  }
});

test('rule 6 is replaced: four short sentences, exactly one ask, the old one-or-two-sentence rule is gone', () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /one or\s+two short sentences/);
  assert.match(SYSTEM_PROMPT, /four short sentences at most/);
  assert.match(SYSTEM_PROMPT, /exactly one ask/);
});

test('the stages are in the prompt: sift, goal question with buttons, two discovery replies, fit, quote, booking ask', () => {
  for (const [what, re] of [
    ['decided buyer quoted at once', /names the services and their years, call quote at once/],
    ['goal question with ask_choice', /ask_choice with topic goal/],
    ['timeline with ask_choice', /ask_choice with topic timeline/],
    ['two discovery replies at most', /at most two discovery replies/i],
    ['never budget', /never ask about budget/i],
    ['no contact before a pick', /never ask for a name or contact before the customer picks a time/i],
    ['their own words', /in their own words/],
    ['one recommendation from the fit rules', /recommend one option from the fit rules/i],
    ['priced only by quote', /call quote for it and state the total once/i],
    ['booking ask every reply from the quote on', /from the quote on, every reply ends with the booking ask/i],
    ['two loops at most', /at most two loops in the whole chat/i],
    ['lower the ask with one service', /start with one service/],
    ['discount is a handover, not a loop', /discount request is a handover, not a loop/i],
    ['a clear no: declined, one line, no ask', /ask_choice with topic declined, reply with one polite line, and ask nothing/],
    ['packages question is not a handover', /packages or offers is not a handover/i],
    ['no invented urgency or results', /never invent urgency, results, reviews or discounts/i],
  ]) assert.match(SYSTEM_PROMPT, re, what);
});

test('every fit rule from the rules file is in the prompt, so the data stays the one source', () => {
  assert.match(SYSTEM_PROMPT, /Fit rules \(default mapping/);
  for (const r of DATA.fit.rules) assert.ok(SYSTEM_PROMPT.includes(`${r.when}: ${r.recommend}`), r.when);
});

test('no en or em dashes in the prompt or the fit table (they leak into replies)', () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /[–—]/);
  assert.doesNotMatch(JSON.stringify(DATA.fit), /[–—]/);
});

test('the sales prompt is chat-only: the agent door never loads it, and its tools carry no selling', () => {
  const mcp = readFileSync(new URL('../src/mcp-server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(mcp, /SYSTEM_PROMPT/);
  for (const t of toolsFor('agent')) assert.doesNotMatch(t.description, /booking ask|objection|fit rules|sell/i, t.name);
});
