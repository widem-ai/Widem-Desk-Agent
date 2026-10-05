// Widgets under the desk's message: built in code from the tool results of this turn and a small per-session
// state, never parsed from the model's text (the same principle as prices). The chat page renders them:
// slots as tappable chips, a quote as a price card, missing pricing details as a picker, and the step before
// booking as a short contact form.
import { readFileSync } from 'node:fs';
import { toWestern, statedAmounts } from './guard.mjs';

const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const SERVICES = DATA.services.map(({ id, name_en, name_ar }) => ({ id, name_en, name_ar }));
const PAY = DATA.payment;
const AV = DATA.availability;
/** HH:MM of an instant in the business timezone. */
const clock = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: AV.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const TIERS = DATA.tiers.map(({ id, name_en, name_ar }) => ({ id, name_en, name_ar }));

const CHOICE_TOPICS = ['goal', 'timeline', 'years', 'declined'];
/** The ask_choice tool: the model names a discovery topic from a fixed list and gets its answer options from the
 * rules file. "years" offers the pricing tiers themselves (executive is its own button). "declined" marks a clear no
 * and has no options. Any other topic is refused. */
export function askChoice(topic) {
  if (!CHOICE_TOPICS.includes(topic)) {
    return { ok: false, demo: true, error: { code: 'unknown_topic', message: `Topic must be one of: ${CHOICE_TOPICS.join(', ')}.` } };
  }
  const options = topic === 'declined' ? []
    : topic === 'years' ? TIERS.map(({ id, name_en, name_ar }) => ({ id, en: name_en, ar: name_ar }))
      : DATA.choices[topic].options.map(({ id, en, ar }) => ({ id, en, ar }));
  return { ok: true, topic, options };
}

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
export function widgetsFor({ toolCalls = [], state = newWidgetState(), booked, handover, picked } = {}) {
  const next = { ...state };
  if (picked) next.slotPicked = true; // the customer's message picked an offered slot; new slots below reset it
  const ui = [];
  if (state.done) return { ui, state: next };
  // A clear no (ask_choice "declined"): nothing under the reply that turn, no picker, no slots, no contact form, and
  // the same on later turns (Alfred, 2026-10-05) until the customer asks to book again, which code sees as a quote,
  // check_availability or book call that succeeded. Then the session sells as before.
  if (toolCalls.some((c) => c.name === 'ask_choice' && c.result?.ok && c.result.topic === 'declined')) return { ui, state: { ...next, declined: true } };
  if (state.declined) {
    const again = booked || toolCalls.some((c) => c.result?.ok && ['quote', 'check_availability', 'book'].includes(c.name));
    if (!again) return { ui, state: next };
    next.declined = false;
  }
  for (const c of toolCalls) {
    if (!c.result?.ok) continue;
    if (c.name === 'ask_choice' && c.result.options?.length) {
      const old = ui.findIndex((w) => w.type === 'choices'); if (old >= 0) ui.splice(old, 1);
      ui.push({ type: 'choices', topic: c.result.topic, options: c.result.options });
    }
    if (c.name === 'recommend' && Number.isFinite(c.result.quote?.total)) {
      // The tier line shows the name only: the years range is long at 390 (Alfred, 2026-10-05).
      const r = c.result; const q = r.quote;
      ui.push({ type: 'recommend', goal: r.goal, goal_line_en: r.goal_line_en, goal_line_ar: r.goal_line_ar,
        services: r.services, why_en: r.why_en, why_ar: r.why_ar, tier: q.tier, tier_name_en: String(q.tier_name_en ?? '').split(' (')[0],
        tier_name_ar: String(q.tier_name_ar ?? '').split(' (')[0], total: q.total, currency: q.currency ?? DATA.currency, status: r.status, why_status: r.why_status });
      next.quoted = true;
    }
    if (c.name === 'quote' && Number.isFinite(c.result.total) && c.keepCard !== false) { // false: the recommendation card stands
      const old = ui.findIndex((w) => w.type === 'quote'); if (old >= 0) ui.splice(old, 1); // the latest quote wins
      ui.push(quoteCard(c.result)); next.quoted = true;
    }
    if (c.name === 'check_availability' && c.result.slots?.length) {
      const old = ui.findIndex((w) => w.type === 'slots'); if (old >= 0) ui.splice(old, 1);
      ui.push(slotChips(c.result)); next.slotsOffered = true; next.slotPicked = false;
    }
  }
  // A booking awaiting payment gets the demo pay button (built from the booking: amount, reference; no card fields).
  const unpaid = booked ?? toolCalls.findLast((c) => c.name === 'book' && c.result?.ok)?.result.booking;
  if (unpaid?.status === 'awaiting_payment' && !handover) {
    return { ui: [{ type: 'pay', reference: unpaid.reference, amount: unpaid.amount_due, currency: unpaid.currency,
      slot: unpaid.slot, hold_until: unpaid.hold_until, button_en: PAY.pay_button_en, button_ar: PAY.pay_button_ar,
      note_en: PAY.note_en, note_ar: PAY.note_ar,
      held_en: `Held until ${clock(unpaid.hold_until)} ${AV.time_name_en}`, held_ar: `محجوز حتى ${clock(unpaid.hold_until)} ${AV.time_name_ar}` }], state: { ...next, awaitingPayment: unpaid.reference, done: true } };
  }
  if (booked || handover || toolCalls.some((c) => c.result?.handover || (c.name === 'book' && c.result?.ok))) {
    return { ui: [], state: { ...next, done: true } };
  }
  const RANK = { recommend: 0, quote: 1 };
  ui.sort((a, b) => (RANK[a.type] ?? 2) - (RANK[b.type] ?? 2));
  // Any ask_choice call, even a refused topic, makes this a discovery turn: no services-and-tiers picker under a
  // question (live run 2026-10-05, turn 3, where a refused topic brought the picker back).
  const discovery = toolCalls.some((c) => c.name === 'ask_choice');
  if (!ui.length && !next.quoted && !discovery) ui.push({ type: 'details', services: SERVICES, tiers: TIERS });
  else if (!ui.length && next.slotsOffered && next.slotPicked) ui.push({ type: 'contact' }); // only after a pick
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

const BOOKING_ASK = /موعد|احجز|حجز|اختر|اختيار|book|pick|time/i;
/** The reply under a recommendation card, trimmed: sentences that state an amount go (the card carries the total),
 * and so do sentences that only restate a recommended service (not the goal sentence, not the booking ask). When
 * nothing is left, the card's goal line. Live run 2026-10-05: the model restated "السعر الإجمالي هو 550 ريال". */
export function trimRecReply(reply, card) {
  if (typeof reply !== 'string') return reply;
  const goal = [card.goal_line_en, card.goal_line_ar].map((l) => String(l ?? '').split(': ')[1]?.toLowerCase()).filter(Boolean);
  const names = (card.services ?? []).flatMap((s) => [s.name_en, s.name_ar]).filter(Boolean).map((n) => n.toLowerCase());
  const parts = reply.match(/[^.!?؟\n]+[.!?؟]*\s*/g) ?? [];
  const kept = parts.filter((p) => {
    if (statedAmounts(p).length) return false;
    const t = p.toLowerCase();
    const service = names.some((n) => t.includes(n));
    return !service || goal.some((g) => t.includes(g)) || BOOKING_ASK.test(p);
  });
  const out = kept.join('').trim();
  if (out) return out;
  return (/[؀-ۿ]/.test(reply) ? card.goal_line_ar : card.goal_line_en) + '.';
}

/** A one-line reply when trimming left nothing, in the customer's language. */
export const pickSlotLine = (arabic) => (arabic ? 'اختر موعدًا يناسبك من المواعيد أدناه.' : 'Pick a time that suits you below.');
