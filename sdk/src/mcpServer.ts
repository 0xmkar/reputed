import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentDetail } from '@reputed/shared';
import type { ReputedClient } from './client.ts';
import { ReputedError } from './errors.ts';

/** A short, model-friendly view of an agent. Reviews are left out; they can be long. */
function summarise(agent: AgentDetail) {
  return {
    agentId: agent.agentId,
    name: agent.name,
    description: agent.description,
    score: agent.score.value,
    tier: agent.score.tier,
    scoreInheritedFromCreator: agent.score.isNew,
    humanBacked: agent.humanBacked,
    status: agent.status,
    creator: agent.creator,
    creatorScore: agent.creatorScore,
    reviewsCounted: agent.reviewsCounted,
    reviewsExcluded: agent.reviewsExcluded,
    penaltiesConfirmed: agent.penaltiesConfirmed,
    scoresStale: agent.scoresStale,
    acceptsX402: agent.acceptsX402,
    credentials: agent.credentials.map((c) => ({ kind: c.kind, title: c.title, revoked: c.revoked })),
  };
}

function asText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function asError(err: unknown) {
  const text = err instanceof ReputedError ? `${err.code}: ${err.message}` : `Unexpected error: ${String(err)}`;
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

const agentId = z.string().regex(/^\d+$/, 'Agent IDs are decimal numbers').describe('The agent ID, a decimal number');

export function createMcpServer(client: ReputedClient): McpServer {
  const server = new McpServer({ name: 'reputed', version: '0.1.0' });

  server.registerTool(
    'get_agent',
    {
      title: 'Get agent',
      description: 'Look up an agent on Reputed: its score and tier, whether a verified human stands behind it, its creator and its credentials.',
      inputSchema: { agentId },
    },
    async ({ agentId }) => {
      try {
        return asText(summarise(await client.getAgent(agentId)));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    'verify_counterparty',
    {
      title: 'Verify counterparty',
      description:
        'Check whether an agent is safe to pay or hire. Returns ok true or false with a reason: NOT_HUMAN_BACKED, SCORE_TOO_LOW or AGENT_COMPROMISED.',
      inputSchema: {
        agentId,
        minScore: z.number().min(0).max(100).optional().describe('Refuse agents scoring below this, from 0 to 100'),
        humanBackedOnly: z.boolean().optional().describe('Refuse agents that are not linked to a verified human'),
      },
    },
    async ({ agentId, minScore, humanBackedOnly }) => {
      try {
        const result = await client.verifyCounterparty(agentId, { minScore, humanBackedOnly });
        const { agent } = result;
        const context = {
          agentId: agent.agentId,
          name: agent.name,
          score: agent.score.value,
          tier: agent.score.tier,
          isNew: agent.score.isNew,
          humanBacked: agent.humanBacked,
          status: agent.status,
          scoresStale: agent.scoresStale,
        };
        return asText(result.ok ? { ok: true, ...context } : { ok: false, reason: result.reason, message: result.message, ...context });
      } catch (err) {
        return asError(err);
      }
    },
  );

  return server;
}
