import { BaseError, UserRejectedRequestError, isAddressEqual, type Address } from 'viem';
import { ApiRequestError } from '@/lib/api';
import { shortAddress } from '@/lib/format';

/**
 * How Retry recovers. `resend` posts the same proof again, and `restart` asks for a new one.
 * The World ID action allows one verification per person, so once World has accepted a proof a
 * new scan can be refused. Only a proof that is itself bad should cost the user a rescan.
 */
export type RetryMode = 'restart' | 'resend';

export interface Failure {
  message: string;
  /** Why it failed, when that helps more than the plain message. */
  detail?: string;
  /** Absent when retrying cannot help, for example when the World ID has another wallet. */
  retry?: RetryMode;
}

const TRY_AGAIN = "Verification didn't go through. Try again.";
const TOO_MANY = 'Too many attempts. Wait a minute, then retry.';

export const SIGNATURE_REJECTED: Failure = { message: 'Cancelled in your wallet.', retry: 'restart' };
export const REQUEST_EXPIRED: Failure = { message: 'This request expired. Try again.', retry: 'restart' };

export function describeSignatureError(err: unknown): Failure {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return SIGNATURE_REJECTED;
    return { message: err.shortMessage, retry: 'restart' };
  }
  const message = err instanceof Error ? (err.message.split('\n')[0] ?? '') : '';
  if (/user (rejected|denied)/i.test(message)) return SIGNATURE_REJECTED;
  return { message: message || 'Your wallet could not sign the message.', retry: 'restart' };
}

/** POST /api/rp-signature failed, so nothing has been signed or proved yet. */
export function describeStartError(err: unknown): Failure {
  if (err instanceof ApiRequestError && err.body?.code === 'RATE_LIMITED') {
    return { message: TOO_MANY, retry: 'restart' };
  }
  return { message: 'Could not reach the Reputed server. Check your connection and retry.', retry: 'restart' };
}

/** The server gives the existing wallet only inside its message: ApiError has no field for it. */
function walletInMessage(message: string): Address | null {
  return (message.match(/0x[0-9a-fA-F]{40}/)?.[0] as Address | undefined) ?? null;
}

/**
 * POST /api/verify failed. Returns 'registered' when the failure proves this wallet is already the
 * creator: the server answers ALREADY_REGISTERED with this same wallet when an earlier attempt
 * landed but its receipt poll failed, so that is a success still waiting to show on the Mirror Node.
 */
export function describeVerifyError(err: unknown, wallet: Address): Failure | 'registered' {
  if (!(err instanceof ApiRequestError)) {
    return { message: 'Could not reach the Reputed server. Retry to send your proof again.', retry: 'resend' };
  }

  const serverMessage = err.body?.message ?? '';
  switch (err.body?.code) {
    case 'ALREADY_REGISTERED': {
      const existing = walletInMessage(serverMessage);
      if (!existing) return { message: serverMessage, retry: 'resend' }; // Still in progress.
      if (isAddressEqual(existing, wallet)) return 'registered';
      return {
        message: `This World ID already has a creator wallet (${shortAddress(existing)}). Connect that wallet instead.`,
      };
    }
    case 'WALLET_TAKEN':
      return /in progress/i.test(serverMessage)
        ? { message: serverMessage, retry: 'resend' }
        : { message: 'This wallet already belongs to another creator.' };
    case 'INVALID_PROOF':
    case 'BAD_REQUEST':
      return { message: TRY_AGAIN, detail: serverMessage || undefined, retry: 'restart' };
    case 'WORLD_UNAVAILABLE':
      return { message: TRY_AGAIN, retry: 'resend' };
    case 'RATE_LIMITED':
      return { message: TOO_MANY, retry: 'resend' };
    case 'CHAIN_ERROR':
      return { message: serverMessage || 'The Hedera transaction failed. Try again.', retry: 'resend' };
    default:
      return { message: TRY_AGAIN, retry: 'resend' };
  }
}

/** A failure inside the IDKit modal. No proof exists yet, so every retry starts over. */
export function describeWorldError(code: string): Failure {
  switch (code) {
    case 'user_rejected':
    case 'verification_rejected':
    case 'cancelled':
      return { message: 'Cancelled in World App.', retry: 'restart' };
    case 'credential_unavailable':
      return { message: 'This World ID has no Orb verification. Verify at an Orb, then try again.', retry: 'restart' };
    case 'world_id_3_not_available':
    case 'world_id_4_not_available':
      return { message: "World App can't answer this request. Update World App, then try again.", retry: 'restart' };
    case 'inclusion_proof_pending':
      return { message: 'Your World ID is still being set up. Try again in a few minutes.', retry: 'restart' };
    case 'max_verifications_reached':
    case 'nullifier_replayed':
      return { message: 'This World ID has already verified. Connect the wallet you verified with.' };
    case 'timeout':
    case 'rp_signature_expired':
    case 'timestamp_too_old':
      return REQUEST_EXPIRED;
    default:
      return { message: TRY_AGAIN, detail: `World ID reported: ${code}`, retry: 'restart' };
  }
}
