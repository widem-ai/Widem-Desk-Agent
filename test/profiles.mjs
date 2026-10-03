// The five scripted customer profiles (spec A3, A2b), shared by every door's tests.
// Totals are worked out by hand from data/demo-business.json.
export const PROFILES = [
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

// What each customer tells a door: facts, never a tier. The desk works the tier out (spec A3).
const FACTS = [{ years_experience: 12 }, { years_experience: 10 }, { years_experience: 1 },
  { years_experience: 20, is_executive: true }, { years_experience: 5 }];
PROFILES.forEach((p, i) => {
  const { tier, ...rest } = p.input;
  p.order = { ...rest, ...FACTS[i] };
});
