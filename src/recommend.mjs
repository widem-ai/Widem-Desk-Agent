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

/** The tier id of a tapped years button: the page sends the button's label, so only an exact label counts. A number
 * of years typed by the customer is not mapped here (the 3-years overlap between the junior and mid labels). */
export function tierFromText(text) {
  const t = norm(text);
  return DATA.tiers.find((x) => [x.name_en, x.name_ar].some((label) => norm(label) === t))?.id ?? null;
}

const TOP_YEARS = Math.max(...DATA.tiers.map((t) => t.min_years ?? 0));
/** The quote arguments for a recommendation: years at the tier's lower bound, is_executive only for executive. */
export function quoteArgsFor(rec) {
  const tier = DATA.tiers.find((t) => t.id === rec.tier);
  const services = rec.services.map((s) => s.id);
  return tier.executive ? { services, years_experience: TOP_YEARS, is_executive: true }
    : { services, years_experience: tier.min_years, is_executive: false };
}

export const REC_CALL_PREFIX = 'desk_rec';
/** The recommendation a conversation is ready for: a goal and a tapped tier in the customer's own messages, and no
 * recommendation made yet in this session. LinkedIn counts only when the customer said it. Null otherwise. */
export function pendingRecommendation(messages) {
  if (messages.some((m) => m.tool_calls?.some((c) => String(c.id).startsWith(REC_CALL_PREFIX)))) return null;
  const said = messages.filter((m) => m.role === 'user').map((m) => String(m.content ?? ''));
  const goal = said.map(goalFromText).findLast(Boolean);
  const tier = said.map(tierFromText).findLast(Boolean);
  if (!goal || !tier) return null;
  return recommendation({ goal, tier, linkedin: said.some(mentionsLinkedIn) });
}
