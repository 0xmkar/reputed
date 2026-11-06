import { BaseError, InsufficientFundsError, UserRejectedRequestError } from 'viem';

const TOP_UP = 'Not enough HBAR. Top up from the testnet faucet.';

/** Plain language for anything a wallet or relay throws, and whether the user simply said no. */
export function describeWalletError(err: unknown): { rejected: boolean; message: string } {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return { rejected: true, message: '' };
    if (err.walk((e) => e instanceof InsufficientFundsError)) return { rejected: false, message: TOP_UP };
    if (/insufficient (funds|balance|payer|account)/i.test(err.message)) return { rejected: false, message: TOP_UP };
    return { rejected: false, message: err.shortMessage };
  }
  const message = err instanceof Error ? (err.message.split('\n')[0] ?? 'Something went wrong.') : 'Something went wrong.';
  return { rejected: /user (rejected|denied)/i.test(message), message };
}
