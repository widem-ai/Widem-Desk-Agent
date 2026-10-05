// Widgets under the desk's message: built in code from the tool results of this turn and a small per-session
// state, never parsed from the model's text (the same principle as prices). The chat page renders them:
// slots as tappable chips, a quote as a price card, missing pricing details as a picker, and the step before
// booking as a short contact form.
import { readFileSync } from 'node:fs';
import { toWestern } from './guard.mjs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const SERVICES = DATA.services.map(({ id, name_en, name_ar }) => ({ id, name_en, name_ar }));
const TIERS = DATA.tiers.map(({ id, name_en, name_ar }) => ({ id, name_en, name_ar }));

/** What a session has already been shown: a quote, free slots. */
export const newWidgetState = () => ({ quoted: false, slotsOffered: false });

const quoteCard = (r) => ({
  type: 'quote', currency: r.currency ?? DATA.currency, tier: r.tier, tier_name_en: r.tier_name_en, tier_name_ar: r.tier_name_ar,
  lines: (r.lines ?? []).map(({ service, name_en, name_ar, price }) => ({ service, name_en, name_ar, price })),
  addons: (r.addons ?? []).map(({ id, name_en, name_ar, price, amount }) => ({ id, name_en, name_ar, price: price ?? amount })),
  subtotal: r.subtotal, discount: r.discount ?? 0, total: r.total,
});

const slotChips = (r) => ({
  type: 'slots',
  slots: (r.slots ?? []).map(({ start, end, label_en, label_ar }) => ({ start, end, label_en, label_ar })),
});

/** The widgets for one turn. toolCalls: [{ name, result }] from this turn; state: what the session has seen.
 * Returns { ui, state } with the state updated. After a booking or a handover the chat needs no widget. */
export function widgetsFor({ toolCalls = [], state = newWidgetState(), booked, handover } = {}) {
  const next = { ...state };
  const ui = [];
  if (state.done) return { ui, state: next };
  for (const c of toolCalls) {
    if (!c.result?.ok) continue;
    if (c.name === 'quote' && Number.isFinite(c.result.total)) {
      const old = ui.findIndex((w) => w.type === 'quote'); if (old >= 0) ui.splice(old, 1); // the latest quote wins
      ui.push(quoteCard(c.result)); next.quoted = true;
    }
    if (c.name === 'check_availability' && c.result.slots?.length) {
      const old = ui.findIndex((w) => w.type === 'slots'); if (old >= 0) ui.splice(old, 1);
      ui.push(slotChips(c.result)); next.slotsOffered = true;
    }
  }
  if (booked || handover || toolCalls.some((c) => c.result?.handover || (c.name === 'book' && c.result?.ok))) {
    return { ui: [], state: { ...next, done: true } };
  }
  ui.sort((a, b) => (a.type === 'quote' ? -1 : b.type === 'quote' ? 1 : 0));
  if (!ui.length && !next.quoted) ui.push({ type: 'details', services: SERVICES, tiers: TIERS });
  else if (!ui.length && next.slotsOffered) ui.push({ type: 'contact' });
  return { ui, state: next };
}

const TIME = /\d{1,2}:\d{2}/;
/** Drop the lines of a reply that list free times (the chips carry them), and a heading left with nothing under it.
 * Prices and every other line stay. */
export function trimSlotLines(reply) {
  if (typeof reply !== 'string') return reply;
  const lines = reply.split('\n');
  const drop = lines.map((l) => TIME.test(toWestern(l)));
  for (let i = 0; i < lines.length; i++) {
    if (drop[i] || !/[:：]\s*$/.test(lines[i])) continue;
    let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
    if (j < lines.length && drop[j]) drop[i] = true; // "Free times:" followed by the dropped list
  }
  return lines.filter((_, i) => !drop[i]).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A one-line reply when trimming left nothing, in the customer's language. */
export const pickSlotLine = (arabic) => (arabic ? 'اختر موعدًا يناسبك من المواعيد أدناه.' : 'Pick a time that suits you below.');
