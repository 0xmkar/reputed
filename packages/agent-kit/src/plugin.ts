import { TOOL_TYPE, untypedQueryOutputParser, type Context, type Plugin, type Tool } from '@hashgraph/hedera-agent-kit';
import { ReputedError, summarise, type ReputedClient } from '@reputed/sdk';
import { z } from 'zod';

// Three read-only tools for the Hedera Agent Kit. They are QUERY tools that call the Reputed API, not
// Hedera, so the kit's own client and context arguments are ignored. Failures are returned inside the
// envelope rather than thrown: the model sees the error code and can act on it instead of the run dying.

export const REPUTED_TOOL_NAMES = {
  MY_REPUTATION: 'reputed_my_reputation',
  GET_AGENT: 'reputed_get_agent',
  VERIFY_COUNTERPARTY: 'reputed_verify_counterparty',
} as const;

/** What the plugin needs from a connected agent. */
export interface PluginSource {
  readonly agentId: string;
  readonly client: ReputedClient;
}

const agentIdSchema = z.string().regex(/^\d+$/, 'Agent IDs are decimal numbers').describe('The agent ID, a decimal number');

/** The envelope every Hedera Agent Kit tool answers with: the toolkit's output parsers read it. */
function envelope(raw: Record<string, unknown>, humanMessage: string): string {
  return JSON.stringify({ raw: { status: 'SUCCESS', ...raw }, humanMessage });
}

/** The same envelope with status ERROR, carrying the ReputedError code when there is one. */
function failure(error: unknown): string {
  const code = error instanceof ReputedError ? error.code : 'ERROR';
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({ raw: { status: 'ERROR', errorCode: code, error: message }, humanMessage: `${code}: ${message}` });
}

function query(tool: Omit<Tool, 'toolType' | 'outputParser'>): Tool {
  return { ...tool, toolType: TOOL_TYPE.QUERY, outputParser: untypedQueryOutputParser };
}

/** Reputation tools for an agent built with the Hedera Agent Kit. Add it to `configuration.plugins`. */
export function createReputedPlugin(source: PluginSource): Plugin {
  const { client } = source;

  // Takes no parameters: the agent's own ID was fixed at connect time, so the model cannot ask about the wrong agent.
  const myReputation = query({
    method: REPUTED_TOOL_NAMES.MY_REPUTATION,
    name: 'Get my reputation',
    description:
      'Look up this agent’s own reputation on Reputed: its score and tier, whether a verified human stands behind it, and its credentials. Use it when asked about your own track record or trustworthiness.',
    parameters: z.object({}),
    execute: async () => {
      try {
        const summary = summarise(await client.getAgent(source.agentId));
        return envelope({ agent: summary }, `You are agent #${summary.agentId} with a score of ${summary.score} (${summary.tier}); human backed: ${summary.humanBacked}.`);
      } catch (error) {
        return failure(error);
      }
    },
  });

  const getAgent = query({
    method: REPUTED_TOOL_NAMES.GET_AGENT,
    name: 'Get an agent’s reputation',
    description:
      'Look up another agent on Reputed by its agent ID: score and tier, whether a verified human stands behind it, its creator and its credentials.',
    parameters: z.object({ agentId: agentIdSchema }),
    execute: async (_client: unknown, _context: Context, params: { agentId: string }) => {
      try {
        const summary = summarise(await client.getAgent(params.agentId));
        return envelope({ agent: summary }, `Agent #${summary.agentId} (${summary.name}) scores ${summary.score} (${summary.tier}); human backed: ${summary.humanBacked}; status: ${summary.status}.`);
      } catch (error) {
        return failure(error);
      }
    },
  });

  // The gate. A failed check is a normal result with ok: false and a reason; only an unreachable API is an error.
  const verifyCounterparty = query({
    method: REPUTED_TOOL_NAMES.VERIFY_COUNTERPARTY,
    name: 'Verify a counterparty before paying or hiring it',
    description:
      'Check whether another agent is safe to pay or hire. Returns ok: false with a reason when the agent was reported compromised, has no verified human behind it (if humanBackedOnly), or scores below minScore. Call this BEFORE sending any payment to another agent.',
    parameters: z.object({
      agentId: agentIdSchema,
      minScore: z.number().min(0).max(100).optional().describe('Refuse agents scoring below this (0-100)'),
      humanBackedOnly: z.boolean().optional().describe('Refuse agents that are not linked to a verified human'),
    }),
    execute: async (_client: unknown, _context: Context, params: { agentId: string; minScore?: number; humanBackedOnly?: boolean }) => {
      try {
        const check = await client.verifyCounterparty(params.agentId, {
          ...(params.minScore !== undefined ? { minScore: params.minScore } : {}),
          ...(params.humanBackedOnly !== undefined ? { humanBackedOnly: params.humanBackedOnly } : {}),
        });
        const agent = summarise(check.agent);
        return check.ok
          ? envelope({ ok: true, agent }, `Agent #${agent.agentId} passed the check (score ${agent.score}).`)
          : envelope({ ok: false, reason: check.reason, message: check.message, agent }, `Do not pay: ${check.message}`);
      } catch (error) {
        return failure(error);
      }
    },
  });

  return {
    name: 'reputed',
    version: '0.1.0',
    description: 'Reputed: human-backed agent reputation on Hedera. Check agents before paying them, and read your own score.',
    tools: () => [myReputation, getAgent, verifyCounterparty],
  };
}
