// Display labels for people, per language, so a reply never needs an id or a raw timestamp.
// Dates use the Gregorian calendar and Western digits in both languages; times are read straight from
// the slot (it already carries the business's offset), so the label always matches what is booked.

const dateIn = (locale, timeZone, iso) =>
  new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone }).format(new Date(iso));

/** Labels for a slot, e.g. "Tuesday 6 October, 10:00 to 11:00 Riyadh time" and the Arabic equivalent.
 * av is the availability block of the data file (timezone, time_name_en, time_name_ar). */
export function slotLabels(start, end, av) {
  const from = start.slice(11, 16);
  const to = end.slice(11, 16);
  return {
    label_en: `${dateIn('en-GB', av.timezone, start)}, ${from} to ${to} ${av.time_name_en}`,
    label_ar: `${dateIn('ar-u-ca-gregory-nu-latn', av.timezone, start)}، ${from} إلى ${to} ${av.time_name_ar}`,
  };
}
