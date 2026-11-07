// Every error leaves the server as {code, message}. ApiHttpError carries a code from the
// shared enum; Fastify's own errors (bad JSON, a 404, a 429 from the limiter) are mapped onto
// the same vocabulary here so clients switch on one set of codes.
import type { FastifyError, FastifyInstance } from 'fastify';
import type { ApiErrorCode } from '@reputed/shared';

export class ApiHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export const badRequest = (message: string) => new ApiHttpError(400, 'BAD_REQUEST', message);
export const invalidProof = (message: string) => new ApiHttpError(400, 'INVALID_PROOF', message);
export const worldUnavailable = () =>
  new ApiHttpError(502, 'WORLD_UNAVAILABLE', 'World ID verification is unavailable. Try again.');
export const chainError = (message = 'The Hedera transaction failed. Try again.') =>
  new ApiHttpError(502, 'CHAIN_ERROR', message);

/**
 * A reason safe to log: viem's shortMessage or the Hedera status says why a call
 * failed, for example an empty balance, but decoded revert data can name a wallet.
 */
export function logReason(err: unknown): string {
  const { name, shortMessage, status } = err as {
    name?: string;
    shortMessage?: string;
    status?: unknown;
  };
  const reason = shortMessage ?? (status ? `${name}: ${String(status)}` : (name ?? 'Error'));
  return reason.replace(/0x[0-9a-fA-F]{40}\b/g, '<address>');
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found.' });
  });

  app.setErrorHandler((err: FastifyError | ApiHttpError, req, reply) => {
    if (err instanceof ApiHttpError) {
      if (err.retryAfterSeconds !== undefined) reply.header('retry-after', err.retryAfterSeconds);
      return reply.code(err.statusCode).send({ code: err.code, message: err.message });
    }
    const status = err.statusCode ?? 500;
    if (status === 429) {
      return reply.code(429).send({ code: 'RATE_LIMITED', message: 'Too many requests.' });
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ code: 'BAD_REQUEST', message: err.message });
    }
    // Only a 5xx is logged, and only its scrubbed reason: 4xx are the client's mistakes.
    req.log.error({ reason: logReason(err) }, 'unhandled error');
    return reply.code(500).send({ code: 'INTERNAL_ERROR', message: 'Internal server error.' });
  });
}
