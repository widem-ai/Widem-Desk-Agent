// The desk works out the tier from what the customer says (years of experience, executive or not),
// so no model and no agent ever chooses a tier or a price. The bounds live in the data file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tierFor } from '../src/core.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { TOOLS } from '../src/tools.mjs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const at = (iso) => () => new Date(iso);
const desk = () => createDesk({ store: createMemoryStore(), now: at('2026-10-04T08:00:00+03:00') });
const AGENT = { door: 'agent' };

test('the tier bounds are in the data file, next to the tier names', () => {
  const byId = Object.fromEntries(DATA.tiers.map((t) => [t.id, t]));
  assert.equal(byId.junior.min_years, 0);
  assert.equal(byId.mid.min_years, 3);
  assert.equal(byId.senior.min_years, 8);
  assert.equal(byId.executive.executive, true);
});

test('boundaries at 3 and 8 years, and is_executive overrides years', () => {
  const cases = [[0, 'junior'], [2.9, 'junior'], [3, 'mid'], [7.9, 'mid'], [8, 'senior'], [12, 'senior'], [40, 'senior']];
  for (const [years, tier] of cases) {
    assert.equal(tierFor({ years_experience: years }), tier, `${years} years`);
    assert.equal(desk().quote({ services: ['cv_rewrite'], years_experience: years }, AGENT).tier, tier);
  }
  assert.equal(tierFor({ years_experience: 1, is_executive: true }), 'executive');
  assert.equal(tierFor({ years_experience: 12, is_executive: false }), 'senior');
});

test('a tier passed straight to the desk is ignored: only the facts count', () => {
  const q = desk().quote({ services: ['cv_rewrite'], tier: 'junior', years_experience: 12 }, AGENT);
  assert.equal(q.tier, 'senior');
  assert.equal(q.total, 850);
});

test('missing or impossible experience is a plain refusal to ask again, not a handover', () => {
  for (const input of [{ services: ['cv_rewrite'] }, { services: ['cv_rewrite'], years_experience: -1 },
    { services: ['cv_rewrite'], years_experience: 'ten' }]) {
    const d = desk();
    const q = d.quote(input, AGENT);
    assert.equal(q.ok, false);
    assert.equal(q.error.code, 'needs_experience');
    assert.equal(q.handover, undefined);
  }
});

test('quote and book ask for facts, never a tier, and say who counts as executive in both languages', () => {
  for (const name of ['quote', 'book']) {
    const { params } = TOOLS.find((t) => t.name === name);
    assert.equal(params.tier, undefined);
    assert.equal(params.years_experience.type, 'number');
    assert.equal(params.years_experience.optional, undefined);
    assert.equal(params.is_executive.type, 'boolean');
    assert.match(params.is_executive.describe, /general manager/);
    assert.match(params.is_executive.describe, /مدير عام/);
  }
});
