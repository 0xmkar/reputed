import type { Address } from 'viem';
import { HEDERA_TESTNET } from '@reputed/shared';

const MIRROR = `${HEDERA_TESTNET.mirrorNode}/api/v1`;

async function mirrorGet<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  const res = await fetch(`${MIRROR}${path}`, { signal, cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mirror Node answered ${res.status}`);
  return (await res.json()) as T;
}

interface MirrorAccount {
  account: string;
  evm_address: string | null;
  key: { _type: string } | null;
  max_automatic_token_associations: number;
}

/** Why an address can't make EVM signatures the API accepts, or null when it can. */
type AccountProblem =
  | { kind: 'no-account' }
  | { kind: 'not-ecdsa'; keyType: string }
  /** The wallet uses the long-zero address, but signatures recover to the key's EVM address. */
  | { kind: 'wrong-address'; evmAddress: string | null };

async function accountProblem(address: Address, signal?: AbortSignal): Promise<AccountProblem | null> {
  const account = await mirrorGet<MirrorAccount>(`/accounts/${address}?transactions=false`, signal);
  if (!account) return { kind: 'no-account' };
  // A hollow account has no key on record yet, and it still signs with the key behind its address.
  if (account.key && account.key._type !== 'ECDSA_SECP256K1') return { kind: 'not-ecdsa', keyType: account.key._type };
  if (account.evm_address?.toLowerCase() !== address.toLowerCase()) return { kind: 'wrong-address', evmAddress: account.evm_address };
  return null;
}

/**
 * Why the connected wallet can't use Reputed, ready to show, or null when it can. HashPack's default
 * accounts are Ed25519, and their signatures can't be checked as EVM signatures.
 */
export async function checkConnectedWallet(address: Address, signal?: AbortSignal): Promise<string | null> {
  const problem = await accountProblem(address, signal);
  switch (problem?.kind) {
    case undefined:
      return null;
    case 'no-account':
      return 'This address has no Hedera testnet account yet. Fund it from the testnet faucet before you sign anything.';
    case 'not-ecdsa':
      return `This account uses an ${problem.keyType === 'ED25519' ? 'Ed25519' : problem.keyType} key. Reputed needs an ECDSA account: switch to one in your wallet, or create one in HashPack.`;
    case 'wrong-address':
      return problem.evmAddress
        ? `Your wallet is using this account's long-zero address. Connect with its EVM address, ${problem.evmAddress}, instead.`
        : 'Your wallet is using a long-zero address. Connect with an ECDSA account that has an EVM address instead.';
  }
}
