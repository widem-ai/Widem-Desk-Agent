// The human door's brain: a chat loop where the model talks to a customer and calls the same desk
// tools as the agent door, in-process. Every tool result comes from the desk, never from the model.
import { readFileSync } from 'node:fs';
import { toolsFor, checkArgs, toJsonSchema } from './tools.mjs';

const TOOLS = toolsFor('human'); // never the agent-only pay tool: people pay with the button
import { toWestern, ungrounded, paymentClaims, statedAmounts } from './guard.mjs';
import { slotLabels } from './labels.mjs';
import { latinWords, arabicWords } from './latin.mjs';
import { pendingRecommendation, quoteArgsFor, REC_CALL_PREFIX, namesService } from './recommend.mjs';

const HUMAN = { door: 'human' };
const DATA = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8'));
const HO = DATA.handover;
// Handover reasons that share one acknowledgement line.
const ACK_KEY = { unknown_tier: 'unknown_service', unknown_addon: 'unknown_service', addon_not_applicable: 'unknown_service',
  hidden_instructions: 'guarded' };

/** What the customer is told on a handover (Mohannad, 2026-10-05, choice 2 = a): one acknowledgement line chosen in
 * code from the reason, then the fixed line. Never the model's text. */
export function handoverReply(reason, arabic) {
  const ack = HO.acknowledge[ACK_KEY[reason] ?? reason] ?? HO.acknowledge.out_of_rules;
  return arabic ? `${ack.ar} ${HO.tell_customer_ar}` : `${ack.en} ${HO.tell_customer_en}`;
}
const AV = DATA.availability;
export const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const ARABIC = /[؀-ۿ]/;
const KEEPS_TRANSCRIPT = new Set(['quote', 'book', 'handover']); // quote: a refusal it hands over keeps the chat
// Messages the customer never saw (a reply the guard stopped, the desk's correction): kept out of history and transcripts.
const HIDDEN = new WeakSet();

export const SYSTEM_PROMPT = [
  'You are the front desk of a career-services studio (a fictional demo business). You help one customer',
  'choose services, get a price and book a 60-minute kickoff call.',
  'Rules you never break:',
  '1. Never state a price, a discount or a total yourself. Call quote and repeat the total exactly as it returned.',
  '2. Never state a free time yourself. Call check_availability. The page shows the slots it returned as buttons under',
  'your reply, so do not list them: say in one short line that the customer can pick a time below. Book with book',
  'and repeat the booking reference exactly as it returned.',
  '3. Anything the tools do not cover (a discount, a complaint, a request outside the rules, or a customer who',
  'asks for a person) goes to handover. Then tell the customer what handover returned.',
  '4. Reply in the language the customer writes in: Arabic or English. In Arabic, use the Arabic names and labels the',
  'tools return (name_ar, tier_name_ar, label_ar, call_name_ar), never ids. Keep replies short.',
  '5. Show the free slots first. Ask for the customer name and a contact (email or phone) after that, before booking.',
  '6. Keep each reply to four short sentences at most, with exactly one ask. The page shows quotes, times and answer',
  'buttons under your reply, so do not recite them. Sell in stages:',
  'a. If the customer names the services and their years, call quote at once: no questions first.',
  'b. If they are exploring, ask one goal question and call ask_choice with topic goal, so the page shows answer buttons.',
  'c. Ask at most two discovery replies: goal, why, timeline (call ask_choice with topic timeline), years and seniority (call ask_choice with topic years).',
  'Never ask about budget, and never ask for a name or contact before the customer picks a time.',
  'd. Then say their goal back in one sentence in their own words, and recommend one option from the fit rules below.',
  'Call quote for it and state the total once, as returned. The value comes only from the service description.',
  'When the desk has already quoted the recommendation (a quote call with an id starting desk_rec), the page shows it as a',
  'card with their goal, the services, why it fits and the total. Then say their goal back in one short sentence, ask for',
  'the booking and call check_availability; do not list the services or prices again.',
  'e. From the quote on, every reply ends with the booking ask: call check_availability and point to the times below.',
  'f. Soft objections (too expensive, let me think, not now): at most two loops in the whole chat. Acknowledge, raise',
  'one certainty from the rules or lower the ask (start with one service, or a later time), then ask again. After the',
  'second loop, close politely with no ask. A discount request is a handover, not a loop.',
  'g. A clear no: call ask_choice with topic declined, reply with one polite line, and ask nothing. Do not sell again',
  'unless the customer asks to book.',
  'h. A question about packages or offers is not a handover: answer with the career pack rule from list_services if it',
  'fits their goal, then ask one goal question.',
  'Never invent urgency, results, reviews or discounts, and never promise a job or an outcome.',
  `Fit rules (default mapping, one recommendation per customer):\n${DATA.fit.rules.map((r) => `- ${r.when}: ${r.recommend}`).join('\n')}`,
  '7. Payment is taken at booking. A booking is held until it is paid: after book, point the customer to the pay button below.',
  'Never say the customer is booked or confirmed before the payment, and never say the call is free or that nothing is due now.',
].join('\n');

/** Tool schemas for an OpenAI-compatible chat completions call, built from the shared definitions. */
export const CHAT_TOOLS = TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: toJsonSchema(t.params) },
}));

// DESK_LANG (Mohannad, 2026-10-06): "en" (the server's default) replies in English whatever the customer writes;
// "ar" is the bilingual desk, kept as a draft for an Arab audience. Only the language rule of the prompt differs.
const AR_RULE = /4\. Reply in the language the customer writes in: Arabic or English\. In Arabic, use the Arabic names and labels the\s+tools return \(name_ar, tier_name_ar, label_ar, call_name_ar\), never ids\./;
const EN_RULE = '4. Always reply in English, even when the customer writes in Arabic or another language. Use the English names and '
  + 'labels the tools return (name_en, tier_name_en, label_en, call_name_en), never ids.';
if (!AR_RULE.test(SYSTEM_PROMPT)) throw new Error('chat.mjs: the language rule of SYSTEM_PROMPT changed; update AR_RULE');
const PROMPTS = { ar: SYSTEM_PROMPT, en: SYSTEM_PROMPT.replace(AR_RULE, EN_RULE) };
/** The system prompt for a desk language: "ar" is the bilingual prompt, anything else the English-only one. */
export const promptFor = (lang) => PROMPTS[lang === 'ar' ? 'ar' : 'en'];
/** The desk language from the environment: DESK_LANG=ar keeps the bilingual desk; unset or anything else is "en". */
export const langFromEnv = (env = process.env) => (env.DESK_LANG === 'ar' ? 'ar' : 'en');

/** What to tell the customer when the model cannot answer (timeout or error): in Arabic only on the bilingual desk. */
export const sorryReply = (text, lang = 'ar') => (lang === 'ar' && ARABIC.test(text ?? '')
  ? 'عذرًا، لم أتمكن من الرد الآن. حاول مرة أخرى بعد قليل.'
  : 'Sorry, I could not answer just now. Please try again in a moment.');

/** The conversation as plain text for the owner page: customer and desk lines only, no tool traffic. */
export const transcriptOf = (messages) => messages
  .filter((m) => !HIDDEN.has(m) && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
  .map((m) => `${m.role === 'user' ? 'Customer' : 'Desk'}: ${m.content.trim()}`)
  .join('\n');

/** Plain characters for the customer: a dash between two numbers or times becomes "to" (or "إلى"), any other
 * spaced dash a comma, and any remaining dash or non-breaking hyphen a plain hyphen. */
export function plainDashes(text) {
  if (typeof text !== 'string') return text;
  const to = ARABIC.test(text) ? ' إلى ' : ' to ';
  return text
    .replace(/(\d)\s*[\u2012-\u2015]\s*(?=\d)/g, `$1${to}`)
    .replace(/\s+[\u2012-\u2015]\s+/g, ', ')
    .replace(/[\u2010-\u2015]/g, '-');
}

/** Plain text for a chat bubble: no markdown emphasis, headings, bullet markers or code ticks, which the customer
 * would see as symbols. Numbered steps, hyphens inside a line, references and emails stay. */
export function plainMarkdown(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*+•][ \t]+/gm, '')
    .replace(/\*+|`/g, '')
    .replace(/__(.+?)__/g, '$1')
    .replace(/[ \t]+$/gm, '');
}

/** Arabic punctuation in an Arabic reply: the Arabic comma (not between digits, where it groups thousands), a
 * hyphen range of numbers or times ("3-8", "10:00-11:00") said with "إلى", and SAR as "ريال". Dates and references stay. */
export function arabicPunctuation(text) {
  if (typeof text !== 'string' || !ARABIC.test(text)) return text;
  return text
    .replace(/\bSAR\b/g, 'ريال')
    .replace(/(?<![\d-])(\d{1,2}(?::\d{2})?)\s*-\s*(\d{1,2}(?::\d{2})?)(?![\d-])/g, '$1 إلى $2')
    .replace(/,/g, (comma, i, s) => (/\d/.test(s[i - 1] ?? '') && /\d/.test(s[i + 1] ?? '') ? comma : '،'));
}

/** Make sure a reply states the quoted total, taken from the quote result, not the model's text. Used after a
 * reply was held back for slots first, so the price it carried is not lost. */
export function withQuotedTotal(reply, total, arabic) {
  if (toWestern(reply).includes(String(total))) return reply;
  return `${arabic ? `السعر الإجمالي: ${total} ريال.` : `Total: ${total} SAR.`}\n\n${reply.replace(/^\s+/, '')}`;
}

// A reply that asks the customer for their name and a contact (both), in Arabic or English.
const ASKS_NAME = /اسمك|اسم حضرتك|your (?:full )?name/i;
const ASKS_CONTACT = /بريد|هاتف|جوال|تواصل|e-?mail|phone|contact/i;

/** True when a reply asks for name and contact while no free slots have been shown in this conversation. */
export function asksForContactFirst(reply, messages) {
  if (typeof reply !== 'string' || !ASKS_NAME.test(reply) || !ASKS_CONTACT.test(reply)) return false;
  return !messages.some((m) => m.tool_calls?.some((c) => c.function?.name === 'check_availability'));
}

/** True when a reply asks for name and contact while the newest slots came after the customer's last message:
 * the slots are on screen but the customer has not picked one yet (playbook guardrail 10). A reply with no slots
 * shown at all is asksForContactFirst's case, not this one. */
export function asksForContactBeforePick(reply, messages) {
  if (typeof reply !== 'string' || !ASKS_NAME.test(reply) || !ASKS_CONTACT.test(reply)) return false;
  const lastCustomer = messages.findLastIndex((m) => m.role === 'user' && !HIDDEN.has(m));
  const lastOffer = messages.findLastIndex((m) => m.tool_calls?.some((c) => c.function?.name === 'check_availability'));
  if (lastOffer <= lastCustomer) return false;
  // A customer who already named one of the offered times ("Tuesday 10:00 please") has picked.
  return !namesOfferedTime(messages, lastOffer, lastCustomer);
}

/** True when the customer message at customerIndex names a start time of the slots offered at offerIndex. */
function namesOfferedTime(messages, offerIndex, customerIndex) {
  const ids = new Set(messages[offerIndex].tool_calls.map((c) => c.id));
  const slots = messages.filter((m) => m.role === 'tool' && ids.has(m.tool_call_id))
    .flatMap((m) => { try { return JSON.parse(m.content).slots ?? []; } catch { return []; } });
  const said = toWestern(String(messages[customerIndex]?.content ?? ''));
  return slots.some((s) => [s.start.slice(11, 16), s.start.slice(11, 16).replace(/^0/, '')]
    .some((t) => new RegExp(`(?<![\\d:])${t}(?![\\d])`).test(said)));
}

/** True when the customer's latest message picks one of the slots offered before it (the page's chip message,
 * or a typed time). The contact form waits for this (live run 2026-10-05: it showed under a loop reply). */
export function pickedOfferedSlot(messages) {
  const lastCustomer = messages.findLastIndex((m) => m.role === 'user' && !HIDDEN.has(m));
  const lastOffer = messages.findLastIndex((m, i) => i < lastCustomer && m.tool_calls?.some((c) => c.function?.name === 'check_availability'));
  return lastOffer >= 0 && namesOfferedTime(messages, lastOffer, lastCustomer);
}

/** The latest successful result of a tool in this conversation, or undefined. */
function latestResult(messages, name) {
  const ids = new Set(messages.flatMap((m) => (m.tool_calls ?? []).filter((c) => c.function?.name === name).map((c) => c.id)));
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== 'tool' || !ids.has(messages[i].tool_call_id)) continue;
    try { const r = JSON.parse(messages[i].content); if (r.ok) return r; } catch { /* not JSON */ }
  }
  return undefined;
}

/** SAR amounts a reply states that are not the latest quote's total or discount, nor the booking's amount. The guard
 * accepts any amount a tool returned in the session, so an old line price said as a new total passed it
 * (live run 2026-10-05: 550, the CV line of a 950 quote, with no quote call for the CV alone). */
export function staleTotals(reply, messages, pinned) {
  const q = pinned ?? latestResult(messages, 'quote'); // pinned: the recommendation card's quote this turn
  const b = latestResult(messages, 'book')?.booking;
  const allowed = new Set([q?.total, q?.discount, b?.amount_due, b?.price_quoted].filter(Number.isFinite));
  return statedAmounts(reply).filter((n) => !allowed.has(n));
}

/** The reply after book, built in code: the slot is held until payment and the pay button is below. The model's own
 * line said "تم حجز" (booked) before payment in the live run, which prompt rule 7 forbids. */
export function heldLine(booking, arabic) {
  const { label_en, label_ar } = slotLabels(booking.slot.start, booking.slot.end, AV);
  return arabic
    ? `الموعد ${label_ar} محجوز لك مؤقتًا حتى الدفع. المبلغ ${booking.amount_due} ريال، والمرجع ${booking.reference}. ادفع بالزر أدناه لتأكيد المكالمة.`
    : `Your time, ${label_en}, is held for you until payment. The amount is ${booking.amount_due} SAR, reference ${booking.reference}. Pay with the button below to confirm the call.`;
}

// A line that teases more slots ("and more", an ellipsis) instead of listing them.
const TEASER = /…|\.\.\.|(?:مواعيد|فترات|أوقات)\s+(?:إضافية|أخرى)|وغيرها|\b(?:more|other)\s+(?:slots|times|openings)\b/i;

/** Drop teaser lines from a reply that offers slots; a reply with none comes back unchanged. */
export function dropTeasers(text) {
  if (typeof text !== 'string') return text;
  const lines = text.split('\n');
  const kept = lines.filter((line) => !TEASER.test(line));
  if (kept.length === lines.length) return text;
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

/** Make sure a booking confirmation states the slot and the price, taken from the book result. */
export function withConfirmation(reply, booking, arabic) {
  const { start, end } = booking.slot;
  const plain = toWestern(reply);
  const hasPrice = plain.includes(String(booking.price_quoted));
  const hasSlot = plain.includes(start.slice(11, 16));
  if (hasPrice && hasSlot) return reply;
  const { label_en, label_ar } = slotLabels(start, end, AV);
  // Add only what is missing, so the customer is not told the same thing twice.
  const parts = arabic
    ? [hasSlot ? '' : `الموعد: ${label_ar}.`, hasPrice ? '' : `السعر: ${booking.price_quoted} ريال.`]
    : [hasSlot ? '' : `Your call: ${label_en}.`, hasPrice ? '' : `Price: ${booking.price_quoted} SAR.`];
  return `${reply.replace(/\s+$/, '')}\n\n${parts.filter(Boolean).join(' ')}`;
}

const failure = (code, message) => ({ ok: false, demo: true, error: { code, message } });

function runTool(desk, call, messages) {
  const tool = TOOLS.find((t) => t.name === call.function?.name);
  if (!tool) return failure('unknown_tool', `There is no tool called ${call.function?.name}.`);
  let args;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return failure('bad_arguments', 'The tool arguments were not valid JSON.');
  }
  const problem = checkArgs(tool.params, args);
  if (problem) return failure('bad_arguments', problem);
  // The transcript is added after the check, so the model can never write it.
  const input = KEEPS_TRANSCRIPT.has(tool.name) ? { ...args, transcript: transcriptOf(messages) } : args;
  return tool.run(desk, input, HUMAN);
}

/**
 * A chat over a desk. model.complete({ messages, tools }) returns { message, modelId }, where message
 * is an OpenAI-style assistant message. respond(history, text) returns { reply, toolCalls, modelId, history },
 * where history is the conversation to pass in next turn (without the system prompt).
 */
export function createChat({ desk, model, maxRounds = 6, lang = 'ar' }) {
  const arabic = (t) => lang === 'ar' && ARABIC.test(t ?? ''); // English replies on the English desk
  if (!desk || !model) throw new Error('createChat needs a desk and a model');
  return {
    async respond(history, text) {
      const messages = [{ role: 'system', content: promptFor(lang) }, ...history, { role: 'user', content: text }];
      const toolCalls = [];
      let modelId;
      let corrected = false;
      let nudged = false; // the slots-first note goes to the model at most once per turn
      let pickNudged = false; // so does the pick-first note
      let priceNudged = false; // and the stale-total note
      const picked = pickedOfferedSlot(messages);
      const visible = () => messages.slice(1).filter((m) => !HIDDEN.has(m));
      // Bookings made in this turn get the conversation up to the reply the customer is about to see.
      // One recommendation (Alfred, 2026-10-05): in the turn the card appears, a quote of the model's keeps its card
      // and its total only when it adds services the customer's own messages named.
      const recEntry = () => toolCalls.find((c) => c.name === 'recommend');
      const keepsCard = (c) => {
        const r = recEntry(); if (!r) return true;
        let args; try { args = JSON.parse(c.arguments || '{}'); } catch { return false; }
        const extra = (args.services ?? []).filter((id) => !r.result.services.some((s) => s.id === id));
        const said = messages.filter((m) => m.role === 'user' && !HIDDEN.has(m)).map((m) => String(m.content ?? ''));
        return extra.length > 0 && extra.every((id) => said.some((t) => namesService(t, id)));
      };
      const pinnedQuote = () => {
        const r = recEntry(); const own = toolCalls.findLast((c) => c.name === 'quote' && c.result?.ok);
        return r && (!own || !keepsCard(own)) ? r.result.quote : undefined;
      };
      const finish = (result) => {
        if (recEntry()) for (const c of toolCalls) if (c.name === 'quote') c.keepCard = keepsCard(c);
        let booked;
        for (const c of toolCalls) {
          if (c.name !== 'book' || !c.result?.ok) continue;
          booked = desk.updateTranscript(c.result.booking.reference, transcriptOf(messages), HUMAN).booking ?? booked;
        }
        // A measure, not a block: Latin words in an Arabic reply, for the server to log.
        const out = { ...result, latin: latinWords(result.reply), picked };
        return booked ? { ...out, booked } : out;
      };
      // Stop and pass the customer to a person, with the conversation the customer actually saw.
      const handOver = (summary, flag) => {
        const { handover } = desk.handover({ reason: 'out_of_rules', transcript: transcriptOf(messages), summary }, HUMAN);
        const reply = handoverReply(flag === 'guarded' ? 'guarded' : 'out_of_rules', arabic(text));
        messages.push({ role: 'assistant', content: reply });
        return finish({ reply, toolCalls, modelId, [flag]: true, handover, history: visible() });
      };
      // The recommendation (playbook stages 3-4), chosen and priced in code: once the customer has given a goal and
      // tapped a years button, the desk quotes the fit table's services itself, before the model replies, so the model
      // sees the same total the card shows. Services the model adds on its own never replace it (live run 2026-10-05).
      const rec = pendingRecommendation(messages);
      if (rec) {
        const args = quoteArgsFor(rec);
        const deskCall = { id: `${REC_CALL_PREFIX}_1`, type: 'function', function: { name: 'quote', arguments: JSON.stringify(args) } };
        const result = runTool(desk, deskCall, messages);
        if (result.ok) {
          messages.push({ role: 'assistant', content: null, tool_calls: [deskCall] }, { role: 'tool', tool_call_id: deskCall.id, content: JSON.stringify(result) });
          toolCalls.push({ name: 'recommend', arguments: deskCall.function.arguments, result: { ok: true, ...rec, quote: result } });
        }
      }
      for (let round = 0; round < maxRounds; round += 1) {
        const out = await model.complete({ messages, tools: CHAT_TOOLS });
        modelId = out.modelId;
        // Tool calls go back as they came; a text reply is cleaned before the guard and the customer see it.
        const message = out.message.tool_calls?.length ? out.message : { ...out.message, content: arabicWords(arabicPunctuation(plainDashes(plainMarkdown(out.message.content)))) };
        messages.push(message);
        if (!message.tool_calls?.length) {
          // A handover this turn (by the model or by a tool refusal) ends the line: the reply is built in code.
          const handed = toolCalls.findLast((c) => c.result?.handover)?.result.handover;
          if (handed) {
            message.content = handoverReply(handed.reason, arabic(text));
            return finish({ reply: message.content, toolCalls, modelId, history: visible() });
          }
          // Every SAR amount and time in the reply must be one a desk tool returned in this session.
          const results = messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
          // And no claim that the call is free or that nothing is due now: payment is taken at booking.
          const invented = [...ungrounded(message.content, results), ...paymentClaims(message.content)];
          if (!invented.length && !nudged && asksForContactFirst(message.content, messages)) {
            // Slots first (Mohannad, 2026-10-05): hold back a reply that asks for name and contact before any slot
            // was shown, once. If the model asks again, that reply goes out; it is not a reason to hand over.
            nudged = true;
            HIDDEN.add(message);
            const nudge = { role: 'user', content: 'Desk check, not from the customer: show the free slots first. Call '
              + 'check_availability and list them; ask for the name and contact after the customer picks one.' };
            HIDDEN.add(nudge);
            messages.push(nudge);
            continue;
          }
          if (!invented.length && !pickNudged && asksForContactBeforePick(message.content, messages)) {
            // Pick first (playbook v1, guardrail 10): the slots are on screen, so name and contact wait until the
            // customer picks one. Held back once, like the slots-first hold; a second ask goes out.
            pickNudged = true;
            HIDDEN.add(message);
            const nudge = { role: 'user', content: 'Desk check, not from the customer: the free slots are shown below your '
              + 'reply. Ask the customer to pick a time only; ask for the name and contact after they pick one.' };
            HIDDEN.add(nudge);
            messages.push(nudge);
            continue;
          }
          const stale = invented.length ? [] : staleTotals(message.content, messages, pinnedQuote());
          if (stale.length && !priceNudged) {
            // A total that is not the latest quote's (live run 2026-10-05): held back once, like the slots-first hold.
            priceNudged = true;
            HIDDEN.add(message);
            const nudge = { role: 'user', content: `Desk check, not from the customer: your reply states ${stale.join(', ')} SAR, which is `
              + 'not the total of the latest quote. If the customer changed the services, call quote for them and state the total it returns.' };
            HIDDEN.add(nudge);
            messages.push(nudge);
            continue;
          }
          if (!invented.length) {
            // Deterministic post-steps on a reply the guard passed: no teaser lines, and a confirmation that
            // states the slot and price from the book result. Both add only values a tool returned.
            let reply = message.content ?? '';
            if (toolCalls.some((c) => c.name === 'check_availability')) reply = dropTeasers(reply);
            const booking = toolCalls.findLast((c) => c.name === 'book' && c.result?.ok)?.result.booking;
            if (booking) {
              reply = booking.status === 'awaiting_payment' ? heldLine(booking, arabic(text)) : withConfirmation(reply, booking, arabic(text));
            }
            // A reply held back for slots first may have carried the quoted total; the customer still gets it.
            const quoted = (nudged || pickNudged) && toolCalls.findLast((c) => c.name === 'quote' && c.result?.ok)?.result;
            if (quoted) reply = withQuotedTotal(reply, quoted.total, arabic(text));
            message.content = reply;
            return finish({ reply, toolCalls, modelId, history: visible() });
          }
          HIDDEN.add(message);
          if (corrected) {
            return handOver(`The reply stated ${invented.join(', ')}, which no desk tool returned. Last message: ${text}`, 'guarded');
          }
          corrected = true;
          const correction = { role: 'user', content: `Desk check, not from the customer: your reply stated ${invented.join(', ')}, `
            + 'which no tool returned. Call the tool that gives the real value, or answer without stating it.' };
          HIDDEN.add(correction);
          messages.push(correction);
          continue;
        }
        for (const call of message.tool_calls) {
          const result = runTool(desk, call, messages);
          toolCalls.push({ name: call.function?.name, arguments: call.function?.arguments, result });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      // The model kept calling tools without answering.
      return handOver(`The chat stopped after ${maxRounds} tool rounds without an answer. Last message: ${text}`, 'capped');
    },
  };
}

const modelError = (code, message) => Object.assign(new Error(message), { code });

/** A model on Nebius Token Factory (OpenAI-compatible chat completions), using built-in fetch.
 * Errors carry code model_timeout (no answer within timeoutMs) or model_error, for a polite reply. */
export function createNebiusModel({ baseUrl = process.env.NEBIUS_BASE_URL, apiKey = process.env.NEBIUS_API_KEY,
  model = DEFAULT_MODEL, temperature = 0, timeoutMs = 20_000, fetchImpl = fetch } = {}) {
  if (!baseUrl || !apiKey) throw new Error('createNebiusModel needs NEBIUS_BASE_URL and NEBIUS_API_KEY');
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  return {
    async complete({ messages, tools }) {
      let data;
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw modelError('model_error', `model call failed: HTTP ${res.status}`);
        data = await res.json();
      } catch (err) {
        if (err?.code === 'model_error') throw err;
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          throw modelError('model_timeout', `model did not answer within ${timeoutMs} ms`);
        }
        throw modelError('model_error', `model call failed: ${err?.message}`);
      }
      return { message: data.choices[0].message, modelId: data.model ?? model };
    },
  };
}
