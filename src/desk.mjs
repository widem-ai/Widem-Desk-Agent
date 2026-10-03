// The stateful half of the core: availability, booking and handover over a store (src/store.mjs).
// Every door calls these and nothing else. The clock is injected so the rules stay testable;
// all times are computed in the business's timezone from the rules file, never the server's.
import { quote as priceOrder, tierFor, RULES } from './core.mjs';

const AV = RULES.availability;
const HO = RULES.handover;
const DOORS = ['human', 'agent'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_MS = 86_400_000;
const SLOT_MS = AV.slot_minutes * 60_000;
// A slot must carry its offset (Z or +03:00); "11:00" alone would be read in the server's own timezone.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function refuse(code, message) {
  return { ok: false, demo: true, error: { code, message } };
}

const cap = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

// --- time in the business's timezone -------------------------------------------------------
const dateFmt = new Intl.DateTimeFormat('en-CA',
  { timeZone: AV.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const offFmt = new Intl.DateTimeFormat('en-US', { timeZone: AV.timezone, timeZoneName: 'longOffset' });

/** Minutes east of UTC in the business timezone at instant ms (copes with DST if a zone has it). */
function offsetMinutes(ms) {
  const name = offFmt.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName').value; // "GMT+03:00"
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}
const localDate = (ms) => dateFmt.format(new Date(ms)); // YYYY-MM-DD in the business timezone

function zonedToMs(date, hhmm) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetMinutes(guess) * 60_000;
  return guess - offsetMinutes(first) * 60_000;
}

function formatLocal(ms) {
  const off = offsetMinutes(ms);
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${new Date(ms + off * 60_000).toISOString().slice(0, 19)}${off < 0 ? '-' : '+'}${hh}:${mm}`;
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === s;
}
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}
const weekday = (date) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];

/** Every slot start the opening hours allow on one local date, before bookings, clock or window. */
function slotsOn(date) {
  if (AV.blocked_dates.includes(date)) return [];
  const out = [];
  for (const [open, close] of AV.weekly_hours[weekday(date)] ?? []) {
    const end = zonedToMs(date, close);
    for (let t = zonedToMs(date, open); t + SLOT_MS <= end; t += SLOT_MS) out.push(t);
  }
  return out;
}

// --- the desk ----------------------------------------------------------------------------------
export function createDesk({ store, now = () => new Date() }) {
  if (!store) throw new Error('createDesk needs a store');
  const nowMs = () => now().getTime();

  function door(ctx) {
    if (!DOORS.includes(ctx?.door)) throw new Error(`desk: door must be one of ${DOORS.join(', ')}`);
    return ctx.door;
  }

  const takenStarts = () => new Set(store.all('bookings').filter((b) => b.status === 'booked')
    .map((b) => Date.parse(b.slot.start)));

  /** Is instant t a bookable slot now: on the grid, open, not started, inside the booking window? */
  function bookable(t, current) {
    const date = localDate(t);
    if (date > addDays(localDate(current), AV.booking_window_days)) return false;
    return t > current && slotsOn(date).includes(t);
  }

  function recordHandover(input, ctx, extra = {}) {
    const d = door(ctx);
    const given = cap(input?.reason, 80);
    const reason = HO.reasons.includes(given) ? given : HO.default_reason;
    const record = {
      id: `HO-${String(store.all('handovers').length + 1).padStart(4, '0')}`,
      created_at: new Date(nowMs()).toISOString(),
      door: d,
      reason,
      ...(given && given !== reason ? { reason_given: given } : {}),
      summary: cap(input?.summary, 2000),
      customer_name: cap(input?.customer_name, 120),
      contact: cap(input?.contact, 200),
      ...(cap(input?.transcript, 20_000) ? { transcript: cap(input.transcript, 20_000) } : {}),
      status: 'open',
      ...extra,
    };
    store.add('handovers', record);
    return { id: record.id, reason, tell_customer_en: HO.tell_customer_en, tell_customer_ar: HO.tell_customer_ar };
  }

  /** Price an order from what the customer said: the tier is worked out here, never taken as given. */
  function priceFromFacts(input) {
    const tier = tierFor(input ?? {});
    if (!tier) {
      return refuse('needs_experience', 'Ask the customer how many years of work experience they have, and whether '
        + 'they are an executive, director or general manager.');
    }
    return priceOrder({ ...input, tier });
  }

  /** A refusal the rules cannot price goes to a person automatically: decided here in code, not by a model. */
  function withAutoHandover(refusal, input, ctx) {
    if (!HO.refusal_codes.includes(refusal.error.code)) return refusal;
    const strs = (a) => (Array.isArray(a) ? a.slice(0, 20).map((x) => String(x).slice(0, 80)) : []);
    const handover = recordHandover({ ...input, reason: refusal.error.code, summary: refusal.error.message }, ctx, {
      request: { services: strs(input?.services), years_experience: Number.isFinite(input?.years_experience) ? input.years_experience : null,
        is_executive: input?.is_executive === true, addons: strs(input?.addons) },
    });
    return { ...refusal, handover };
  }

  return {
    /** Free slots. input: { from?: 'YYYY-MM-DD' in the business timezone (default today), days?: 1..7 (default 7) }. */
    checkAvailability(input) {
      const current = nowMs();
      const from = input?.from ?? localDate(current);
      if (!isDate(from)) return refuse('invalid_date', 'from must be a real date written YYYY-MM-DD.');
      const days = input?.days ?? AV.max_days_per_check;
      if (!Number.isInteger(days) || days < 1 || days > AV.max_days_per_check) {
        return refuse('invalid_range', `days must be a whole number from 1 to ${AV.max_days_per_check}.`);
      }
      const taken = takenStarts();
      const slots = [];
      for (let i = 0; i < days; i += 1) {
        for (const t of slotsOn(addDays(from, i))) {
          if (bookable(t, current) && !taken.has(t)) slots.push({ start: formatLocal(t), end: formatLocal(t + SLOT_MS) });
        }
      }
      return { ok: true, demo: true, timezone: AV.timezone, slot_minutes: AV.slot_minutes, from, days, slots };
    },

    /** The slice 1 quote; a refusal the rules cannot price is handed over automatically. */
    quote(input, ctx) {
      door(ctx);
      const q = priceFromFacts(input);
      return q.ok ? q : withAutoHandover(q, input, ctx);
    },

    /**
     * Book a kickoff call. input: { services, years_experience, is_executive?, addons?, slot, customer_name, contact, transcript? }.
     * Checks the details, prices the order with the same quote, then checks the slot is open and free.
     */
    book(input, ctx) {
      const d = door(ctx);
      const missing = ['customer_name', 'contact', 'slot'].filter((k) => !cap(input?.[k], 10_000));
      if (missing.length) return refuse('incomplete', `Missing: ${missing.join(', ')}.`);

      const q = priceFromFacts(input);
      if (!q.ok) return withAutoHandover(q, input, ctx);

      const slot = input.slot.trim();
      if (!INSTANT.test(slot) || Number.isNaN(Date.parse(slot))) {
        return refuse('invalid_slot', 'slot must be a start time exactly as check_availability returns it.');
      }
      const t = Date.parse(slot);
      const current = nowMs();
      if (!bookable(t, current)) {
        return refuse('slot_unavailable', 'That time is not an open slot. Call check_availability for free slots.');
      }
      // The check and the add run in one synchronous step, so two requests cannot both pass the check.
      if (takenStarts().has(t)) return refuse('slot_taken', 'That slot is already booked. Pick another free slot.');

      const booking = {
        reference: `BK-${String(store.all('bookings').length + 1).padStart(4, '0')}`,
        created_at: new Date(current).toISOString(),
        door: d,
        customer_name: cap(input.customer_name, 120),
        contact: cap(input.contact, 200),
        services: q.lines.map((l) => l.service),
        tier: q.tier,
        addons: q.addons.map((a) => a.id),
        price_quoted: q.total,
        currency: q.currency,
        quote: q,
        slot: { start: formatLocal(t), end: formatLocal(t + SLOT_MS) },
        status: 'booked',
        transcript: cap(input.transcript, 20_000),
      };
      store.add('bookings', booking);
      return { ok: true, demo: true, booking };
    },

    /** Hand the conversation to a person. input: { reason?, summary?, customer_name?, contact? }. */
    handover(input, ctx) {
      return { ok: true, demo: true, handover: recordHandover(input, ctx) };
    },
  };
}
