import { pad, type Address, type Hex } from 'viem';
import { HEDERA_TESTNET, IDENTITY_REGISTRY } from '@reputed/shared';
import { REGISTERED, agentIdFromLogs, agentUriFromLog } from './agentLogs';
import type { TxLog } from './confirmTx';

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

interface MirrorTokens {
  tokens: { automatic_association: boolean }[];
}

/** What a wallet needs before it can hold the credential. */
export type HolderState =
  /** The token is already on the account. */
  | 'associated'
  /** The account will take the token by itself when the credential arrives. */
  | 'auto'
  /** The wallet has to call `associate()` first, or linkAgent reverts with 184 or 262. */
  | 'needs-association'
  /** No Hedera account at this address, so linkAgent would revert with 15. */
  | 'no-account';

/**
 * Why an address can't sign for an agent, ready to show, or null when it can. It needs a Hedera
 * account with an ECDSA key.
 */
export async function checkAgentWallet(address: Address, signal?: AbortSignal): Promise<string | null> {
  const account = await mirrorGet<MirrorAccount>(`/accounts/${address}?transactions=false`, signal);
  if (!account) return 'This address has no Hedera account yet. Send it some HBAR, then try again.';
  // A hollow account has no key on record yet, and it still signs with the key behind its address.
  if (account.key && account.key._type !== 'ECDSA_SECP256K1') return 'This account has no ECDSA key, so it cannot sign for an agent.';
  if (account.evm_address?.toLowerCase() !== address.toLowerCase()) return `Use this account's EVM address, ${account.evm_address}.`;
  return null;
}

export async function fetchHolderState(address: Address, tokenId: string, signal?: AbortSignal): Promise<HolderState> {
  const account = await mirrorGet<MirrorAccount>(`/accounts/${address}?transactions=false`, signal);
  if (!account) return 'no-account';

  const held = await mirrorGet<MirrorTokens>(`/accounts/${account.account}/tokens?token.id=${tokenId}`, signal);
  if (held?.tokens.length) return 'associated';

  const slots = account.max_automatic_token_associations;
  if (slots === -1) return 'auto';
  if (slots === 0) return 'needs-association';
  const all = await mirrorGet<MirrorTokens>(`/accounts/${account.account}/tokens?limit=100`, signal);
  const used = (all?.tokens ?? []).filter((token) => token.automatic_association).length;
  return used < slots ? 'auto' : 'needs-association';
}

/** Consensus time of the latest block in seconds, or null if it can't be read quickly. */
export async function latestBlockTime(): Promise<bigint | null> {
  try {
    const body = await mirrorGet<{ blocks: { timestamp: { to: string } }[] }>('/blocks?limit=1&order=desc', AbortSignal.timeout(3_000));
    const seconds = body?.blocks[0]?.timestamp.to.split('.')[0];
    return seconds ? BigInt(seconds) : null;
  } catch {
    return null;
  }
}

interface MirrorLogs {
  logs?: { address: Address; topics: Hex[]; data: Hex | null }[];
}

const SEARCH_MARGIN_SECONDS = 60;
const MAX_SEARCH_SECONDS = 6 * 24 * 3600; // The Mirror Node allows a topic search over at most 7 days.

/**
 * Looks for a registration whose transaction hash we never received, for example because the tab
 * closed first. Matching the URI means another agent this wallet registered is not mistaken for it.
 */
export async function findRegistration(owner: Address, agentUri: string, sinceMs: number, signal?: AbortSignal): Promise<string | null> {
  const from = Math.floor(sinceMs / 1000) - SEARCH_MARGIN_SECONDS;
  const to = Math.min(Math.ceil(Date.now() / 1000) + SEARCH_MARGIN_SECONDS, from + MAX_SEARCH_SECONDS);
  const query = new URLSearchParams({ topic0: REGISTERED, topic2: pad(owner.toLowerCase() as Hex), order: 'desc', limit: '25' });
  const body = await mirrorGet<MirrorLogs>(
    `/contracts/${IDENTITY_REGISTRY}/results/logs?${query}&timestamp=gte:${from}&timestamp=lte:${to}`,
    signal,
  );
  for (const { address, topics, data } of body?.logs ?? []) {
    const log: TxLog = { address, topics, data: data ?? '0x' };
    if (agentUriFromLog(log) === agentUri) return agentIdFromLogs([log]);
  }
  return null;
}
