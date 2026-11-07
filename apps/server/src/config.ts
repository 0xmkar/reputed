// Environment parsing. Every variable is validated up front and all problems are reported
// together, by name only, so a secret never appears in a startup error. Format checks here
// catch keys that a library would accept and then fail with, or silently reinterpret as a
// different key, at first use.
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { HEDERA_TESTNET, IDENTITY_REGISTRY } from '@reputed/shared';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(missing: string[], invalid: string[]) {
    const parts = [
      missing.length ? `missing: ${missing.join(', ')}` : '',
      invalid.length ? `invalid: ${invalid.join(', ')}` : '',
    ].filter(Boolean);
    super(`Server configuration error. ${parts.join('; ')}`);
    this.name = 'ConfigError';
  }
}

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }))
  .transform((v): Address => getAddress(v));

// Inside a refine, because viem's out-of-range error prints the value it rejected.
function isCurveKey(key: Hex): boolean {
  try {
    privateKeyToAccount(key);
    return true;
  } catch {
    return false;
  }
}

const privateKey = z
  .string()
  .regex(/^(0x)?[0-9a-fA-F]{64}$/)
  .transform((v): Hex => (v.startsWith('0x') ? (v as Hex) : `0x${v}`))
  .refine(isCurveKey);

const topicId = z.string().regex(/^\d+\.\d+\.\d+$/);

// fromStringECDSA silently turns an ED25519 key, or a key with trailing junk, into
// a different key, so the format is checked here. The DER prefix is what tells the
// curves apart; a raw ED25519 key has the same shape as a raw ECDSA one and still
// passes, then fails at first use.
const OPERATOR_KEY_FORMAT = /^(0x)?(3030020100300706052b8104000a04220420)?[0-9a-fA-F]{64}$/;

const ecdsaOperatorKey = z
  .string()
  .regex(OPERATOR_KEY_FORMAT)
  .refine((v) => isCurveKey(`0x${v.slice(-64)}`));

function isProxyAddress(entry: string): boolean {
  const [ip = '', prefix, ...rest] = entry.split('/');
  const family = isIP(ip);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  // A /0 trusts every peer, which hands req.ip to whoever sets X-Forwarded-For.
  return /^\d+$/.test(prefix) && Number(prefix) > 0 && Number(prefix) <= (family === 4 ? 32 : 128);
}

const proxyList = z
  .string()
  .transform((v) => v.split(',').map((entry) => entry.trim()))
  .refine((entries) => entries.every(isProxyAddress));

const hederaSchema = z.object({
  OPERATOR_KEY: ecdsaOperatorKey,
  OPERATOR_ID: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  MIRROR_NODE: z.url().default(HEDERA_TESTNET.mirrorNode),
});

const serverSchema = hederaSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  // IPs or CIDRs of the proxies in front of this server, comma separated: 127.0.0.1
  // for an ngrok agent on this machine. req.ip is then the rightmost address not on
  // the list, which the client cannot forge. Fastify ignores hop counts, and `true`
  // would believe the leftmost address, which the client writes.
  TRUST_PROXY: proxyList.default([]),
  RPC_URL: z.url().default(HEDERA_TESTNET.rpcUrl),
  IDENTITY_REGISTRY: address.default(IDENTITY_REGISTRY),
  CREATOR_REGISTRY: address,
  VERIFIER_KEY: privateKey,
  REVIEWS_TOPIC_ID: topicId,
  // The scorer reads these two itself. They are here so one message lists everything missing.
  SCORES_TOPIC_ID: topicId,
  CREDENTIAL_TOKEN_ID: topicId,
  VERIFIER_DB_PATH: z.string().min(1).default('cache/verifier.sqlite'),
  WORLD_API_BASE: z.url().default('https://developer.world.org'),
  // IDKit refuses anything else in rp_context, even though the verify URL allows app_.
  WORLD_RP_ID: z.string().regex(/^rp_[0-9a-fA-F]{1,16}$/),
  RP_SIGNING_KEY: privateKey,
  // Signs session tokens. Unset, one is derived from RP_SIGNING_KEY, which keeps it stable across restarts.
  SESSION_SECRET: z.string().min(32).optional(),
  WORLD_ACTION: z.string().min(1).default('agent-creator-v1'),
  // Deliberately no defaults: accepting a staging proof in production, or both
  // protocol versions at once, breaks one-human-one-creator.
  WORLD_ENVIRONMENT: z.enum(['production', 'staging', 'sandbox']),
  WORLD_PROTOCOL_VERSION: z.enum(['3.0', '4.0']),
  // Every posted review is paid for by the operator, whoever asked for it.
  REVIEW_MAX_PER_HOUR: z.coerce.number().int().positive().default(500),
  REVIEW_MAX_CONCURRENT: z.coerce.number().int().positive().default(4),
});

type Env = Record<string, string | undefined>;

function parseEnv<S extends z.ZodType>(schema: S, env: Env): z.output<S> {
  // An empty string counts as unset, so `KEY=` in a .env file reads as missing, not invalid.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (parsed.success) return parsed.data;

  // Names only: issue messages and inputs can carry the rejected value.
  const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
  throw new ConfigError(
    names.filter((name) => cleaned[name] === undefined),
    names.filter((name) => cleaned[name] !== undefined),
  );
}

export interface HederaConfig {
  operatorKey: string;
  operatorId?: string;
  mirrorNode: string;
}

export interface WorldConfig {
  apiBase: string;
  rpId: string;
  signingKey: Hex;
  action: string;
  environment: 'production' | 'staging' | 'sandbox';
  protocolVersion: '3.0' | '4.0';
}

export interface ReviewBudget {
  maxPerHour: number;
  maxConcurrent: number;
}

export interface AppConfig extends HederaConfig {
  port: number;
  corsOrigins: string[];
  trustProxy: string[];
  rpcUrl: string;
  identityRegistry: Address;
  creatorRegistry: Address;
  verifierKey: Hex;
  reviewsTopicId: string;
  verifierDbPath: string;
  world: WorldConfig;
  sessionSecret: string;
  reviewBudget: ReviewBudget;
}

export function loadHederaConfig(env: Env = process.env): HederaConfig {
  const v = parseEnv(hederaSchema, env);
  return { operatorKey: v.OPERATOR_KEY, operatorId: v.OPERATOR_ID, mirrorNode: v.MIRROR_NODE };
}

export function loadConfig(env: Env = process.env): AppConfig {
  const v = parseEnv(serverSchema, env);
  return {
    operatorKey: v.OPERATOR_KEY,
    operatorId: v.OPERATOR_ID,
    mirrorNode: v.MIRROR_NODE,
    port: v.PORT,
    corsOrigins: v.CORS_ORIGINS.split(',').map((origin) => origin.trim()),
    trustProxy: v.TRUST_PROXY,
    rpcUrl: v.RPC_URL,
    identityRegistry: v.IDENTITY_REGISTRY,
    creatorRegistry: v.CREATOR_REGISTRY,
    verifierKey: v.VERIFIER_KEY,
    reviewsTopicId: v.REVIEWS_TOPIC_ID,
    verifierDbPath: v.VERIFIER_DB_PATH,
    world: {
      apiBase: v.WORLD_API_BASE,
      rpId: v.WORLD_RP_ID,
      signingKey: v.RP_SIGNING_KEY,
      action: v.WORLD_ACTION,
      environment: v.WORLD_ENVIRONMENT,
      protocolVersion: v.WORLD_PROTOCOL_VERSION,
    },
    sessionSecret:
      v.SESSION_SECRET ?? createHmac('sha256', v.RP_SIGNING_KEY).update('reputed:session:v1').digest('hex'),
    reviewBudget: {
      maxPerHour: v.REVIEW_MAX_PER_HOUR,
      maxConcurrent: v.REVIEW_MAX_CONCURRENT,
    },
  };
}
