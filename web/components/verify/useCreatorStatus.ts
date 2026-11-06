'use client';

import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { HEDERA_TESTNET, creatorRegistryAbi, type Address, type CreatorDetail } from '@reputed/shared';
import { ApiRequestError, apiGet } from '@/lib/api';
import { CREATOR_REGISTRY } from '@/lib/contracts';

const POLL_MS = 2000;

/**
 * Whether this wallet is a creator. The registry answers first: the API only knows a creator once
 * the indexer has caught up, and answers 404 until then. The API is only the fallback for a failed
 * read, so a 404 there means "not found yet", which the server's own checks settle at verify time.
 */
export function useCreatorStatus(wallet: Address, polling: boolean) {
  const client = usePublicClient({ chainId: HEDERA_TESTNET.id });

  return useQuery({
    queryKey: ['is-creator', wallet],
    retry: false,
    refetchInterval: (query) => (polling && query.state.data !== true ? POLL_MS : false),
    queryFn: async ({ signal }): Promise<boolean> => {
      if (client) {
        try {
          return await client.readContract({
            address: CREATOR_REGISTRY,
            abi: creatorRegistryAbi,
            functionName: 'isCreator',
            args: [wallet],
          });
        } catch {
          // The relay is flaky, so try the API before reporting a failure.
        }
      }
      try {
        await apiGet<CreatorDetail>(`/api/creators/${wallet}`, signal);
        return true;
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) return false;
        throw err;
      }
    },
  });
}
