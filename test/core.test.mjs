// The core ("one brain"): listServices() and quote() over the demo business file.
// Expected prices below are worked out by hand from data/demo-business.json, so a change
// to either the pricing rules or the file shows up here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listServices, quote } from '../src/core.mjs';

const data = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));

test('the data file says it is a fictional demo', () => {
  assert.equal(data.demo, true);
  assert.match(data.notice_en, /fictional/i);
  assert.ok(data.notice_ar.length > 0);
});

test('listServices returns every service with English and Arabic names and a price per tier', () => {
  const out = listServices();
  assert.equal(out.demo, true);
  assert.equal(out.currency, 'SAR');
  assert.deepEqual(out.services.map((s) => s.id),
    ['cv_rewrite', 'linkedin_profile', 'cover_letter', 'interview_coaching']);
  for (const s of out.services) {
    assert.ok(s.name_en && s.name_ar, `${s.id} needs both names`);
    assert.match(s.name_ar, /[؀-ۿ]/, `${s.id} Arabic name must be Arabic`);
    assert.deepEqual(Object.keys(s.prices), ['junior', 'mid', 'senior', 'executive']);
  }
  assert.deepEqual(out.bundles.map((b) => b.id), ['career_pack']);
  assert.deepEqual(out.addons.map((a) => a.id), ['express', 'arabic_version']);
});

test('listServices returns a copy: changing it cannot change the next quote', () => {
  listServices().services[0].prices.senior = 1;
  assert.equal(quote({ services: ['cv_rewrite'], tier: 'senior' }).total, 850);
});

// A3 at the core level: five scripted customer profiles.
const PROFILES = [
  { name: 'P1 senior manager, CV only',
    input: { services: ['cv_rewrite'], tier: 'senior' }, total: 850, discount: 0 },
  { name: 'P2 senior, full career pack (bundle, 10% off 1750)',
    input: { services: ['cv_rewrite', 'linkedin_profile', 'cover_letter'], tier: 'senior' }, total: 1575, discount: 175 },
  { name: 'P3 graduate, CV with express delivery',
    input: { services: ['cv_rewrite'], tier: 'junior', addons: ['express'] }, total: 600, discount: 0 },
  { name: 'P4 executive, pack + coaching + Arabic versions + express',
    input: { services: ['interview_coaching', 'cv_rewrite', 'linkedin_profile', 'cover_letter'], tier: 'executive',
      addons: ['arabic_version', 'express'] }, total: 4470, discount: 280 },
  { name: 'P5 mid-level, LinkedIn + coaching + Arabic version (LinkedIn only is eligible)',
    input: { services: ['linkedin_profile', 'interview_coaching'], tier: 'mid', addons: ['arabic_version'] },
    total: 1050, discount: 0 },
];

for (const p of PROFILES) {
  test(`A3 quote: ${p.name}`, () => {
    const q = quote(p.input);
    assert.equal(q.ok, true);
    assert.equal(q.total, p.total);
    assert.equal(q.discount, p.discount);
    assert.equal(q.currency, 'SAR');
    assert.equal(q.demo, true);
  });
}

test('P4 itemises lines, bundle and add-ons', () => {
  const q = quote(PROFILES[3].input);
  assert.deepEqual(q.lines.map((l) => [l.service, l.price]),
    [['cv_rewrite', 1400], ['linkedin_profile', 950], ['cover_letter', 450], ['interview_coaching', 1100]]);
  assert.equal(q.subtotal, 3900);
  assert.deepEqual(q.bundle, { id: 'career_pack', discount: 280 });
  assert.deepEqual(q.addons, [{ id: 'express', price: 250 }, { id: 'arabic_version', price: 600 }]); // catalogue order
});

test('A2b at the core: the same input always gives the identical quote', () => {
  for (const p of PROFILES) {
    const first = JSON.stringify(quote(p.input));
    for (let i = 0; i < 20; i++) assert.equal(JSON.stringify(quote(p.input)), first);
  }
});

test('order of services and add-ons in the request does not change the quote', () => {
  const a = quote({ services: ['cover_letter', 'cv_rewrite', 'linkedin_profile'], tier: 'mid', addons: ['express', 'arabic_version'] });
  const b = quote({ services: ['linkedin_profile', 'cover_letter', 'cv_rewrite'], tier: 'mid', addons: ['arabic_version', 'express'] });
  assert.deepEqual(a, b);
});

test('quote does not mutate its input', () => {
  const input = { services: ['cv_rewrite', 'cover_letter'], tier: 'mid', addons: ['express'] };
  const before = JSON.stringify(input);
  quote(input);
  assert.equal(JSON.stringify(input), before);
});

// Never a guessed price: anything outside the rules is refused with a reason code.
const REFUSALS = [
  ['unknown service', { services: ['salary_negotiation'], tier: 'senior' }, 'unknown_service'],
  ['unknown tier', { services: ['cv_rewrite'], tier: 'ceo' }, 'unknown_tier'],
  ['missing tier', { services: ['cv_rewrite'] }, 'unknown_tier'],
  ['no services', { services: [], tier: 'mid' }, 'no_services'],
  ['services not a list', { services: 'cv_rewrite', tier: 'mid' }, 'no_services'],
  ['duplicate service', { services: ['cv_rewrite', 'cv_rewrite'], tier: 'mid' }, 'duplicate_service'],
  ['unknown add-on', { services: ['cv_rewrite'], tier: 'mid', addons: ['discount_50'] }, 'unknown_addon'],
  ['add-on with nothing eligible', { services: ['interview_coaching'], tier: 'mid', addons: ['arabic_version'] }, 'addon_not_applicable'],
  ['no input at all', undefined, 'no_services'],
];

for (const [name, input, code] of REFUSALS) {
  test(`refuses, never guesses: ${name}`, () => {
    const q = quote(input);
    assert.equal(q.ok, false);
    assert.equal(q.error.code, code);
    assert.equal(q.total, undefined);
  });
}
