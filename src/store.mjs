// Storage behind the smallest interface the desk needs: all(kind) and add(kind, record).
// Kinds are 'bookings' and 'handovers'. Both stores are synchronous on purpose: in one Node process
// a check-then-add inside desk.book cannot interleave with another request, so a slot cannot be taken twice.
// Swapping in a hosted database later means keeping that guarantee (a unique constraint on the slot).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const KINDS = ['bookings', 'handovers'];
const copy = (o) => JSON.parse(JSON.stringify(o));
const empty = () => ({ bookings: [], handovers: [] });

function checkKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`store: unknown kind "${kind}"`);
}

/** In-memory store: for tests and throwaway runs. Gone when the process ends. */
export function createMemoryStore() {
  const state = empty();
  return {
    all(kind) { checkKind(kind); return copy(state[kind]); },
    add(kind, record) { checkKind(kind); state[kind].push(copy(record)); },
  };
}

/** File store: one JSON file, rewritten whole on every add (write to a temp file, then rename). */
export function createFileStore(file) {
  let state = empty();
  if (existsSync(file)) {
    try {
      state = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`store: ${file} is not valid JSON; fix or move it rather than start empty (${err.message})`);
    }
    for (const k of KINDS) {
      if (!Array.isArray(state[k])) throw new Error(`store: ${file} has no "${k}" list`);
    }
  }
  return {
    all(kind) { checkKind(kind); return copy(state[kind]); },
    add(kind, record) {
      checkKind(kind);
      const next = { ...state, [kind]: [...state[kind], copy(record)] };
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(tmp, file);
      state = next; // only after the write succeeded
    },
  };
}
