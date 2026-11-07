import { untypedQueryOutputParser } from '@hashgraph/hedera-agent-kit';
import { ReputedClient } from '@reputed/sdk';
import type { AgentDetail } from '@reputed/shared';
import { describe, expect, it } from 'vitest';
import { createReputedPlugin, REPUTED_TOOL_NAMES } from '../src/plugin';

function detail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agentId: '7', name: 'Alpha', description: 'Does things', tags: [], owner: '0x1', wallet: '0x1', creator: '0x2',
    humanBacked: true, score: { value: 80, tier: 'Tier 1', isNew: false }, creatorScore: 70, reviewsCounted: 3,
    registeredAt: '2026-11-01T00:00:00Z', acceptsX402: false, status: 'active', endpoints: {}, agentUri: 'hcs://0.0.1/1',
    operatorChanged: false, credentials: [], reviews: [], reviewsExcluded: 0, penaltiesConfirmed: 0,
    updatedAt: '2026-11-06T00:00:00Z', scoresStale: false, ...over,
  } as AgentDetail;
}

function pluginFor(responses: Record<string, { status: number; body: unknown }>) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const response = responses[new URL(url).pathname] ?? { status: 404, body: { code: 'NOT_FOUND', message: 'No such agent.' } };
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = new ReputedClient({ apiUrl: 'http://api.test', fetch: fetchImpl });
  const plugin = createReputedPlugin({ agentId: '7', client });
  const tools = plugin.tools({});
  const tool = (method: string) => tools.find((item) => item.method === method)!;
  const run = async (method: string, params: object = {}) => untypedQueryOutputParser(await tool(method).execute({} as never, {}, params));
  return { plugin, tools, run, urls };
}

describe('the Reputed plugin', () => {
  it('is a Hedera Agent Kit plugin with three query tools', () => {
    const { plugin, tools } = pluginFor({});
    expect(plugin).toMatchObject({ name: 'reputed', version: '0.1.0' });
    expect(tools.map((tool) => tool.method)).toEqual([
      REPUTED_TOOL_NAMES.MY_REPUTATION,
      REPUTED_TOOL_NAMES.GET_AGENT,
      REPUTED_TOOL_NAMES.VERIFY_COUNTERPARTY,
    ]);
    expect(new Set(tools.map((tool) => tool.toolType))).toEqual(new Set(['query']));
    for (const tool of tools) expect(tool.description.length).toBeGreaterThan(40);
  });

  it('checks tool input with the schemas', () => {
    const { tools } = pluginFor({});
    const verify = tools[2]!.parameters;
    expect(verify.safeParse({ agentId: '12', minScore: 70, humanBackedOnly: true }).success).toBe(true);
    expect(verify.safeParse({ agentId: 'abc' }).success).toBe(false);
    expect(verify.safeParse({ agentId: '1', minScore: 101 }).success).toBe(false);
  });

  it('reports the agent’s own reputation without being told its ID', async () => {
    const { run, urls } = pluginFor({ '/api/agents/7': { status: 200, body: detail() } });
    const out = await run(REPUTED_TOOL_NAMES.MY_REPUTATION);
    expect(urls).toEqual(['http://api.test/api/agents/7']);
    expect(out.raw).toMatchObject({ status: 'SUCCESS', agent: { agentId: '7', score: 80, humanBacked: true } });
    expect(out.humanMessage).toContain('score of 80');
    expect(out.raw.agent.reviews).toBeUndefined();
  });

  it('looks another agent up', async () => {
    const { run } = pluginFor({ '/api/agents/12': { status: 200, body: detail({ agentId: '12', name: 'Beta' }) } });
    const out = await run(REPUTED_TOOL_NAMES.GET_AGENT, { agentId: '12' });
    expect(out.raw.agent).toMatchObject({ agentId: '12', name: 'Beta' });
  });

  it('tells the model not to pay an agent that fails the gate', async () => {
    const { run } = pluginFor({ '/api/agents/9': { status: 200, body: detail({ agentId: '9', humanBacked: false }) } });
    const out = await run(REPUTED_TOOL_NAMES.VERIFY_COUNTERPARTY, { agentId: '9', humanBackedOnly: true });
    expect(out.raw).toMatchObject({ status: 'SUCCESS', ok: false, reason: 'NOT_HUMAN_BACKED' });
    expect(out.humanMessage).toMatch(/^Do not pay/);
  });

  it('passes an agent that clears the gate', async () => {
    const { run } = pluginFor({ '/api/agents/9': { status: 200, body: detail({ agentId: '9' }) } });
    const out = await run(REPUTED_TOOL_NAMES.VERIFY_COUNTERPARTY, { agentId: '9', minScore: 75 });
    expect(out.raw).toMatchObject({ ok: true });
  });

  it('answers a missing agent as a tool error, not an exception', async () => {
    const { run } = pluginFor({});
    const out = await run(REPUTED_TOOL_NAMES.GET_AGENT, { agentId: '404' });
    expect(out.raw).toMatchObject({ status: 'ERROR', errorCode: 'AGENT_NOT_FOUND' });
    expect(out.humanMessage).toContain('AGENT_NOT_FOUND');
  });
});
