// The agent door: a real MCP client talks to the server over Streamable HTTP on a free port,
// and every answer must be exactly what the core returns for the same input.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/mcp-server.mjs';
import { listServices, quote } from '../src/core.mjs';
import { PROFILES } from './profiles.mjs';

let server;
let client;

before(async () => {
  server = createHttpServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); // port 0: the OS picks a free one
  const { port } = server.address();
  client = new Client({ name: 'agent-door-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
});

after(async () => {
  await client?.close();
  await new Promise((resolve) => server.close(resolve));
});

const parse = (result) => JSON.parse(result.content[0].text);

test('the agent door lists exactly list_services and quote', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['list_services', 'quote']);
  for (const t of tools) assert.ok(t.description.length > 20, `${t.name} needs a description an agent can act on`);
});

test('list_services over HTTP returns exactly the core result', async () => {
  const result = await client.callTool({ name: 'list_services', arguments: {} });
  assert.deepEqual(parse(result), listServices());
});

for (const p of PROFILES) {
  test(`quote over HTTP equals the core: ${p.name}`, async () => {
    const result = await client.callTool({ name: 'quote', arguments: p.input });
    assert.ok(!result.isError);
    assert.deepEqual(parse(result), quote(p.input));
    assert.equal(parse(result).total, p.total);
  });
}

test('a refused quote over HTTP equals the core refusal and is flagged as an error', async () => {
  const input = { services: ['salary_negotiation'], tier: 'senior' };
  const result = await client.callTool({ name: 'quote', arguments: input });
  assert.equal(result.isError, true);
  assert.deepEqual(parse(result), quote(input));
});

test('anything other than /mcp is a 404', async () => {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/admin`);
  assert.equal(res.status, 404);
});

test('a malformed body gets a 400, not a crash', async () => {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  // the server is still up afterwards
  const again = await client.callTool({ name: 'quote', arguments: PROFILES[0].input });
  assert.equal(parse(again).total, PROFILES[0].total);
});
