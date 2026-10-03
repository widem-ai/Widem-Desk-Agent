// One live turn through the real model on Nebius Token Factory, over a memory store (nothing is kept).
// Run from the repo root: node --env-file=.env smoke/chat-live.mjs ["your message"]
// Prints the model id, the tool calls the desk ran, and the reply. Never prints the key.
import { createChat, createNebiusModel } from '../src/chat.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';

const message = process.argv[2]
  ?? 'Hi, I am a senior manager with 12 years of experience. How much is a CV rewrite plus a LinkedIn profile?';
const chat = createChat({ desk: createDesk({ store: createMemoryStore() }), model: createNebiusModel() });
const started = Date.now();
const out = await chat.respond([], message);

console.log(`message:  ${message}`);
console.log(`modelId:  ${out.modelId}`);
console.log(`seconds:  ${((Date.now() - started) / 1000).toFixed(1)}`);
for (const c of out.toolCalls) {
  const r = c.result;
  const summary = r?.ok === false ? `refused ${r.error?.code}` : r?.total !== undefined ? `total ${r.total} ${r.currency}` : 'ok';
  console.log(`tool:     ${c.name} ${c.arguments} -> ${summary}`);
}
if (out.capped) console.log('capped:   true (handed to a person)');
console.log(`reply:    ${out.reply}`);
