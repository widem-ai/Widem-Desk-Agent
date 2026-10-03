// The core ("one brain"). Every door (the MCP server today, the chat page later) calls these
// functions and nothing else, so a customer gets the same answer whichever door they use.
// Pure and deterministic: no clock, no randomness, no I/O after the data file loads.
import { readFileSync } from 'node:fs';

const DATA = deepFreeze(JSON.parse(
  readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8')));

const SERVICE_ORDER = DATA.services.map((s) => s.id);
const ADDON_ORDER = DATA.addons.map((a) => a.id);
const TIER_IDS = DATA.tiers.map((t) => t.id);

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * The tier for what a customer says: executive when is_executive is true, otherwise the highest tier whose
 * min_years the years of experience reach. The bounds come from the data file. Null when years is unusable.
 */
export function tierFor({ years_experience: years, is_executive: executive } = {}) {
  if (executive === true) return DATA.tiers.find((t) => t.executive).id;
  if (typeof years !== 'number' || !Number.isFinite(years) || years < 0) return null;
  let best = null;
  for (const t of DATA.tiers) {
    if (!t.executive && years >= t.min_years && (!best || t.min_years > best.min_years)) best = t;
  }
  return best ? best.id : null;
}

/** The whole public offer: services with a price per tier, bundles and add-ons, in both languages. */
export function listServices() {
  const { demo, notice_en, notice_ar, business, currency, tiers, services, bundles, addons } = DATA;
  return clone({ demo, notice_en, notice_ar, business, currency, tiers, services, bundles, addons });
}

function refuse(code, message) {
  return { ok: false, demo: true, error: { code, message } };
}

/**
 * Price an order. input: { services: string[], tier: string, addons?: string[] }.
 * Returns { ok: true, ...itemised quote } or { ok: false, error: { code, message } }.
 * It never guesses: anything outside the rules is refused with a reason code.
 */
export function quote(input) {
  const services = input?.services;
  if (!Array.isArray(services) || services.length === 0) {
    return refuse('no_services', 'Name at least one service id from list_services.');
  }
  const tier = input.tier;
  if (!TIER_IDS.includes(tier)) {
    return refuse('unknown_tier', `Tier must be one of: ${TIER_IDS.join(', ')}.`);
  }
  for (const id of services) {
    if (!SERVICE_ORDER.includes(id)) return refuse('unknown_service', `No service with id "${id}".`);
  }
  if (new Set(services).size !== services.length) {
    return refuse('duplicate_service', 'Each service can appear once per order.');
  }
  const addonIds = input.addons ?? [];
  if (!Array.isArray(addonIds)) return refuse('unknown_addon', 'addons must be a list of add-on ids.');
  for (const id of addonIds) {
    if (!ADDON_ORDER.includes(id)) return refuse('unknown_addon', `No add-on with id "${id}".`);
  }
  if (new Set(addonIds).size !== addonIds.length) {
    return refuse('unknown_addon', 'Each add-on can appear once per order.');
  }

  // Catalogue order, not request order, so the same order always reads the same.
  const chosen = DATA.services.filter((s) => services.includes(s.id));
  const lines = chosen.map((s) => ({ service: s.id, name_en: s.name_en, name_ar: s.name_ar, price: s.prices[tier] }));
  const subtotal = lines.reduce((sum, l) => sum + l.price, 0);

  let bundle = null;
  for (const b of DATA.bundles) {
    if (b.services.every((id) => services.includes(id))) {
      const base = lines.filter((l) => b.services.includes(l.service)).reduce((sum, l) => sum + l.price, 0);
      const discount = base - Math.round((base * (100 - b.discount_percent)) / 100);
      bundle = { id: b.id, discount };
      break; // one bundle per order
    }
  }
  const discount = bundle ? bundle.discount : 0;

  const addons = [];
  for (const a of DATA.addons.filter((x) => addonIds.includes(x.id))) {
    let price;
    if (a.pricing.type === 'flat_per_order') {
      price = a.pricing.amount;
    } else if (a.pricing.type === 'flat_per_document') {
      const docs = chosen.filter((s) => s.document).length;
      if (docs === 0) return refuse('addon_not_applicable', `"${a.id}" needs at least one document service.`);
      price = a.pricing.amount * docs;
    } else {
      return refuse('unknown_addon', `Add-on "${a.id}" has no pricing rule.`);
    }
    addons.push({ id: a.id, price });
  }
  const addonsTotal = addons.reduce((sum, a) => sum + a.price, 0);

  return {
    ok: true,
    demo: true,
    currency: DATA.currency,
    tier,
    lines,
    subtotal,
    bundle,
    discount,
    addons,
    total: subtotal - discount + addonsTotal,
  };
}

/** The frozen rules file, for the stateful part of the desk (src/desk.mjs). Never sent to a customer whole. */
export const RULES = DATA;
