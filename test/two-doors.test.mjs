// Spec A2b, one brain, two doors: the same five customer profiles go through the human door (the chat loop,
// with a scripted model so no network) and through the agent door (a real MCP client over HTTP). Each door must
// return the identical quote and store an identical booking; only the door and the transcript may differ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/mcp-server.mjs';
import { createChat } from '../src/chat.mjs';
import { createDesk } from '../src/desk.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { PROFILES } from './profiles.mjs';

const at = (iso) => () => new Date(iso);
const NOW = '2026-10-04T08:00:00+03:00'; // Sunday, before opening
const SLOT = '2026-10-06T10:00:00+03:00'; // Tuesday, first slot of the day
const CUSTOMER = { customer_name: 'Test Customer', contact: 'test@example.com' };

const toolCall = (id, name, args) => ({ role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

// Human door: the model asks for quote, then book; the desk's answers are read from what the model was sent.
async function humanDoor(order) {
  const store = createMemoryStore();
  const desk = createDesk({ store, now: at(NOW) });
  const rounds = [toolCall('q', 'quote', order), toolCall('b', 'book', { ...order, slot: SLOT, ...CUSTOMER }),
    { role: 'assistant', content: 'Booked.' }];
  const seen = [];
  const model = { async complete({ messages }) {
    seen.push(structuredClone(messages));
    return { message: rounds[Math.min(seen.length - 1, rounds.length - 1)], modelId: 'fake/scripted' };
  } };
  await createChat({ desk, model, lang: 'en' }).respond([], 'I need my CV done, please book Tuesday at 10.');
  const quoteMsg = seen.at(-1).find((m) => m.role === 'tool' && m.tool_call_id === 'q');
  return { quote: JSON.parse(quoteMsg.content), bookings: store.all('bookings') };
}

// Agent door: a real MCP client on a free port (port 0) calls quote, then book.
async function agentDoor(order) {
  const store = createMemoryStore();
  const server = createHttpServer({ desk: createDesk({ store, now: at(NOW) }), lang: 'en' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'two-doors-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  try {
    const q = await client.callTool({ name: 'quote', arguments: order });
    const b = await client.callTool({ name: 'book', arguments: { ...order, slot: SLOT, ...CUSTOMER } });
    assert.ok(!b.isError, b.content[0].text);
    return { quote: JSON.parse(q.content[0].text), bookings: store.all('bookings') };
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

const sameDoor = (booking) => ({ ...booking, door: 'same', transcript: 'same' });

for (const p of PROFILES) {
  test(`A2b, both doors give the same quote and booking: ${p.name}`, async () => {
    const human = await humanDoor(p.order);
    const agent = await agentDoor(p.order);

    assert.equal(human.quote.total, p.total, 'human door total against the hand-worked price');
    assert.equal(agent.quote.total, p.total, 'agent door total against the hand-worked price');
    assert.deepEqual(human.quote, agent.quote, 'the two doors quote differently');

    assert.equal(human.bookings.length, 1);
    assert.equal(agent.bookings.length, 1);
    assert.equal(human.bookings[0].door, 'human');
    assert.equal(agent.bookings[0].door, 'agent');
    assert.equal(human.bookings[0].price_quoted, p.total);
    assert.deepEqual(sameDoor(human.bookings[0]), sameDoor(agent.bookings[0]), 'the two doors store different bookings');
  });
}
