// POST /api/verify: one World ID proof plus a wallet signature becomes one on-chain creator.
// Checks run cheapest first: body shape, local proof policy (no network), per-wallet limit,
// in-flight claim, local store, contract reads, World's verifier, then the transaction. A
// malformed request costs nothing, and World's verifier and the transaction only see requests
// that passed everything else.
import type { VerifyResponse } from '@reputed/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { CreatorRegistryGateway, RegistrationTx } from '../chain.ts';
import type { WorldConfig } from '../config.ts';
import {
  ApiHttpError,
  badRequest,
  chainError,
  invalidProof,
  logReason,
  worldUnavailable,
} from '../errors.ts';
import { signatureSchema } from '../signatures.ts';
import type { VerificationStore } from '../verificationStore.ts';
import type { WorldVerifier } from '../world/client.ts';
import {
  checkProofPolicy,
  idkitResultSchema,
  type CheckedProof,
  type IdkitResult,
} from '../world/proof.ts';
import { byIp, limiter, provenLimiter, type RateLimits } from './rateLimits.ts';

const verifyBody = z.object({
  wallet: z.string().refine((v) => isAddress(v, { strict: false }) && BigInt(v) !== 0n),
  /** EIP-191 signature by `wallet` over walletBindingMessage. */
  walletSignature: signatureSchema,
  idkitResponse: idkitResultSchema,
});

const alreadyRegistered = (wallet: Address) =>
  new ApiHttpError(
    409,
    'ALREADY_REGISTERED',
    `This World ID already has a creator wallet (${wallet}). Connect that wallet instead.`,
  );

const walletTaken = () =>
  new ApiHttpError(409, 'WALLET_TAKEN', 'This wallet already belongs to another creator.');

export interface VerifyDeps {
  world: WorldConfig;
  verifier: WorldVerifier;
  registry: CreatorRegistryGateway;
  store: VerificationStore;
  rateLimits: RateLimits;
}

export function registerVerifyRoute(app: FastifyInstance, deps: VerifyDeps): void {
  const { rateLimits } = deps;
  const limitWallet = provenLimiter(app, rateLimits.verifyByWallet, 'verify:wallet');

  // Without this, two requests for one nullifier or wallet both pass the checks
  // below before either transaction lands. The contract would still reject the
  // second, but only after the verifier paid for it.
  const inFlight = new Set<string>();

  function claim(nullifierHash: Hex, wallet: Address): () => void {
    const keys = [`n:${nullifierHash}`, `w:${wallet}`];
    if (inFlight.has(keys[0]!)) {
      throw new ApiHttpError(
        409,
        'ALREADY_REGISTERED',
        'A registration for this World ID is already in progress.',
      );
    }
    if (inFlight.has(keys[1]!)) {
      throw new ApiHttpError(
        409,
        'WALLET_TAKEN',
        'A registration for this wallet is already in progress.',
      );
    }
    keys.forEach((key) => inFlight.add(key));
    return () => keys.forEach((key) => inFlight.delete(key));
  }

  app.post(
    '/api/verify',
    { preHandler: limiter(app, rateLimits.verifyByIp, byIp('verify')) },
    async (req): Promise<VerifyResponse> => {
      const parsed = verifyBody.safeParse(req.body);
      if (!parsed.success) {
        throw badRequest(
          'Send a valid wallet address, its wallet signature and the complete IDKit result.',
        );
      }
      const wallet = getAddress(parsed.data.wallet);
      const result = parsed.data.idkitResponse;
      const proof = await checkProofPolicy(
        result,
        wallet,
        parsed.data.walletSignature,
        deps.world,
      );
      // After checkProofPolicy, which verified the wallet signature: see provenLimiter.
      await limitWallet(req, wallet);

      const release = claim(proof.nullifierHash, wallet);
      try {
        return await verifyAndRegister(deps, req.log, wallet, result, proof);
      } finally {
        release();
      }
    },
  );
}

async function readChainState(registry: CreatorRegistryGateway, proof: CheckedProof, wallet: Address) {
  const [existing, walletIsCreator] = await Promise.all([
    registry.walletOfNullifier(proof.nullifierHash),
    registry.isCreator(wallet),
  ]);
  return { existing, walletIsCreator };
}

async function verifyAndRegister(
  deps: VerifyDeps,
  log: FastifyBaseLogger,
  wallet: Address,
  result: IdkitResult,
  proof: CheckedProof,
): Promise<VerifyResponse> {
  const { registry, store, verifier } = deps;
  const { nullifierHash } = proof;

  // Local store first: a registration seconds old is not yet visible through the relay.
  const known = store.byNullifier(nullifierHash);
  if (known?.status === 'registered') throw alreadyRegistered(known.wallet);
  if (store.isRegisteredWallet(wallet)) throw walletTaken();

  let chain: Awaited<ReturnType<typeof readChainState>>;
  try {
    chain = await readChainState(registry, proof, wallet);
  } catch (err) {
    log.error({ nullifierHash, reason: logReason(err) }, 'contract read failed');
    throw chainError('Could not read the creator registry. Try again.');
  }
  if (chain.existing !== zeroAddress) throw alreadyRegistered(chain.existing);
  if (chain.walletIsCreator) throw walletTaken();

  // Only the wallet of an attempt that passed World may skip it. A row for another
  // wallet is stale, as nothing reached the chain: this proof must pass on its own.
  if (known?.wallet !== wallet) {
    const verdict = await verifier.verify(result, proof);
    switch (verdict.kind) {
      case 'verified':
        store.saveVerified(nullifierHash, wallet);
        break;
      case 'invalid':
        throw invalidProof('World ID rejected this proof.');
      case 'unavailable':
        throw worldUnavailable();
    }
  }

  let tx: RegistrationTx;
  try {
    tx = await registry.registerCreator(nullifierHash, wallet);
  } catch (err) {
    log.error({ nullifierHash, reason: logReason(err) }, 'registerCreator failed');
    // Lost a race to another server, or the revert explains itself on a re-read.
    const after = await readChainState(registry, proof, wallet).catch(() => undefined);
    if (after && after.existing !== zeroAddress) {
      store.saveRegistered(nullifierHash, after.existing);
      throw alreadyRegistered(after.existing);
    }
    if (after?.walletIsCreator) throw walletTaken();
    throw chainError();
  }

  store.saveRegistered(nullifierHash, wallet);
  log.info({ transactionId: tx.transactionId ?? tx.transactionHash, nullifierHash }, 'creator registered');
  return { ...tx, wallet, nullifierHash };
}
