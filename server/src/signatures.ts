import { verifyMessage, type Address, type Hex, type SignableMessage } from 'viem';
import { z } from 'zod';

/** A 65-byte EIP-191 signature, as wallets return it. */
export const signatureSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{130}$/)
  .transform((v) => v as Hex);

/** False, rather than a throw, for a signature that recovers to nothing. */
export async function isSignedBy(
  address: Address,
  message: SignableMessage,
  signature: Hex,
): Promise<boolean> {
  try {
    return await verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
}
