'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { IDENTITY_REGISTRY, hashscan, type AgentDetail } from '@reputed/shared';
import { ApiRequestError, apiGet } from '@/lib/api';
import { SLOW_AFTER_MS, STOP_POLLING_AFTER_MS } from '@/lib/confirmTx';
import { tokenIdFromAddress } from '@/lib/contracts';
import { useCredentialToken } from '@/lib/useOnboardProgress';
import { CredentialCard } from '../CredentialCard';
import { InlineError } from '../InlineError';

const POLL_MS = 3_000;

interface Props {
  agentId: string;
  /** From the AgentLinked log, or null when the link was found on resume. */
  serial: number | null;
  onAnother: () => void;
}

export function SuccessScreen({ agentId, serial, onAnother }: Props) {
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [slow, setSlow] = useState(false);

  const agent = useQuery({
    queryKey: ['agent', agentId, 'onboarded'],
    retry: false,
    queryFn: async ({ signal }): Promise<AgentDetail | null> => {
      try {
        return await apiGet<AgentDetail>(`/api/agents/${agentId}`, signal);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) return null;
        throw err;
      }
    },
    // The indexer runs behind the chain, so keep looking for a while, including through failed reads.
    refetchInterval: (query) => {
      const found = query.state.data?.credentials.some((item) => !item.revoked);
      return found || Date.now() - startedAt > STOP_POLLING_AFTER_MS ? false : POLL_MS;
    },
  });

  const credential =
    agent.data?.credentials.find((item) => item.serial === serial && !item.revoked) ?? agent.data?.credentials.find((item) => !item.revoked);

  useEffect(() => {
    if (credential) return;
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [credential, startedAt]);

  const token = useCredentialToken();
  const tokenId = credential?.tokenId || (token.data ? tokenIdFromAddress(token.data) : undefined);
  const shownSerial = credential?.serial ?? serial;

  function refresh() {
    setStartedAt(Date.now());
    void agent.refetch();
  }

  return (
    <div className="onboard-success">
      <h1>Your agent is human-backed</h1>
      <p className="onboard-text">
        Agent ID <strong className="mono">#{agentId}</strong>
      </p>

      {credential ? (
        <CredentialCard credential={credential} />
      ) : agent.isError ? (
        <InlineError message="The credential is issued, but the Reputed server can't show it right now." onRetry={refresh} />
      ) : (
        <div className="card" aria-busy="true">
          <h3>Human-backed</h3>
          <p className="onboard-text muted">
            {shownSerial !== null ? `Credential #${shownSerial} is on Hedera. ` : 'The credential is on Hedera. '}
            {slow ? 'Reputed is taking longer than usual to index it.' : 'Reputed is indexing it — usually a few seconds.'}
          </p>
          {slow ? (
            <div>
              <button type="button" className="btn btn-outline btn-small" onClick={refresh}>
                Refresh
              </button>
            </div>
          ) : (
            <span className="skeleton skeleton-text" />
          )}
        </div>
      )}

      <div className="row">
        <Link href={`/agent/${agentId}`} className="btn btn-primary">
          View agent page
        </Link>
        <a className="btn btn-outline" href={hashscan.contract(IDENTITY_REGISTRY)} target="_blank" rel="noreferrer">
          Agent NFT on HashScan
        </a>
        {tokenId && (
          <a
            className="btn btn-outline"
            href={shownSerial !== null ? hashscan.nft(tokenId, shownSerial) : hashscan.token(tokenId)}
            target="_blank"
            rel="noreferrer"
          >
            Credential on HashScan
          </a>
        )}
        <button type="button" className="btn btn-outline" onClick={onAnother}>
          Onboard another
        </button>
      </div>
    </div>
  );
}
