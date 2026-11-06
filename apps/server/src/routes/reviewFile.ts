import type { FastifyInstance } from 'fastify';
import { HEDERA_TESTNET, serializeReviewFile, type ReviewFileResponse } from '@reputed/shared';
import { getAddress, isAddress, keccak256, type Address } from 'viem';
import { z } from 'zod';
import type { ReviewBudget } from '../config.ts';
import { badRequest, chainError, logReason } from '../errors.ts';
import type { ReviewPublisher } from '../hedera.ts';
import { isSignedBy, signatureSchema } from '../signatures.ts';
import {
  byIp,
  createPublishGate,
  limiter,
  provenLimiter,
  type RateLimits,
} from './rateLimits.ts';

/** HCS allows 1,024 bytes per message; the plan requires the file to stay under that. */
export const MAX_REVIEW_FILE_BYTES = 1024;

const CAIP_PREFIX = `eip155:${HEDERA_TESTNET.id}:`;

const caipAddress = z
  .string()
  .refine((v) => v.toLowerCase().startsWith(CAIP_PREFIX))
  .transform((v) => v.slice(CAIP_PREFIX.length))
  .refine((v) => isAddress(v, { strict: false }))
  .transform((v) => `${CAIP_PREFIX}${getAddress(v)}`);

export const reviewFile = z.strictObject({
  agentRegistry: caipAddress,
  agentId: z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d{1,78}$/)]),
  clientAddress: caipAddress,
  createdAt: z.iso.datetime({ offset: true }),
  value: z.number().int().min(0).max(100),
  valueDecimals: z.literal(0),
  tag1: z.enum(['quality', 'misconduct']),
  tag2: z.string().regex(/^[a-z0-9-]{1,32}$/),
  endpoint: z.string().min(1).max(256),
  comment: z.string().max(512).optional(),
  // A review with no payment or a made-up one is still accepted: the scorer
  // excludes it, so the record of it must exist (T4.5, T4.6).
  proofOfPayment: z.string().min(1).max(128).optional(),
});

// The signature travels beside the file, never in it, so feedbackHash stays a hash
// of the review alone.
const reviewRequest = reviewFile.extend({ signature: signatureSchema });

export interface ReviewFileDeps {
  identityRegistry: Address;
  publisher: ReviewPublisher;
  rateLimits: RateLimits;
  budget: ReviewBudget;
}

export function registerReviewFileRoute(app: FastifyInstance, deps: ReviewFileDeps): void {
  const { identityRegistry, publisher, rateLimits } = deps;
  const expectedRegistry = `${CAIP_PREFIX}${identityRegistry}`;
  const limitClient = provenLimiter(app, rateLimits.reviewFileByClient, 'review-file:client');
  const gate = createPublishGate(deps.budget);

  app.post(
    '/api/review-file',
    { preHandler: limiter(app, rateLimits.reviewFileByIp, byIp('review-file')) },
    async (req): Promise<ReviewFileResponse> => {
      const parsed = reviewRequest.safeParse(req.body);
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path.join('.') || 'body';
        throw badRequest(`Invalid review file: check "${field}".`);
      }
      const { signature, ...file } = parsed.data;
      if (file.agentRegistry !== expectedRegistry) {
        throw badRequest(`agentRegistry must be ${expectedRegistry}.`);
      }

      const bytes = serializeReviewFile(file);
      if (bytes.length >= MAX_REVIEW_FILE_BYTES) {
        throw badRequest(
          `Review file is ${bytes.length} bytes; it must be under ${MAX_REVIEW_FILE_BYTES}. Shorten the comment.`,
        );
      }

      const client = file.clientAddress.slice(CAIP_PREFIX.length) as Address;
      if (!(await isSignedBy(client, { raw: bytes }, signature))) {
        throw badRequest('Invalid review file: check "signature". clientAddress must sign the file.');
      }
      await limitClient(req, client);

      const release = gate.acquire();
      let published;
      try {
        published = await publisher.publish(bytes);
      } catch (err) {
        req.log.error({ reason: logReason(err) }, 'HCS submit failed');
        throw chainError('Could not post the review file to HCS. Try again.');
      } finally {
        release();
      }

      return {
        feedbackUri: `hcs://${published.topicId}/${published.sequenceNumber}`,
        // Mirror Node serves these same bytes back, base64-encoded.
        feedbackHash: keccak256(bytes),
      };
    },
  );
}
