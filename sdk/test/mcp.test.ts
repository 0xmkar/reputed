import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ReputedClient } from '../src/index.ts';
import { createMcpServer } from '../src/mcpServer.ts';
import { agentFixture, fakeFetch } from './helpers.ts';

async function connect(status: number, body: unknown) {
  const { fetch } = fakeFetch(status, body);
  const server = createMcpServer(new ReputedClient({ apiUrl: 'http://api.test', fetch }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  const first = (result.content as { type: string; text: string }[])[0];
  return first?.text ?? '';
}

test('the server lists get_agent and verify_counterparty', async () => {
  const client = await connect(200, agentFixture());
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_agent', 'verify_counterparty']);
});

test('get_agent returns a summary without the reviews', async () => {
  const client = await connect(200, agentFixture({ reviews: [{} as never] }));
  const result = await client.callTool({ name: 'get_agent', arguments: { agentId: '7' } });
  const body = JSON.parse(text(result));
  assert.equal(body.name, 'Alpha');
  assert.equal(body.humanBacked, true);
  assert.equal('reviews' in body, false);
});

test('verify_counterparty reports ok false with a reason', async () => {
  const client = await connect(200, agentFixture({ score: { value: 40, tier: 'Tier 3', isNew: false } }));
  const result = await client.callTool({ name: 'verify_counterparty', arguments: { agentId: '7', minScore: 75 } });
  const body = JSON.parse(text(result));
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'SCORE_TOO_LOW');
  assert.equal(body.score, 40);
});

test('a missing agent comes back as a tool error with the code', async () => {
  const client = await connect(404, { code: 'NOT_FOUND', message: 'No such agent' });
  const result = await client.callTool({ name: 'get_agent', arguments: { agentId: '99' } });
  assert.equal(result.isError, true);
  assert.match(text(result), /^AGENT_NOT_FOUND:/);
});

test('a non-numeric agentId is refused by the tool schema', async () => {
  const client = await connect(200, agentFixture());
  const result = await client.callTool({ name: 'get_agent', arguments: { agentId: 'abc' } }).catch((err: unknown) => err);
  assert.ok(result instanceof Error || (result as { isError?: boolean }).isError === true);
});
