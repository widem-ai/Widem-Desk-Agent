// The five desk tools, defined once. The agent door (MCP) and the human door (chat) both build
// their tool lists from here, so the two doors cannot drift apart.
// Parameter types: 'string', 'number' or 'string[]'; optional: true when the caller may leave it out.
import { listServices } from './core.mjs';

export const TOOLS = [
  {
    name: 'list_services',
    title: 'List services',
    description: 'List everything this career-services studio offers (a fictional demo business): services with '
      + 'English and Arabic names, the price for each tier (junior, mid, senior, executive) in SAR, bundles and '
      + 'add-ons. Call this first, then use the ids it returns in quote.',
    params: {},
    run: () => listServices(),
  },
  {
    name: 'quote',
    title: 'Quote a price',
    description: 'Price an order for one customer. Pass the service ids from list_services, the customer tier '
      + '(junior, mid, senior or executive, by years of experience) and any add-on ids. Returns an itemised '
      + 'quote with bundle discounts applied, or a refusal with a reason code when the request is outside '
      + 'the rules. A request the rules cannot price is handed to a person automatically: the reply then '
      + 'includes a handover with what to tell the customer. Never invent a price: quote the total exactly as returned.',
    params: {
      services: { type: 'string[]', describe: 'Service ids, e.g. ["cv_rewrite", "linkedin_profile"]' },
      tier: { type: 'string', describe: 'junior | mid | senior | executive' },
      addons: { type: 'string[]', optional: true, describe: 'Add-on ids, e.g. ["express"]' },
    },
    run: (desk, args, ctx) => desk.quote(args, ctx),
  },
  {
    name: 'check_availability',
    title: 'Check free slots',
    description: 'List free 60-minute kickoff-call slots, in Asia/Riyadh time (UTC+3). Optionally pass from '
      + '(YYYY-MM-DD, default today in Riyadh) and days (1 to 7, default 7). Each slot has a start and end with '
      + 'the offset included; pass a start to book exactly as returned.',
    params: {
      from: { type: 'string', optional: true, describe: 'First date to check, YYYY-MM-DD in Riyadh time' },
      days: { type: 'number', optional: true, describe: 'How many days to check, 1 to 7' },
    },
    run: (desk, args) => desk.checkAvailability(args),
  },
  {
    name: 'book',
    title: 'Book a kickoff call',
    description: 'Book one customer into a free slot from check_availability. Pass the same services, tier and '
      + 'add-ons you quoted, the slot start exactly as returned, and the customer name and a contact (email or '
      + 'phone). The order is priced again by the same rules and the price is stored with the booking. Returns '
      + 'a booking reference, or a refusal with a reason code (slot_taken: pick another free slot).',
    params: {
      services: { type: 'string[]', describe: 'Service ids from list_services' },
      tier: { type: 'string', describe: 'junior | mid | senior | executive' },
      addons: { type: 'string[]', optional: true, describe: 'Add-on ids, e.g. ["express"]' },
      slot: { type: 'string', describe: 'A slot start from check_availability, e.g. "2026-10-05T11:00:00+03:00"' },
      customer_name: { type: 'string', describe: "The customer's name" },
      contact: { type: 'string', describe: 'Email or phone number for the customer' },
    },
    run: (desk, args, ctx) => desk.book(args, ctx),
  },
  {
    name: 'handover',
    title: 'Hand over to a person',
    description: 'Pass the customer to a person at the business. Use it when the customer asks for a person '
      + '(reason talk_to_a_person) or wants anything the rules do not cover, such as a discount, a complaint or '
      + 'an unusual case (reason out_of_rules). Returns what to tell the customer, in English and Arabic.',
    params: {
      reason: { type: 'string', describe: 'talk_to_a_person | out_of_rules' },
      summary: { type: 'string', optional: true, describe: 'One or two sentences on what the customer wants' },
      customer_name: { type: 'string', optional: true, describe: "The customer's name, if known" },
      contact: { type: 'string', optional: true, describe: 'Email or phone number, if known' },
    },
    run: (desk, args, ctx) => desk.handover(args, ctx),
  },
];

/** A tool's parameters as JSON Schema (for OpenAI-compatible tool calling). */
export function toJsonSchema(params) {
  const properties = {};
  for (const [key, p] of Object.entries(params)) {
    properties[key] = p.type === 'string[]'
      ? { type: 'array', items: { type: 'string' }, description: p.describe }
      : { type: p.type, description: p.describe };
  }
  const required = Object.keys(params).filter((key) => !params[key].optional);
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/** A tool's parameters as a zod shape (for the MCP SDK). */
export function toZodShape(params, z) {
  const shape = {};
  for (const [key, p] of Object.entries(params)) {
    let s = p.type === 'string[]' ? z.array(z.string()) : p.type === 'number' ? z.number() : z.string();
    if (p.optional) s = s.optional();
    shape[key] = s.describe(p.describe);
  }
  return shape;
}

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  'string[]': (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
};

/** Check arguments against a tool's parameters: a plain object, no unknown fields, required present, right types.
 * Returns null when they are valid, or a short message naming the first problem. */
export function checkArgs(params, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Arguments must be a JSON object.';
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(params, key)) return `Unknown field: ${key}.`;
  }
  for (const [key, p] of Object.entries(params)) {
    if (args[key] === undefined) {
      if (!p.optional) return `Missing field: ${key}.`;
    } else if (!TYPE_CHECKS[p.type](args[key])) {
      return `Field ${key} must be ${p.type === 'string[]' ? 'a list of strings' : `a ${p.type}`}.`;
    }
  }
  return null;
}
