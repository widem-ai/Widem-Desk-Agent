// The recommendation behind the card (slice B, Alfred 2026-10-05). A pure function from the goal answer and the tier
// to one fit-table row: the services the card recommends, one value line (why) and the goal said back. The rows, the
// goal mapping and the why lines live in the rules file; why lines are drafts from the service descriptions only.
// Slice C wires it into the chat (the desk quotes it itself); this file covers the choice alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recommendation, goalFromText, mentionsLinkedIn } from '../src/recommend.mjs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const ids = (r) => r.services.map((s) => s.id);

test('every fit row has a bilingual why line, drafted, factual, no promised outcome', () => {
  assert.equal(DATA.fit.status, 'default', 'the mapping is still the unconfirmed default');
  assert.equal(DATA.fit.why_status, 'draft', 'why lines wait for Mohannad');
  for (const r of DATA.fit.rules) {
    assert.ok(r.why_en && r.why_ar, `${r.when}: why in both languages`);
    assert.doesNotMatch(r.why_ar.replace(/LinkedIn/g, ''), /[A-Za-z]/, `${r.when}: no Latin in Arabic apart from LinkedIn`);
    assert.doesNotMatch(`${r.why_en}${r.why_ar}`, /[–—]/, 'no en or em dashes');
    assert.doesNotMatch(r.why_en, /guarantee|ensure|land|get (you )?(the|a) job|hired|success|will help you/i, `${r.when}: no promise`);
    assert.doesNotMatch(r.why_ar, /نضمن|مضمون|ستحصل|توظيفك|نجاح/, `${r.when}: no promise`);
    assert.doesNotMatch(`${r.why_en}${r.why_ar}`, /SAR|ريال/, 'no prices: the card total comes from quote');
  }
});

test('live run case: new job, mid, LinkedIn never mentioned: CV rewrite only, goal said back from the button label', () => {
  const r = recommendation({ goal: 'new_job', tier: 'mid' });
  assert.deepEqual(ids(r), ['cv_rewrite'], 'no uninvited LinkedIn');
  assert.equal(r.tier, 'mid');
  assert.equal(r.goal_line_ar, 'هدفك: وظيفة جديدة');
  assert.equal(r.goal_line_en, 'Your goal: new job');
  const row = DATA.fit.rules.find((x) => x.goal === 'new_job' && !x.linkedin);
  assert.equal(r.why_en, row.why_en); assert.equal(r.why_ar, row.why_ar);
  assert.deepEqual(r.services[0], { id: 'cv_rewrite', name_en: 'CV rewrite', name_ar: 'إعادة كتابة السيرة الذاتية' });
  assert.equal(r.status, 'default'); assert.equal(r.why_status, 'draft');
});

test('new job with LinkedIn mentioned: the career pack row', () => {
  assert.deepEqual(ids(recommendation({ goal: 'new_job', tier: 'senior', linkedin: true })), ['cv_rewrite', 'linkedin_profile', 'cover_letter']);
});

test('career switch: CV rewrite; promotion: the row\'s first service as the default, no extra question', () => {
  assert.deepEqual(ids(recommendation({ goal: 'career_switch', tier: 'junior' })), ['cv_rewrite']);
  const p = recommendation({ goal: 'promotion', tier: 'executive' });
  assert.deepEqual(ids(p), ['interview_coaching']);
  assert.equal(p.goal_line_ar, 'هدفك: ترقية');
});

test('no card without a known goal row and a known tier', () => {
  assert.equal(recommendation({ goal: 'other', tier: 'mid' }), null, '"something else" has no row');
  assert.equal(recommendation({ goal: 'new_job', tier: 'intern' }), null);
  assert.equal(recommendation({ goal: 'budget', tier: 'mid' }), null);
  assert.equal(recommendation({ goal: 'new_job' }), null);
});

test('a typed goal counts when it matches a goal option label; LinkedIn is noticed in either script', () => {
  assert.equal(goalFromText('وظيفة جديدة'), 'new_job');
  assert.equal(goalFromText('  New job '), 'new_job');
  assert.equal(goalFromText('أبغى ترقية في شركتي'), 'promotion');
  assert.equal(goalFromText('هذا الشهر'), null);
  assert.equal(goalFromText(''), null);
  assert.equal(mentionsLinkedIn('my linkedin is weak'), true);
  assert.equal(mentionsLinkedIn('حسابي في لينكد إن قديم'), true);
  assert.equal(mentionsLinkedIn('خبرتي ٦ سنوات في التسويق'), false);
});
