'use client';

import { useQuery } from '@tanstack/react-query';
import type { Address, CreatorDetail } from '@reputed/shared';
import { ApiRequestError, apiGet } from './api';

/**
 * Looks the wallet up in the creator registry through the server.
 * `data` is the creator record, `null` when the wallet is not a verified creator
 * (404), and undefined while loading or when the server is unreachable.
 */
export function useCreator(address: Address | undefined) {
  return useQuery({
    queryKey: ['creator', address],
    enabled: Boolean(address),
    retry: false,
    queryFn: async ({ signal }): Promise<CreatorDetail | null> => {
      try {
        return await apiGet<CreatorDetail>(`/api/creators/${address}`, signal);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) return null;
        throw err;
      }
    },
  });
}
