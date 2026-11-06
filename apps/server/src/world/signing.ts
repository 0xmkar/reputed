import { randomBytes } from 'node:crypto';
import {
  concat,
  hexToBytes,
  keccak256,
  numberToBytes,
  numberToHex,
  stringToBytes,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Implements https://docs.world.org/world-id/idkit/signatures, checked against
// that page's test vectors. Same algorithm as @worldcoin/idkit-core 4.6.0.

export function hashToField(input: Uint8Array): Hex {
  return numberToHex(BigInt(keccak256(input)) >> 8n, { size: 32 });
}

/**
 * IDKit reads a 0x-prefixed signal as raw bytes, on both the 4.0 and legacy
 * paths, so the wallet's letter case does not change the hash.
 */
export function walletSignalHash(wallet: Address): Hex {
  return hashToField(hexToBytes(wallet));
}

export function rpSignatureMessage(
  nonce: Hex,
  createdAt: number,
  expiresAt: number,
  action?: string,
): Uint8Array {
  const parts = [
    Uint8Array.of(0x01),
    hexToBytes(nonce),
    numberToBytes(createdAt, { size: 8 }),
    numberToBytes(expiresAt, { size: 8 }),
  ];
  if (action !== undefined) parts.push(hexToBytes(hashToField(stringToBytes(action))));
  return concat(parts);
}

export interface RpSignature {
  sig: Hex;
  nonce: Hex;
  createdAt: number;
  expiresAt: number;
}

export interface SignRequestInput {
  signingKey: Hex;
  action: string;
  ttlSeconds?: number;
  /** Fixed inputs for the spec's test vectors. */
  random?: Uint8Array;
  nowSeconds?: number;
}

export async function signRpRequest(input: SignRequestInput): Promise<RpSignature> {
  const { signingKey, action, ttlSeconds = 300 } = input;
  const nonce = hashToField(input.random ?? randomBytes(32));
  const createdAt = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt = createdAt + ttlSeconds;

  const message = rpSignatureMessage(nonce, createdAt, expiresAt, action);
  // signMessage applies the EIP-191 prefix over the raw bytes and returns r||s||v, v in {27,28}.
  const sig = await privateKeyToAccount(signingKey).signMessage({ message: { raw: message } });
  return { sig, nonce, createdAt, expiresAt };
}
