// A measure, not a filter: the Latin-letter words in an Arabic reply other than the ones a customer
// expects to see in Latin (LinkedIn, CV, SAR, booking references, email addresses). Used by tests and
// the live check to count how much English leaks into Arabic replies.
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
