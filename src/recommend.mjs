// The one recommendation for a customer, chosen in code from the fit table in the rules file (desk sales playbook
// stage 4). Input: the goal answer (a goal button id) and the tier (a tier button id). Output: the services the card
// recommends, one value line from the row, and the goal said back from the button's own label. The desk prices it
// only with quote; nothing here is a price. The mapping is the unconfirmed default (fit.status) and the why lines are
// drafts (fit.why_status) until Mohannad reviews them.
import { readFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const GOALS = DATA.choices.goal.options;
const SERVICE = new Map(DATA.services.map(({ id, name_en, name_ar }) => [id, { id, name_en, name_ar }]));
const TIER_IDS = new Set(DATA.tiers.map((t) => t.id));

/** The fit row and card for a goal and tier, or null when either is unknown or the goal has no row ("other"). */
export function recommendation({ goal, tier, linkedin = false } = {}) {
  const option = GOALS.find((o) => o.id === goal);
  if (!option || !TIER_IDS.has(tier)) return null;
  const rows = DATA.fit.rules.filter((r) => r.goal === goal);
  const row = rows.find((r) => Boolean(r.linkedin) === Boolean(linkedin)) ?? rows.find((r) => !r.linkedin);
  if (!row) return null;
  return {
    goal, tier,
    goal_line_en: `Your goal: ${option.en.toLowerCase()}`, goal_line_ar: `هدفك: ${option.ar}`,
    services: (row.card_services ?? row.services).map((id) => SERVICE.get(id)),
    why_en: row.why_en, why_ar: row.why_ar,
    status: DATA.fit.status, why_status: DATA.fit.why_status,
  };
}

const norm = (t) => String(t ?? '').trim().toLowerCase();
/** The goal button id a typed message names, by the button labels in either language; null when none does. */
export function goalFromText(text) {
  const t = norm(text);
  if (!t) return null;
  return GOALS.find((o) => [o.en, o.ar].some((label) => t.includes(norm(label))))?.id ?? null;
}

/** Whether the customer brought up LinkedIn themselves (the career pack row needs that). */
export const mentionsLinkedIn = (text) => /linked\s*in|لينكد/i.test(String(text ?? ''));
