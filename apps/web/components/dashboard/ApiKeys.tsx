'use client';

import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import type { CreatorGrantsResponse } from '@reputed/shared';
import { ApiRequestError, apiGet } from '@/lib/api';
import { InlineError } from '../InlineError';
import { GrantRow } from './GrantRow';
import { NewKey } from './NewKey';
import { Quickstart } from './Quickstart';

const REFRESH_MS = 15_000;

export function ApiKeys({ creator }: { creator: Address }) {
  const grants = useQuery({
    queryKey: ['grants', creator],
    refetchInterval: REFRESH_MS,
    retry: 1,
    queryFn: async ({ signal }) => {
      try {
        return await apiGet<CreatorGrantsResponse>(`/api/creators/${creator}/grants`, signal);
      } catch (error) {
        // A creator verified a moment ago is unknown to the indexer for a few seconds. That is no keys yet.
        if (error instanceof ApiRequestError && error.status === 404) return { grants: [] };
        throw error;
      }
    },
  });

  return (
    <>
      <p className="onboard-text muted">
        An API key lets your agents register themselves and get a reputation, with you as the verified human behind them.
      </p>
      <NewKey creator={creator} />

      <h2>Your keys</h2>
      {grants.isError ? (
        <InlineError message="Could not load your keys." onRetry={() => void grants.refetch()} />
      ) : !grants.data ? (
        <div className="card" aria-busy="true">
          <span className="skeleton skeleton-text" />
        </div>
      ) : grants.data.grants.length === 0 ? (
        <p className="onboard-text muted">No keys yet. Keys you authorize appear here within a few seconds.</p>
      ) : (
        <ul className="grant-list">
          {grants.data.grants.map((grant) => (
            <GrantRow key={grant.grantKey} grant={grant} creator={creator} />
          ))}
        </ul>
      )}

      <Quickstart />
    </>
  );
}
