// Mirror Node reads for the verifier: EVM hash to Hedera transaction ID, and EVM address to
// account ID. The indexer has its own client with backoff (indexer/mirror.ts); this one only
// needs a short, bounded poll for a transaction the server just sent.
import type { Address, Hex } from 'viem';

export interface MirrorOptions {
  fetch?: typeof fetch;
  attempts?: number;
  delayMs?: number;
}

export interface Mirror {
  /** Hedera transaction ID for an EVM hash, or null if the mirror has not caught up. */
  transactionIdOf(hash: Hex): Promise<string | null>;
  /** Hedera account ID (0.0.x) for an EVM address, or null if no such account exists. */
  accountIdOf(evmAddress: Address): Promise<string | null>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMirror(baseUrl: string, options: MirrorOptions = {}): Mirror {
  const { fetch: doFetch = fetch, attempts = 8, delayMs = 1500 } = options;

  async function getJson(path: string): Promise<unknown | null> {
    const res = await doFetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`mirror node returned ${res.status}`);
    return res.json();
  }

  // Two hops: the contract result gives the consensus timestamp, and the transaction at exactly
  // that timestamp carries the Hedera ID.
  async function lookupTransactionId(hash: Hex): Promise<string | null> {
    const result = (await getJson(`/api/v1/contracts/results/${hash}`)) as {
      timestamp?: string;
    } | null;
    if (!result?.timestamp) return null;
    const list = (await getJson(`/api/v1/transactions?timestamp=${result.timestamp}`)) as {
      transactions?: { transaction_id?: string }[];
    } | null;
    return list?.transactions?.[0]?.transaction_id ?? null;
  }

  return {
    async transactionIdOf(hash) {
      // Defaults give about ten seconds; after that the response carries only the EVM hash.
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await sleep(delayMs);
        try {
          const id = await lookupTransactionId(hash);
          if (id) return id;
        } catch {
          // Lag and HTTP 429 are normal here; the next attempt covers both.
        }
      }
      return null;
    },

    async accountIdOf(evmAddress) {
      const account = (await getJson(`/api/v1/accounts/${evmAddress}`)) as {
        account?: string;
      } | null;
      return account?.account ?? null;
    },
  };
}
