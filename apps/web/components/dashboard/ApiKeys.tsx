'use client';

import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import type { CreatorGrantsResponse } from '@reputed/shared';
import { ApiRequestError, apiGet } from '@/lib/api';
import { ConnectButton } from '../WalletButton';
import { InlineError } from '../InlineError';
import { GrantRow } from './GrantRow';
import { NewKey } from './NewKey';
import { Quickstart } from './Quickstart';

const REFRESH_MS = 15_000;

/** `canSign` is false when the wallet is remembered but not connected: keys can be read, not changed. */
export function ApiKeys({ creator, canSign }: { creator: Address; canSign: boolean }) {
  const grants = useQuery({
    queryKey: ['grants', creator],
    // The list comes from the indexer, which trails the chain, so it is refreshed on a timer.
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
    <div className="layout-2col is-wide-aside">
      <div className="onboard">
      {canSign ? (
        <NewKey creator={creator} />
      ) : (
        <div className="card">
          <h3>Reconnect your wallet</h3>
          <p className="onboard-text muted">You&apos;re signed in, so your keys are listed below. Connect the wallet to create or revoke one.</p>
          <div>
            <ConnectButton>Reconnect wallet</ConnectButton>
          </div>
        </div>
      )}

      <h2>
        Your keys
        {grants.data && <span className="count">{grants.data.grants.length}</span>}
      </h2>
      {grants.isError ? (
        <InlineError message="Could not load your keys." onRetry={() => void grants.refetch()} />
      ) : !grants.data ? (
        <div className="card" aria-busy="true">
          <span className="skeleton skeleton-text" />
        </div>
      ) : grants.data.grants.length === 0 ? (
        <div className="empty-state">
          <p>No keys yet. Create one above and it appears here within a few seconds of the transaction confirming.</p>
        </div>
      ) : (
        <ul className="grant-list">
          {grants.data.grants.map((grant) => (
            <GrantRow key={grant.grantKey} grant={grant} creator={creator} canSign={canSign} />
          ))}
        </ul>
      )}
      </div>

      <aside className="rail">
        <Quickstart />
      </aside>
    </div>
  );
}
