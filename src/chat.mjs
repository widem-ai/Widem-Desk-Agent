// The human door's brain: a chat loop where the model talks to a customer and calls the same desk
// tools as the agent door, in-process. Every tool result comes from the desk, never from the model.
import { readFileSync } from 'node:fs';
import { TOOLS, checkArgs, toJsonSchema } from './tools.mjs';
import { ungrounded } from './guard.mjs';

const HUMAN = { door: 'human' };
const HO = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8')).handover;
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
  '2. Never state a free time yourself. Call check_availability and offer only slots it returned. Book with book',
  'and repeat the booking reference exactly as it returned.',
  '3. Anything the tools do not cover (a discount, a complaint, a request outside the rules, or a customer who',
  'asks for a person) goes to handover. Then tell the customer what handover returned.',
  '4. Reply in the language the customer writes in: Arabic or English. Keep replies short.',
  '5. Ask for the customer name and a contact (email or phone) before booking.',
].join('\n');

/** Tool schemas for an OpenAI-compatible chat completions call, built from the shared definitions. */
export const CHAT_TOOLS = TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: toJsonSchema(t.params) },
}));

/** What to tell the customer when the model cannot answer (timeout or error), in their language. */
export const sorryReply = (text) => (ARABIC.test(text ?? '')
  ? 'عذرًا، لم أتمكن من الرد الآن. حاول مرة أخرى بعد قليل.'
  : 'Sorry, I could not answer just now. Please try again in a moment.');

/** The conversation as plain text for the owner page: customer and desk lines only, no tool traffic. */
export const transcriptOf = (messages) => messages
  .filter((m) => !HIDDEN.has(m) && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
  .map((m) => `${m.role === 'user' ? 'Customer' : 'Desk'}: ${m.content.trim()}`)
  .join('\n');

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
export function createChat({ desk, model, maxRounds = 6 }) {
  if (!desk || !model) throw new Error('createChat needs a desk and a model');
  return {
    async respond(history, text) {
      const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: text }];
      const toolCalls = [];
      let modelId;
      let corrected = false;
      const visible = () => messages.slice(1).filter((m) => !HIDDEN.has(m));
      // Stop and pass the customer to a person, with the conversation the customer actually saw.
      const handOver = (summary, flag) => {
        const { handover } = desk.handover({ reason: 'out_of_rules', transcript: transcriptOf(messages), summary }, HUMAN);
        const reply = ARABIC.test(text) ? HO.tell_customer_ar : HO.tell_customer_en;
        messages.push({ role: 'assistant', content: reply });
        return { reply, toolCalls, modelId, [flag]: true, handover, history: visible() };
      };
      for (let round = 0; round < maxRounds; round += 1) {
        const out = await model.complete({ messages, tools: CHAT_TOOLS });
        modelId = out.modelId;
        const message = out.message;
        messages.push(message);
        if (!message.tool_calls?.length) {
          // Every SAR amount and time in the reply must be one a desk tool returned in this session.
          const results = messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
          const invented = ungrounded(message.content, results);
          if (!invented.length) return { reply: message.content ?? '', toolCalls, modelId, history: visible() };
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
