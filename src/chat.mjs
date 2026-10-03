// The human door's brain: a chat loop where the model talks to a customer and calls the same desk
// tools as the agent door, in-process. Every tool result comes from the desk, never from the model.
import { readFileSync } from 'node:fs';
import { TOOLS, toJsonSchema } from './tools.mjs';

const HUMAN = { door: 'human' };
const HO = JSON.parse(readFileSync(new URL('../data/demo-business.json', import.meta.url), 'utf8')).handover;
export const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const ARABIC = /[؀-ۿ]/;

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

const failure = (code, message) => ({ ok: false, demo: true, error: { code, message } });

function runTool(desk, call) {
  const tool = TOOLS.find((t) => t.name === call.function?.name);
  if (!tool) return failure('unknown_tool', `There is no tool called ${call.function?.name}.`);
  let args;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return failure('bad_arguments', 'The tool arguments were not valid JSON.');
  }
  return tool.run(desk, args ?? {}, HUMAN);
}

/**
 * A chat over a desk. model.complete({ messages, tools }) returns { message, modelId }, where message
 * is an OpenAI-style assistant message. respond(history, text) returns { reply, toolCalls, modelId }.
 */
export function createChat({ desk, model, maxRounds = 6 }) {
  if (!desk || !model) throw new Error('createChat needs a desk and a model');
  return {
    async respond(history, text) {
      const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: text }];
      const toolCalls = [];
      let modelId;
      for (let round = 0; round < maxRounds; round += 1) {
        const out = await model.complete({ messages, tools: CHAT_TOOLS });
        modelId = out.modelId;
        const message = out.message;
        messages.push(message);
        if (!message.tool_calls?.length) return { reply: message.content ?? '', toolCalls, modelId };
        for (const call of message.tool_calls) {
          const result = runTool(desk, call);
          toolCalls.push({ name: call.function?.name, arguments: call.function?.arguments, result });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      // The model kept calling tools without answering: stop and pass the customer to a person.
      desk.handover({ reason: 'out_of_rules', summary: `The chat stopped after ${maxRounds} tool rounds without an answer. Last message: ${text}` }, HUMAN);
      return { reply: ARABIC.test(text) ? HO.tell_customer_ar : HO.tell_customer_en, toolCalls, modelId, capped: true };
    },
  };
}

/** A model on Nebius Token Factory (OpenAI-compatible chat completions), using built-in fetch. */
export function createNebiusModel({ baseUrl = process.env.NEBIUS_BASE_URL, apiKey = process.env.NEBIUS_API_KEY,
  model = DEFAULT_MODEL, temperature = 0, fetchImpl = fetch } = {}) {
  if (!baseUrl || !apiKey) throw new Error('createNebiusModel needs NEBIUS_BASE_URL and NEBIUS_API_KEY');
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  return {
    async complete({ messages, tools }) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature }),
      });
      if (!res.ok) throw new Error(`model call failed: HTTP ${res.status}`);
      const data = await res.json();
      return { message: data.choices[0].message, modelId: data.model ?? model };
    },
  };
}
