// POST /api/session issues a token for a fresh wallet signature; GET /api/session reads one.
// No list of used signatures is kept: a captured signature is good for the same wallet only,
// and only inside the five-minute window around its issuedAt.
import { sessionMessage, type SessionInfo, type SessionResponse } from '@reputed/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import { ApiHttpError, badRequest } from '../errors.ts';
import { SIGN_IN_WINDOW_SECONDS, issueSessionToken, readSessionToken, type SessionClaims } from '../session.ts';
import { isSignedBy, signatureSchema } from '../signatures.ts';
import { byIp, limiter, type RateLimits } from './rateLimits.ts';

const sessionBody = z.object({
  wallet: z.string().refine((v) => isAddress(v, { strict: false }) && BigInt(v) !== 0n),
  issuedAt: z.number().int().positive(),
  /** EIP-191 signature by `wallet` over sessionMessage(wallet, issuedAt). */
  signature: signatureSchema,
});

const unauthorized = () =>
  new ApiHttpError(401, 'UNAUTHORIZED', 'Your session has ended. Sign in with your wallet again.');

export interface SessionDeps {
  secret: string;
  rateLimits: RateLimits;
  now?: () => number;
}

/** The wallet behind a request's `Authorization: Bearer` token, or a 401. */
export function requireSession(req: FastifyRequest, secret: string, nowSeconds: number): SessionClaims {
  const header = req.headers.authorization ?? '';
  const claims = header.startsWith('Bearer ') ? readSessionToken(secret, header.slice(7), nowSeconds) : null;
  if (!claims) throw unauthorized();
  return claims;
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionDeps): void {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const limit = limiter(app, deps.rateLimits.sessionByIp, byIp('session'));

  app.post('/api/session', { preHandler: limit }, async (req): Promise<SessionResponse> => {
    const parsed = sessionBody.safeParse(req.body);
    if (!parsed.success) throw badRequest('Send a valid wallet address, a timestamp and the wallet signature.');

    const wallet = getAddress(parsed.data.wallet);
    const { issuedAt } = parsed.data;
    const time = now();
    if (Math.abs(time - issuedAt) > SIGN_IN_WINDOW_SECONDS) {
      throw badRequest('This sign-in request expired. Check your device clock and try again.');
    }
    if (!(await isSignedBy(wallet, sessionMessage(wallet, issuedAt), parsed.data.signature))) {
      throw badRequest('The signature does not match this wallet.');
    }

    const { token, expiresAt } = issueSessionToken(deps.secret, wallet, time);
    return { token, wallet, expiresAt };
  });

  app.get('/api/session', { preHandler: limit }, async (req): Promise<SessionInfo> => {
    return requireSession(req, deps.secret, now());
  });
}
