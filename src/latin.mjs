import { readFileSync } from 'node:fs';

// A measure, not a filter: the Latin-letter words in an Arabic reply other than the ones a customer
// expects to see in Latin (LinkedIn, CV, SAR, booking references, email addresses). Used by tests and
// the live check to count how much English leaks into Arabic replies. arabicWords below fixes the known slips first.
const ARABIC = /[؀-ۿ]/;
const ALLOWED = new Set(['linkedin', 'cv', 'sar']);
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const REFERENCE = /\b(?:BK|HO)-\d{4}\b/g;

/** Latin words in an Arabic reply that are not on the allowed list, once each, in order. [] for a non-Arabic reply. */
export function latinWords(reply) {
  const text = String(reply ?? '');
  if (!ARABIC.test(text)) return [];
  const found = [];
  for (const [word] of text.replace(EMAIL, ' ').replace(REFERENCE, ' ').matchAll(/[A-Za-z][A-Za-z_]*/g)) {
    if (!ALLOWED.has(word.toLowerCase()) && !found.includes(word)) found.push(word);
  }
  return found;
}

// Known Latin slips with a safe Arabic equivalent: the call's name, the booking reference, and the service and
// add-on ids (their Arabic names from the data file, without the bracketed detail). Tier ids (junior, senior...)
// are left out: as words they are ordinary adjectives, so no replacement is safe; they stay and are still flagged.
const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const short = (name) => name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
const SLIPS = [
  [/مكالمة\s+(?:ال)?kick-?off(?:\s+call)?\b/gi, DATA.availability.call_name_ar],
  [/\bkick-?off\s+call\b/gi, DATA.availability.call_name_ar],
  [/\bkick-?off\b/gi, 'البداية'],
  [/\breferen(?:ce|cia)\b/gi, 'المرجع'],
  ...[...DATA.services, ...DATA.addons].map(({ id, name_ar }) => [new RegExp(`\\b${id}\\b`, 'gi'), short(name_ar)]),
];

/** An Arabic reply with the known Latin slips replaced by their Arabic words. Any other Latin word stays (latinWords
 * still reports it). A non-Arabic reply comes back unchanged. */
export function arabicWords(reply) {
  if (typeof reply !== 'string' || !ARABIC.test(reply)) return reply;
  return SLIPS.reduce((text, [pattern, arabic]) => text.replace(pattern, arabic), reply);
}
