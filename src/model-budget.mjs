// A daily cap on model calls across everyone, to protect the Token Factory credit (USD 25 until 15 Dec).
// The day is the Riyadh day (UTC+3, no daylight saving). The count is kept in a small JSON file, written
// atomically on every call, so a restart does not refill the day. Calls past the cap never reach the model.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_MODEL_CALLS_PER_DAY = 150;
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

/** What both chat replies say once the day is spent. */
export const RESTING = {
  en: 'The demo is resting until tomorrow (Riyadh time). Please come back then.',
  ar: 'العرض التجريبي في استراحة حتى الغد بتوقيت الرياض. يرجى العودة غدًا.',
};

export const riyadhDay = (ms) => new Date(ms + RIYADH_OFFSET_MS).toISOString().slice(0, 10);

/** Seconds from ms until the next Riyadh midnight, for a retry-after header. */
export const secondsToRiyadhMidnight = (ms) => {
  const local = ms + RIYADH_OFFSET_MS;
  return Math.max(1, Math.ceil((86_400_000 - (local % 86_400_000)) / 1000));
};

function readCount(file) {
  if (!file || !existsSync(file)) return { day: null, calls: 0 };
  try {
    const { day, calls } = JSON.parse(readFileSync(file, 'utf8'));
    return { day: typeof day === 'string' ? day : null, calls: Number.isInteger(calls) && calls >= 0 ? calls : 0 };
  } catch {
    return { day: null, calls: 0 }; // an unreadable counter starts the day fresh rather than stop the server
  }
}

/** Wrap a model ({ complete }) so at most perDay calls a Riyadh day reach it. file: where the count is kept
 * (none = memory only). exhausted() says whether the day is spent; complete() past the cap throws code daily_limit. */
export function limitModelCalls(model, { perDay = DEFAULT_MODEL_CALLS_PER_DAY, file, now = Date.now } = {}) {
  let count = readCount(file);
  const today = () => {
    const day = riyadhDay(now());
    if (count.day !== day) count = { day, calls: 0 };
    return count;
  };
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(count)}\n`);
    renameSync(`${file}.tmp`, file);
  };
  return {
    exhausted: () => today().calls >= perDay,
    secondsLeft: () => secondsToRiyadhMidnight(now()),
    async complete(args) {
      const c = today();
      if (c.calls >= perDay) {
        throw Object.assign(new Error(`model: daily cap of ${perDay} calls reached`), { code: 'daily_limit' });
      }
      c.calls += 1;
      save(); // counted before the call: a call that fails still spent its place
      return model.complete(args);
    },
  };
}
