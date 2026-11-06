import { walletBindingMessage } from '@reputed/shared';
import { numberToHex, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { WorldConfig } from '../config.ts';
import { invalidProof } from '../errors.ts';
import { isSignedBy } from '../signatures.ts';
import { walletSignalHash } from './signing.ts';

// BN254 scalar field. A value at or above this aliases a smaller one inside the
// circuit, so it could pose as a second nullifier for the same human.
const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const HEX_NUMBER = /^0x[0-9a-fA-F]{1,64}$/;

export const idkitResultSchema = z.looseObject({
  protocol_version: z.string(),
  nonce: z.string().min(1),
  action: z.string().optional(),
  environment: z.string().optional(),
  responses: z
    .array(
      z.looseObject({
        identifier: z.string(),
        issuer_schema_id: z.number().optional(),
        nullifier: z.string().optional(),
        signal_hash: z.string().optional(),
      }),
    )
    .min(1),
});

export type IdkitResult = z.infer<typeof idkitResultSchema>;

export interface CheckedProof {
  identifier: string;
  nullifier: bigint;
  /** Canonical bytes32: every padding and casing of a nullifier maps to this one value. */
  nullifierHash: Hex;
}

// World's verifier also takes a faux issuer for proof_of_human outside production.
const STAGING_ISSUER = 128;

function isOrbCredential(
  protocolVersion: string,
  item: IdkitResult['responses'][number],
  environment: WorldConfig['environment'],
): boolean {
  if (protocolVersion !== '4.0') return item.identifier === 'orb';
  if (item.identifier !== 'proof_of_human') return false;
  return (
    item.issuer_schema_id === 1 ||
    (environment !== 'production' && item.issuer_schema_id === STAGING_ISSUER)
  );
}

/**
 * Everything World's verify endpoint will not enforce for us. World checks the
 * proof against the signal_hash in the payload, and IDKit fills that field in on
 * the client, so the wallet binding has to be compared here. An address is public,
 * so the signal alone would let anyone claim someone else's wallet for good: the
 * wallet has to sign as well.
 */
export async function checkProofPolicy(
  result: IdkitResult,
  wallet: Address,
  walletSignature: Hex,
  world: Pick<WorldConfig, 'action' | 'environment' | 'protocolVersion'>,
): Promise<CheckedProof> {
  if (result.environment !== world.environment) {
    throw invalidProof(`Proof is for the wrong World ID environment. Expected ${world.environment}.`);
  }
  if (result.action !== world.action) {
    throw invalidProof('Proof is for a different World ID action.');
  }
  // A human's 3.0 and 4.0 nullifiers differ, so accepting both would let them register twice.
  if (result.protocol_version !== world.protocolVersion) {
    throw invalidProof(`Only World ID protocol ${world.protocolVersion} proofs are accepted.`);
  }
  // World answers 200 when any one response verifies, so a second response could
  // ride along unchecked.
  const [item, ...rest] = result.responses;
  if (!item || rest.length > 0) {
    throw invalidProof('Exactly one credential response is required.');
  }
  if (!isOrbCredential(result.protocol_version, item, world.environment)) {
    throw invalidProof(
      `The "${item.identifier}" credential is not accepted. Orb verification is required.`,
    );
  }

  const signalHash = item.signal_hash;
  if (
    signalHash === undefined ||
    !HEX_NUMBER.test(signalHash) ||
    BigInt(signalHash) !== BigInt(walletSignalHash(wallet))
  ) {
    throw invalidProof('This proof was generated for a different wallet.');
  }

  const raw = item.nullifier;
  if (raw === undefined || !HEX_NUMBER.test(raw)) {
    throw invalidProof('The proof has no valid nullifier. Session proofs are not accepted.');
  }
  const nullifier = BigInt(raw);
  if (nullifier === 0n || nullifier >= FIELD_MODULUS) {
    throw invalidProof('The proof has no valid nullifier.');
  }

  if (!HEX_NUMBER.test(result.nonce)) throw invalidProof('The proof has no valid nonce.');
  const message = walletBindingMessage(wallet, world.action, result.nonce);
  if (!(await isSignedBy(wallet, message, walletSignature))) {
    throw invalidProof('The wallet signature does not match this wallet and request.');
  }

  return {
    identifier: item.identifier,
    nullifier,
    nullifierHash: numberToHex(nullifier, { size: 32 }),
  };
}
