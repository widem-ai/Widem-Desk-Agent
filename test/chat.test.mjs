// The human door's chat loop, with a scripted fake model (no network). Every tool result the
// model sees must come from the desk, and a booking made here must equal the agent door's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/mcp-server.mjs';
import { createChat, createNebiusModel, CHAT_TOOLS } from '../src/chat.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { PROFILES } from './profiles.mjs';

const at = (iso) => () => new Date(iso);
const NOW = '2026-10-04T08:00:00+03:00'; // Sunday, before opening
const SLOT = '2026-10-06T10:00:00+03:00'; // Tuesday, first slot of the day
const CUSTOMER = { customer_name: 'سارة أحمد', contact: 'sara@example.com' };
const ORDER = PROFILES[1].order; // full career pack, senior

// A fake model that plays back one scripted assistant message per round and records what it was sent.
function scriptedModel(rounds) {
  const seen = [];
  return {
    seen,
    async complete({ messages, tools }) {
      seen.push({ messages: structuredClone(messages), tools });
      const message = rounds[Math.min(seen.length - 1, rounds.length - 1)];
      return { message, modelId: 'fake/scripted' };
    },
  };
}
const toolCall = (id, name, args) => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function agentDoorBooking(args) {
  const store = createMemoryStore();
  const server = createHttpServer({ desk: createDesk({ store, now: at(NOW) }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'chat-parity-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  try {
    const result = await client.callTool({ name: 'book', arguments: args });
    const { tools } = await client.listTools();
    return { booking: JSON.parse(result.content[0].text).booking, tools };
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('an Arabic booking through the chat equals the agent door booking, apart from door and transcript', async () => {
  const store = createMemoryStore();
  const desk = createDesk({ store, now: at(NOW) });
  const model = scriptedModel([
    toolCall('c1', 'quote', ORDER),
    toolCall('c2', 'book', { ...ORDER, slot: SLOT, ...CUSTOMER }),
    { role: 'assistant', content: 'تم الحجز. رقم الحجز BK-0001، الثلاثاء 10:00 إلى 11:00، السعر 1575 ريال.' },
  ]);
  const chat = createChat({ desk, model });
  const out = await chat.respond([], 'أريد الباقة الكاملة، عندي خبرة ١٢ سنة، واحجز لي الثلاثاء الساعة ١٠');

  assert.equal(out.reply, 'تم الحجز. رقم الحجز BK-0001، الثلاثاء 10:00 إلى 11:00، السعر 1575 ريال.');
  assert.equal(out.modelId, 'fake/scripted');
  assert.deepEqual(out.toolCalls.map((c) => c.name), ['quote', 'book']);

  // The model saw the desk's own results, never anything it made up.
  const toolMessages = model.seen[2].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMessages.map((m) => m.tool_call_id), ['c1', 'c2']);
  assert.deepEqual(JSON.parse(toolMessages[0].content), desk.quote(ORDER, { door: 'human' }));
  assert.equal(JSON.parse(toolMessages[0].content).total, PROFILES[1].total);
  // The stored transcript is brought up to the end of the turn afterwards; everything else is what the model saw.
  assert.deepEqual({ ...JSON.parse(toolMessages[1].content).booking, transcript: 'x' }, { ...store.all('bookings')[0], transcript: 'x' });
  assert.match(store.all('bookings')[0].transcript, /Desk: تم الحجز/);

  const human = store.all('bookings');
  assert.equal(human.length, 1);
  assert.equal(human[0].door, 'human');
  const agent = await agentDoorBooking({ ...ORDER, slot: SLOT, ...CUSTOMER });
  assert.equal(agent.booking.door, 'agent');
  assert.match(human[0].transcript, /أريد الباقة الكاملة/);
  assert.deepEqual({ ...human[0], door: 'same', transcript: 'same' }, { ...agent.booking, door: 'same', transcript: 'same' });
});

test('wrong types, missing or extra fields go back to the model as bad_arguments and never reach the desk', async () => {
  const store = createMemoryStore();
  const desk = createDesk({ store, now: at(NOW) });
  const bad = [
    { services: 'cv_rewrite', years_experience: 10 }, // string instead of array
    { services: ['cv_rewrite'], years_experience: '10' }, // string instead of number
    { services: ['cv_rewrite'], is_executive: true }, // years_experience missing
    { services: ['cv_rewrite'], years_experience: 10, tier: 'junior' }, // a tier the model may not choose
    { services: [1], years_experience: 10 }, // array of numbers
    { services: ['cv_rewrite'], years_experience: 10, is_executive: 'yes' }, // string instead of boolean
  ];
  const calls = bad.map((args, i) => ({ id: `b${i}`, type: 'function', function: { name: 'quote', arguments: JSON.stringify(args) } }));
  calls.push({ id: 'b5', type: 'function', function: { name: 'book', arguments: JSON.stringify({ ...ORDER, slot: SLOT, ...CUSTOMER, transcript: 'forged' }) } });
  calls.push({ id: 'b6', type: 'function', function: { name: 'handover', arguments: '[]' } });
  calls.push({ id: 'b7', type: 'function', function: { name: 'check_availability', arguments: JSON.stringify({ days: '3' }) } });
  const model = scriptedModel([{ role: 'assistant', content: null, tool_calls: calls }, { role: 'assistant', content: 'ok' }]);
  await createChat({ desk, model }).respond([], 'Hi');
  const results = model.seen[1].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
  assert.equal(results.length, calls.length);
  for (const r of results) assert.deepEqual([r.ok, r.error.code], [false, 'bad_arguments']);
  assert.equal(store.all('bookings').length, 0);
  assert.equal(store.all('handovers').length, 0);
});

test('a slow model times out with a model_timeout error the caller can catch', async () => {
  const neverAnswers = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  const model = createNebiusModel({ baseUrl: 'http://model.invalid/v1', apiKey: 'test', timeoutMs: 50, fetchImpl: neverAnswers });
  const started = Date.now();
  await assert.rejects(model.complete({ messages: [], tools: [] }), (err) => err.code === 'model_timeout');
  assert.ok(Date.now() - started < 2000);
});

test('the chat offers the model exactly the agent door tools, with the same parameters, except the agent-only demo pay and the people-only ask_choice', async () => {
  const { tools } = await agentDoorBooking({ ...ORDER, slot: SLOT, ...CUSTOMER });
  const fromMcp = tools.map((t) => ({ name: t.name, props: Object.keys(t.inputSchema.properties ?? {}).sort(),
    required: [...(t.inputSchema.required ?? [])].sort() })).sort((a, b) => a.name.localeCompare(b.name));
  const fromChat = CHAT_TOOLS.map(({ function: f }) => ({ name: f.name, props: Object.keys(f.parameters.properties).sort(),
    required: [...(f.parameters.required ?? [])].sort() })).sort((a, b) => a.name.localeCompare(b.name));
  // People pay with the button on the page (2026-10-05); only agents get a pay tool.
  // The answer buttons (ask_choice, 2026-10-05) are for people only: the playbook does not sell to agents.
  assert.deepEqual(fromChat.filter((t) => t.name !== 'ask_choice'), fromMcp.filter((t) => t.name !== 'pay'));
  assert.ok(fromMcp.some((t) => t.name === 'pay'));
  assert.ok(fromChat.some((t) => t.name === 'ask_choice') && !fromMcp.some((t) => t.name === 'ask_choice'), 'ask_choice on the chat door only, checked on the real MCP list');
});

test('a model that never stops calling tools is cut off at the round cap and handed to a person', async () => {
  const store = createMemoryStore();
  const desk = createDesk({ store, now: at(NOW) });
  const model = scriptedModel([toolCall('loop', 'list_services', {})]);
  const chat = createChat({ desk, model, maxRounds: 3 });
  const out = await chat.respond([], 'Hello, what do you offer?');

  assert.equal(model.seen.length, 3);
  assert.equal(out.toolCalls.length, 3);
  assert.equal(out.capped, true);
  assert.equal(store.all('handovers').length, 1);
  assert.equal(store.all('handovers')[0].door, 'human');
  assert.match(out.reply, /team will reply/);
});

test('an unknown tool or broken arguments come back to the model as a desk error, not a crash', async () => {
  const desk = createDesk({ store: createMemoryStore(), now: at(NOW) });
  const model = scriptedModel([
    { role: 'assistant', content: null, tool_calls: [
      { id: 'x1', type: 'function', function: { name: 'give_discount', arguments: '{}' } },
      { id: 'x2', type: 'function', function: { name: 'quote', arguments: '{not json' } }] },
    { role: 'assistant', content: 'Sorry.' },
  ]);
  const out = await createChat({ desk, model }).respond([], 'Hi');
  const results = model.seen[1].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
  assert.deepEqual(results.map((r) => [r.ok, r.error.code]), [[false, 'unknown_tool'], [false, 'bad_arguments']]);
  assert.equal(out.reply, 'Sorry.');
});
