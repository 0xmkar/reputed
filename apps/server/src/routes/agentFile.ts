import type { FastifyInstance } from 'fastify';
import type { AgentFileResponse } from '@reputed/shared';
import { keccak256 } from 'viem';
import { z } from 'zod';
import { badRequest } from '../errors.ts';
import { byIp, limiter, type RateLimits } from './rateLimits.ts';

// https://eips.ethereum.org/EIPS/eip-8004#agent-uri-and-agent-registration-file
const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
const DATA_URI_PREFIX = 'data:application/json;base64,';

/**
 * The URI is stored on-chain by register(). Measured with eth_estimateGas against
 * the testnet Identity Registry on 2026-11-06: about 165k gas plus 780 gas per
 * URI byte, so 5,000 bytes costs 4.1M gas (roughly 5 HBAR at 124 tinybar/gas).
 * Gas alone would reach the 15M limit near 19,000 bytes. The cap sits lower to
 * keep the signed transaction under 6 KB, above which it counts as a jumbo
 * transaction (HIP-1086) and falls under a separate network throttle.
 */
export const MAX_AGENT_URI_BYTES = 5_000;

const service = z.looseObject({
  name: z.string().min(1),
  endpoint: z.string().min(1),
  version: z.string().optional(),
});

const registration = z.object({
  agentId: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  agentRegistry: z.string().regex(/^[a-z0-9-]+:\d+:0x[0-9a-fA-F]{40}$/),
});

// Loose: the spec lets agents add fields, and they must survive into the file.
const registrationFile = z.looseObject({
  type: z.literal(REGISTRATION_TYPE),
  name: z.string().min(1),
  description: z.string(),
  image: z.string(),
  services: z.array(service).min(1),
  x402Support: z.boolean(),
  active: z.boolean(),
  registrations: z.array(registration),
  supportedTrust: z.array(z.string().min(1)).optional(),
});

export function encodeAgentFile(file: unknown): AgentFileResponse {
  const bytes = Buffer.from(JSON.stringify(file), 'utf8');
  return {
    uri: `${DATA_URI_PREFIX}${bytes.toString('base64')}`,
    hash: keccak256(bytes),
  };
}

export function registerAgentFileRoute(app: FastifyInstance, rateLimits: RateLimits): void {
  app.post(
    '/api/agent-file',
    { preHandler: limiter(app, rateLimits.agentFileByIp, byIp('agent-file')) },
    async (req): Promise<AgentFileResponse> => {
      const parsed = registrationFile.safeParse(req.body);
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path.join('.') || 'body';
        throw badRequest(`Invalid agent file: check "${field}".`);
      }

      const encoded = encodeAgentFile(parsed.data);
      if (encoded.uri.length > MAX_AGENT_URI_BYTES) {
        throw badRequest(
          `Agent file is too large: its URI is ${encoded.uri.length} bytes, the limit is ${MAX_AGENT_URI_BYTES}. Use an image URL rather than embedded image data.`,
        );
      }
      return encoded;
    },
  );
}
