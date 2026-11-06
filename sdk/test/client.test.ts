import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReputedClient, ReputedError } from '../src/index.ts';
import { agentFixture, fakeFetch } from './helpers.ts';

function clientFor(status: number, body: unknown) {
  const { fetch, urls } = fakeFetch(status, body);
  return { client: new ReputedClient({ apiUrl: 'http://api.test/', fetch }), urls };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: unknown) => err instanceof ReputedError && err.code === code);
}

test('getAgent requests the agent endpoint and returns the body', async () => {
  const { client, urls } = clientFor(200, agentFixture());
  const agent = await client.getAgent(7);
  assert.equal(agent.name, 'Alpha');
  assert.deepEqual(urls, ['http://api.test/api/agents/7']);
});

test('getAgent rejects ids that are not decimal numbers, without a request', async () => {
  const { client, urls } = clientFor(200, agentFixture());
  await rejectsWith(client.getAgent('7/../x'), 'INVALID_ARGUMENT');
  assert.equal(urls.length, 0);
});

test('getAgent maps 404 to AGENT_NOT_FOUND', async () => {
  const { client } = clientFor(404, { code: 'NOT_FOUND', message: 'No such agent' });
  await rejectsWith(client.getAgent('99'), 'AGENT_NOT_FOUND');
});

test('getAgent maps a CHAIN_ERROR body to CHAIN_ERROR and keeps the status', async () => {
  const { client } = clientFor(502, { code: 'CHAIN_ERROR', message: 'relay down' });
  await assert.rejects(client.getAgent('7'), (err: unknown) => err instanceof ReputedError && err.code === 'CHAIN_ERROR' && err.status === 502);
});

test('getAgent maps other failures and network errors to API_ERROR', async () => {
  await rejectsWith(clientFor(500, 'oops').client.getAgent('7'), 'API_ERROR');
  const down = new ReputedClient({ apiUrl: 'http://api.test', fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  await rejectsWith(down.getAgent('7'), 'API_ERROR');
});

test('verifyCounterparty passes an agent that meets every condition', async () => {
  const { client } = clientFor(200, agentFixture());
  const result = await client.verifyCounterparty('7', { minScore: 75, humanBackedOnly: true });
  assert.equal(result.ok, true);
});

test('verifyCounterparty accepts a score equal to minScore', async () => {
  const { client } = clientFor(200, agentFixture({ score: { value: 75, tier: 'Tier 1', isNew: false } }));
  assert.equal((await client.verifyCounterparty('7', { minScore: 75 })).ok, true);
});

test('verifyCounterparty returns SCORE_TOO_LOW below minScore', async () => {
  const { client } = clientFor(200, agentFixture({ score: { value: 60, tier: 'Tier 2', isNew: false } }));
  const result = await client.verifyCounterparty('7', { minScore: 75 });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'SCORE_TOO_LOW');
});

test('verifyCounterparty returns NOT_HUMAN_BACKED only when humanBackedOnly is set', async () => {
  const { client } = clientFor(200, agentFixture({ humanBacked: false }));
  const strict = await client.verifyCounterparty('7', { humanBackedOnly: true });
  assert.equal(!strict.ok && strict.reason, 'NOT_HUMAN_BACKED');
  assert.equal((await client.verifyCounterparty('7')).ok, true);
});

test('verifyCounterparty refuses a compromised agent even with no options', async () => {
  const { client } = clientFor(200, agentFixture({ status: 'compromised' }));
  const result = await client.verifyCounterparty('7');
  assert.equal(!result.ok && result.reason, 'AGENT_COMPROMISED');
});

test('verifyCounterparty rejects a bad minScore without a request', async () => {
  const { client, urls } = clientFor(200, agentFixture());
  await rejectsWith(client.verifyCounterparty('7', { minScore: 150 }), 'INVALID_ARGUMENT');
  await rejectsWith(client.verifyCounterparty('7', { minScore: Number.NaN }), 'INVALID_ARGUMENT');
  assert.equal(urls.length, 0);
});

test('verifyCounterparty throws when the agent cannot be fetched', async () => {
  const { client } = clientFor(404, { code: 'NOT_FOUND', message: 'No such agent' });
  await rejectsWith(client.verifyCounterparty('99', { minScore: 75 }), 'AGENT_NOT_FOUND');
});
