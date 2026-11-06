import { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ReviewBudget } from '../config.ts';
import { ApiHttpError } from '../errors.ts';

export interface RateLimit {
  max: number;
  timeWindow: number;
}

const perMinute = (max: number): RateLimit => ({ max, timeWindow: 60_000 });

export interface RateLimits {
  verifyByIp: RateLimit;
  verifyByWallet: RateLimit;
  rpSignatureByIp: RateLimit;
  agentFileByIp: RateLimit;
  reviewFileByIp: RateLimit;
  reviewFileByClient: RateLimit;
  agentListByIp: RateLimit;
  agentByIp: RateLimit;
  creatorByIp: RateLimit;
  /** Lookups of agents not scored yet: the only reads that reach the Mirror Node. */
  agentLookupByIp: RateLimit;
  /** The same for the whole process, since one client can come from many IPs. */
  agentLookupTotal: RateLimit;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  verifyByIp: perMinute(20),
  verifyByWallet: perMinute(5),
  rpSignatureByIp: perMinute(30),
  agentFileByIp: perMinute(30),
  reviewFileByIp: perMinute(20),
  reviewFileByClient: perMinute(10),
  // These three read local state. A person typing into the debounced Explorer peaks at about 200 a
  // minute, and everyone behind one NAT shares a bucket.
  agentListByIp: perMinute(300),
  agentByIp: perMinute(300),
  creatorByIp: perMinute(300),
  agentLookupByIp: perMinute(10),
  agentLookupTotal: perMinute(20),
};

type KeyOf = (req: FastifyRequest) => string;

export const byIp =
  (scope: string): KeyOf =>
  (req) =>
    `${scope}:ip:${normalizeIP(req.ip, 64)}`;

/**
 * Built on createRateLimit because app.rateLimit() marks the request as checked,
 * which silently disables a second limiter on the same route.
 */
export function limiter(app: FastifyInstance, limit: RateLimit, keyGenerator: KeyOf) {
  const check = app.createRateLimit({ ...limit, keyGenerator });
  return async (req: FastifyRequest): Promise<void> => {
    const result = await check(req);
    if (!result.isAllowed && result.isExceeded) {
      throw new ApiHttpError(
        429,
        'RATE_LIMITED',
        `Too many requests. Retry in ${result.ttlInSeconds} seconds.`,
        result.ttlInSeconds,
      );
    }
  };
}

/**
 * For an identity the handler has to prove first. Called only after that check,
 * so nobody can use up another wallet's limit by naming it in a request.
 */
export function provenLimiter(app: FastifyInstance, limit: RateLimit, scope: string) {
  const identities = new WeakMap<FastifyRequest, string>();
  const check = limiter(app, limit, (req) => `${scope}:${identities.get(req)}`);
  return (req: FastifyRequest, identity: string): Promise<void> => {
    identities.set(req, identity.toLowerCase());
    return check(req);
  };
}

const HOUR_MS = 3_600_000;
const BUSY_RETRY_SECONDS = 5;

const overBudget = (retryAfterSeconds: number) =>
  new ApiHttpError(
    503,
    'RATE_LIMITED',
    `Reviews are at capacity. Retry in ${retryAfterSeconds} seconds.`,
    retryAfterSeconds,
  );

const lookupsBusy = (retryAfterSeconds: number) =>
  new ApiHttpError(
    503,
    'RATE_LIMITED',
    `Too many agent lookups right now. Retry in ${retryAfterSeconds} seconds.`,
    retryAfterSeconds,
  );

export interface Gate {
  /** Takes a slot, or throws a 503. Call the returned function once the work ends. */
  acquire(): () => void;
}

interface GateBudget {
  max: number;
  windowMs: number;
  maxConcurrent: number;
}

function createGate(
  budget: GateBudget,
  refuse: (retryAfterSeconds: number) => ApiHttpError,
  now: () => number,
): Gate {
  let windowStart = now();
  let used = 0;
  let active = 0;

  return {
    acquire() {
      const time = now();
      if (time - windowStart >= budget.windowMs) {
        windowStart = time;
        used = 0;
      }
      if (used >= budget.max) {
        throw refuse(Math.ceil((windowStart + budget.windowMs - time) / 1000));
      }
      if (active >= budget.maxConcurrent) throw refuse(BUSY_RETRY_SECONDS);

      used++;
      active++;
      return () => {
        active--;
      };
    },
  };
}

/**
 * A new wallet costs nothing, so per-IP and per-wallet limits cannot bound what the
 * operator pays. This does, for the whole process. A failed submit stays counted
 * because it may still have been charged.
 */
export function createPublishGate(budget: ReviewBudget, now: () => number = Date.now): Gate {
  const { maxPerHour: max, maxConcurrent } = budget;
  return createGate({ max, windowMs: HOUR_MS, maxConcurrent }, overBudget, now);
}

const MAX_CONCURRENT_LOOKUPS = 2;

/** Bounds the Mirror Node reads all clients can cause, however many addresses they use. */
export function createLookupGate(limit: RateLimit, now: () => number = Date.now): Gate {
  const budget = {
    max: limit.max,
    windowMs: limit.timeWindow,
    maxConcurrent: MAX_CONCURRENT_LOOKUPS,
  };
  return createGate(budget, lookupsBusy, now);
}
