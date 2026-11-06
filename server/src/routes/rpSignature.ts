import type { RpSignatureResponse } from '@reputed/shared';
import type { FastifyInstance } from 'fastify';
import type { WorldConfig } from '../config.ts';
import { signRpRequest } from '../world/signing.ts';
import { byIp, limiter, type RateLimits } from './rateLimits.ts';

/**
 * IDKit 4.x refuses to start a request without a signed RP context:
 * https://docs.world.org/world-id/idkit/signatures
 * The action comes from config, not the caller, so this cannot sign for anything else.
 */
export function registerRpSignatureRoute(
  app: FastifyInstance,
  world: WorldConfig,
  rateLimits: RateLimits,
): void {
  app.post(
    '/api/rp-signature',
    { preHandler: limiter(app, rateLimits.rpSignatureByIp, byIp('rp-signature')) },
    async (): Promise<RpSignatureResponse> => {
      const signed = await signRpRequest({ signingKey: world.signingKey, action: world.action });
      return {
        rp_context: {
          rp_id: world.rpId,
          nonce: signed.nonce,
          created_at: signed.createdAt,
          expires_at: signed.expiresAt,
          signature: signed.sig,
        },
        action: world.action,
        environment: world.environment,
        protocol_version: world.protocolVersion,
      };
    },
  );
}
