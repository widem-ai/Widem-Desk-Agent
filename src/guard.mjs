// The invented-number guard: before a reply reaches the customer, every SAR amount and every clock
// time in it must be a value some desk tool returned (in this turn or earlier in the session).
// Harmless numbers (years of experience, "60-minute call", a year) are not amounts or times and pass.

export const toWestern = (text) => text
  .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
  .replace(/٫/g, '.') // Arabic decimal separator
  .replace(/(\d)[,٬](?=\d{3}(?!\d))/g, '$1'); // thousands separators

const CURRENCY = '(?:SAR|SR|\\u0631\\.\\u0633|\\u0631\\u064A\\u0627\\u0644)'; // SAR, SR, ر.س, ريال
const AMOUNT_AFTER = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${CURRENCY}`, 'gi');
const AMOUNT_BEFORE = new RegExp(`${CURRENCY}\\s*(\\d+(?:\\.\\d+)?)`, 'gi');
const PM = /^(?:pm|p\.m\.|م|مساء|مساءً)$/i;
const AM = /^(?:am|a\.m\.|ص|صباحا|صباحًا)$/i;
const MERIDIEM = '(am|pm|a\\.m\\.|p\\.m\\.|صباحًا|صباحا|مساءً|مساء|ص|م)';
const CLOCK = new RegExp(`(\\d{1,2}):(\\d{2})(?:\\s*${MERIDIEM}(?![a-z\\u0621-\\u064A]))?`, 'gi');
const HOUR_ONLY = new RegExp(`(?<![\\d:])(\\d{1,2})\\s*${MERIDIEM}(?![a-z\\u0621-\\u064A])`, 'gi');

const pad = (h, m) => `${String(h).padStart(2, '0')}:${m}`;

/** Every number and every HH:MM time found anywhere in the tool results. */
function groundedValues(results) {
  const numbers = new Set();
  const times = new Set();
  const walk = (v) => {
    if (typeof v === 'number') numbers.add(v);
    else if (typeof v === 'string') for (const m of v.matchAll(/T(\d{2}):(\d{2})/g)) times.add(`${m[1]}:${m[2]}`);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(results);
  return { numbers, times };
}

/** The 24-hour readings of a stated time: one when am or pm is given, otherwise both. */
function readings(h, m, meridiem) {
  if (meridiem && PM.test(meridiem)) return [pad(h < 12 ? h + 12 : h, m)];
  if (meridiem && AM.test(meridiem)) return [pad(h === 12 ? 0 : h, m)];
  return h < 12 ? [pad(h, m), pad(h + 12, m)] : [pad(h, m)];
}

/**
 * The amounts and times in a reply that no tool result contains, e.g. ['999 SAR', '09:30'].
 * An empty list means the reply may go out as it is.
 */
export function ungrounded(reply, toolResults) {
  const text = toWestern(String(reply ?? ''));
  const { numbers, times } = groundedValues(toolResults);
  const found = [];
  for (const re of [AMOUNT_AFTER, AMOUNT_BEFORE]) {
    for (const m of text.matchAll(re)) {
      const claim = `${Number(m[1])} SAR`;
      if (!numbers.has(Number(m[1])) && !found.includes(claim)) found.push(claim);
    }
  }
  const checkTime = (h, m, meridiem) => {
    if (h > 23) return;
    const options = readings(h, m, meridiem);
    if (!options.some((t) => times.has(t))) {
      const claim = options.length === 1 ? options[0] : pad(h, m);
      if (!found.includes(claim)) found.push(claim);
    }
  };
  for (const m of text.matchAll(CLOCK)) checkTime(Number(m[1]), m[2], m[3]);
  for (const m of text.matchAll(HOUR_ONLY)) checkTime(Number(m[1]), '00', m[2]);
  return found;
}

/** The SAR amounts a reply states, as numbers, in order of the patterns. */
export function statedAmounts(reply) {
  const text = toWestern(String(reply ?? ''));
  return [AMOUNT_AFTER, AMOUNT_BEFORE].flatMap((re) => [...text.matchAll(re)].map((m) => Number(m[1])));
}

// Darb takes payment at booking (2026-10-05), so the desk never says the call is free or that nothing is due now.
// Free *times* are fine ("pick a free time"); a free call, booking for free or paying later are not.
const PAYMENT_CLAIMS = [
  /\bfree of charge\b|\bfor free\b|\bat no cost\b|\bno charge\b|\bfree (?:kickoff |intro |consultation )?call\b/gi,
  /\b(?:call|consultation|booking|session|kickoff)\s+(?:is|are)\s+free\b/gi,
  /\bno payment\b|\bpay later\b|\bwithout pay(?:ing|ment)\b|\bnothing to pay\b|\b(?:don't|do not) (?:need|have) to pay\b/gi,
  /مجان\S*|(?:بدون|بلا|دون)\s+(?:أي\s+)?(?:دفع|رسوم|تكلفة|مقابل)|(?:الدفع|ادفع|تدفع)\s+لاحق\S*|لا\s+(?:حاجة|داعي)\s+(?:لل|إلى\s+ال)دفع/g,
];

/** The phrases in a reply that say the call is free or that no payment is due now, in order. [] when there are none. */
export function paymentClaims(reply) {
  const text = String(reply ?? '');
  return PAYMENT_CLAIMS.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
}
