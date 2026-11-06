import { getAddress, numberToHex, type Address } from 'viem';
import type { ReviewFile } from './api';

// What wallets sign. The server rebuilds these bytes to check a signature, so the web app and SDK
// must call these functions rather than build the text themselves.

/**
 * The text a wallet signs with EIP-191 for POST /api/verify. The nonce is the one from
 * /api/rp-signature, so a signature serves one request; it is padded to 32 bytes here so its
 * spelling in the IDKit result does not matter.
 */
export function walletBindingMessage(wallet: Address, action: string, nonce: string): string {
  return [
    'Reputed: bind this wallet to my World ID as a creator.',
    `Wallet: ${getAddress(wallet)}`,
    `Action: ${action}`,
    `Nonce: ${numberToHex(BigInt(nonce), { size: 32 })}`,
  ].join('\n');
}

/**
 * The text a wallet signs with EIP-191 for POST /api/session. It binds the wallet to a time, so
 * the signature is good for one sign-in within a few minutes and is no use for anything else.
 */
export function sessionMessage(wallet: Address, issuedAt: number): string {
  return [
    'Reputed: sign in with this wallet.',
    `Wallet: ${getAddress(wallet)}`,
    `Issued at: ${issuedAt}`,
    'This costs nothing and sends no transaction.',
  ].join('\n');
}

function checksummedCaip(caip: string): string {
  const split = caip.lastIndexOf(':') + 1;
  return `${caip.slice(0, split)}${getAddress(caip.slice(split))}`;
}

/**
 * The review file as published to HCS, with a fixed key order so one review always gives the same
 * bytes. clientAddress signs exactly these bytes with EIP-191 (`message: { raw: bytes }`) for
 * POST /api/review-file, and their keccak-256 is feedbackHash.
 */
export function serializeReviewFile(file: ReviewFile): Uint8Array {
  const agentId = BigInt(file.agentId);
  return new TextEncoder().encode(
    JSON.stringify({
      agentRegistry: checksummedCaip(file.agentRegistry),
      agentId: agentId <= Number.MAX_SAFE_INTEGER ? Number(agentId) : agentId.toString(),
      clientAddress: checksummedCaip(file.clientAddress),
      createdAt: file.createdAt,
      value: file.value,
      valueDecimals: file.valueDecimals,
      tag1: file.tag1,
      tag2: file.tag2,
      endpoint: file.endpoint,
      comment: file.comment,
      proofOfPayment: file.proofOfPayment,
    }),
  );
}
