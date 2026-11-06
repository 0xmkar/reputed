import { walletBindingMessage } from '@reputed/shared';
import type { FastifyInstance } from 'fastify';
import { zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildApp, type AppDeps, type AppOptions } from '../src/app.ts';
import type { CreatorRegistryGateway, RegistrationTx } from '../src/chain.ts';
import type { ReviewBudget, WorldConfig } from '../src/config.ts';
import type { ReviewPublisher } from '../src/hedera.ts';
import { DEFAULT_RATE_LIMITS, type RateLimits } from '../src/routes/rateLimits.ts';
import { createVerificationStore } from '../src/verificationStore.ts';
import { createWorldClient } from '../src/world/client.ts';
import { walletSignalHash } from '../src/world/signing.ts';

// Throwaway keys, so requests carry real signatures.
const ACCOUNTS = ['a1', 'b2', 'c3'].map((byte) =>
  privateKeyToAccount(`0x${byte.repeat(32)}` as Hex),
);
const accountOf = (wallet: unknown) =>
  ACCOUNTS.find((account) => account.address.toLowerCase() === String(wallet).toLowerCase());

export const CREATOR_A: Address = ACCOUNTS[0]!.address;
export const CREATOR_B: Address = ACCOUNTS[1]!.address;
export const WALLET_U: Address = ACCOUNTS[2]!.address;
export const REGISTRY: Address = '0x4444444444444444444444444444444444444444';
export const IDENTITY: Address = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

export const N1 = '0x2bf8406809dcefb1486dadc96c0a897db9bab002053054cf64272db512c6fbd8';
export const N2 = '0x1bf8406809dcefb1486dadc96c0a897db9bab002053054cf64272db512c6fbd8';

/** Well-formed, but signed by nobody: a request carrying it fails only on the signature. */
export const JUNK_SIGNATURE: Hex = `0x${'11'.repeat(65)}`;

export const signMessageAs = (wallet: Address, message: string) =>
  accountOf(wallet)!.signMessage({ message });

export const signBytes = (wallet: Address, raw: Uint8Array) =>
  accountOf(wallet)!.signMessage({ message: { raw } });

export const NONCE = '0x00ab1fd2c0a14ef39b3c4a4ed7b5a8ce6a44f1e9a9c13c5ee2f8b1a7d6e43c10';

export const SESSION_SECRET = 'test-session-secret-0123456789abcdef-0123';

export const WORLD: WorldConfig = {
  apiBase: 'https://world.test',
  rpId: 'rp_test',
  signingKey: `0x${'ab'.repeat(32)}`,
  action: 'agent-creator-v1',
  environment: 'staging',
  protocolVersion: '4.0',
};

const LIMIT_OFF = { max: 100_000, timeWindow: 60_000 };
const NO_LIMITS = Object.fromEntries(
  Object.keys(DEFAULT_RATE_LIMITS).map((key) => [key, LIMIT_OFF]),
) as unknown as RateLimits;

interface ProofOptions {
  wallet?: Address;
  nullifier?: string;
  identifier?: string;
  issuerSchemaId?: number;
  protocolVersion?: string;
  action?: string;
  environment?: string;
  signalHash?: string;
  nonce?: string;
}

export function idkitResult(options: ProofOptions = {}) {
  const protocol = options.protocolVersion ?? '4.0';
  const signalHash = options.signalHash ?? walletSignalHash(options.wallet ?? CREATOR_A);
  const item =
    protocol === '4.0'
      ? {
          identifier: options.identifier ?? 'proof_of_human',
          issuer_schema_id: options.issuerSchemaId ?? 1,
          nullifier: options.nullifier ?? N1,
          expires_at_min: 49012345,
          proof: ['0x111', '0x222', '0x333', '0x444', '0x555'],
          signal_hash: signalHash,
        }
      : {
          identifier: options.identifier ?? 'orb',
          nullifier: options.nullifier ?? N1,
          merkle_root: '0x2264',
          proof: '0x1aa8',
          signal_hash: signalHash,
        };
  return {
    protocol_version: protocol,
    nonce: options.nonce ?? NONCE,
    action: options.action ?? WORLD.action,
    environment: options.environment ?? WORLD.environment,
    responses: [item],
  };
}

/** Same shape as a real v4 success, per the OpenAPI reference. */
export function worldSuccess(result: ReturnType<typeof idkitResult>) {
  const item = result.responses[0]!;
  return {
    success: true,
    action: result.action,
    nullifier: item.nullifier,
    created_at: '2026-11-06T00:00:00Z',
    environment: result.environment,
    results: [{ identifier: item.identifier, success: true, nullifier: item.nullifier }],
  };
}

export const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** In-memory stand-in for CreatorRegistry that enforces the same uniqueness rules. */
export class FakeRegistry implements CreatorRegistryGateway {
  byNullifier = new Map<Hex, Address>();
  creators = new Set<string>();
  sends = 0;
  reads = 0;
  failReads = false;
  failSends = 0;
  /** Reads see only state from before this was set, like a lagging relay. */
  frozenReads = false;
  beforeSend: () => Promise<void> = async () => undefined;

  async walletOfNullifier(nullifierHash: Hex) {
    this.reads++;
    if (this.failReads) throw new Error('relay down');
    if (this.frozenReads) return zeroAddress;
    return this.byNullifier.get(nullifierHash) ?? zeroAddress;
  }

  async isCreator(wallet: Address) {
    if (this.failReads) throw new Error('relay down');
    if (this.frozenReads) return false;
    return this.creators.has(wallet);
  }

  async registerCreator(nullifierHash: Hex, wallet: Address): Promise<RegistrationTx> {
    this.sends++;
    await this.beforeSend();
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error('relay rejected the transaction');
    }
    if (this.byNullifier.has(nullifierHash) || this.creators.has(wallet)) {
      throw new Error('execution reverted');
    }
    this.byNullifier.set(nullifierHash, wallet);
    this.creators.add(wallet);
    return {
      transactionHash: `0x${'ee'.repeat(32)}` as Hex,
      transactionId: `0.0.1234-1793960511-${this.sends}`,
    };
  }
}

export class FakePublisher implements ReviewPublisher {
  messages: Uint8Array[] = [];
  fail = false;

  async publish(message: Uint8Array) {
    if (this.fail) throw new Error('INVALID_SIGNATURE');
    this.messages.push(message);
    return { topicId: '0.0.9000', sequenceNumber: String(this.messages.length) };
  }
}

export interface Harness {
  app: FastifyInstance;
  registry: FakeRegistry;
  publisher: FakePublisher;
  worldCalls: { url: string; body: unknown }[];
  setWorld(respond: WorldHandler): void;
}

type WorldHandler = (body: ReturnType<typeof idkitResult>) => Response | Promise<Response>;

export async function harness(
  options: AppOptions & {
    world?: WorldConfig;
    trustProxy?: string[];
    reviewBudget?: ReviewBudget;
  } = {},
): Promise<Harness> {
  const registry = new FakeRegistry();
  const publisher = new FakePublisher();
  const worldCalls: Harness['worldCalls'] = [];
  let respond: WorldHandler = (body) => jsonResponse(200, worldSuccess(body));

  const world = options.world ?? WORLD;
  const fetchWorld = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    worldCalls.push({ url, body });
    return respond(body);
  }) as unknown as typeof fetch;

  const deps: AppDeps = {
    world,
    sessionSecret: SESSION_SECRET,
    identityRegistry: IDENTITY,
    corsOrigins: ['http://localhost:3000'],
    trustProxy: options.trustProxy ?? [],
    verifier: createWorldClient(world, { fetch: fetchWorld }),
    registry,
    store: createVerificationStore(':memory:', { registry: REGISTRY, action: world.action }),
    publisher,
    reviewBudget: options.reviewBudget ?? { maxPerHour: 100_000, maxConcurrent: 100_000 },
  };
  const app = await buildApp(deps, {
    readRoutes: false,
    ...options,
    rateLimits: { ...NO_LIMITS, ...options.rateLimits },
  });
  return { app, registry, publisher, worldCalls, setWorld: (handler) => (respond = handler) };
}

export function walletSignatureFor(wallet: Address, nonce = NONCE, action = WORLD.action) {
  return accountOf(wallet)!.signMessage({
    message: walletBindingMessage(wallet, action, nonce),
  });
}

interface VerifyRequestOptions {
  walletSignature?: string;
  remoteAddress?: string;
}

/** Signs as the wallet when it is a test wallet, as the web app would. */
export async function postVerify(
  app: FastifyInstance,
  wallet: unknown,
  idkitResponse: unknown,
  options: VerifyRequestOptions = {},
) {
  const nonce = (idkitResponse as { nonce?: string }).nonce ?? NONCE;
  const walletSignature =
    options.walletSignature ??
    (accountOf(wallet) ? await walletSignatureFor(wallet as Address, nonce) : JUNK_SIGNATURE);
  return app.inject({
    method: 'POST',
    url: '/api/verify',
    remoteAddress: options.remoteAddress,
    payload: { wallet, walletSignature, idkitResponse } as object,
  });
}
