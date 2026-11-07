'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { creatorRegistryAbi } from '@reputed/shared';
import { chainClient } from '@/lib/chainClient';
import { useIdentity } from '@/lib/useIdentity';
import { CREATOR_REGISTRY } from '@/lib/contracts';
import { InlineError } from '../InlineError';
import { PageHead } from '../PageHead';
import { WalletButton } from '../WalletButton';
import { ApiKeys } from './ApiKeys';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="onboard" aria-busy={undefined}>
      <PageHead
        eyebrow="Dashboard"
        title="API keys for your agents"
        lede="A key lets an agent register itself and link to you as its verified human. Keep it secret, set how many agents it may link, and revoke it any time."
      />
      {children}
    </section>
  );
}

/** Verified creators only: the chain decides, so someone verified a moment ago gets in at once. */
export function DashboardGate() {
  const { address, live, restoring } = useIdentity();

  const isCreator = useQuery({
    queryKey: ['is-creator', address],
    enabled: Boolean(address),
    retry: 2,
    queryFn: () =>
      chainClient.readContract({ address: CREATOR_REGISTRY, abi: creatorRegistryAbi, functionName: 'isCreator', args: [address as Address] }),
  });

  if (!address) {
    if (restoring) {
      return (
        <Shell>
          <div className="card" aria-busy="true">
            <span className="skeleton skeleton-text" />
          </div>
        </Shell>
      );
    }
    return (
      <Shell>
        <div className="card">
          <h3>Connect your creator wallet</h3>
          <p className="onboard-text muted">Use the wallet you verified with World ID.</p>
          <div>
            <WalletButton />
          </div>
        </div>
      </Shell>
    );
  }

  if (isCreator.data === undefined) {
    return (
      <Shell>
        {isCreator.isError ? (
          <InlineError message="Could not check this wallet on Hedera." onRetry={() => void isCreator.refetch()} />
        ) : (
          <div className="card" aria-busy="true">
            <span className="skeleton skeleton-text" />
          </div>
        )}
      </Shell>
    );
  }

  if (!isCreator.data) {
    return (
      <Shell>
        <div className="card">
          <h3>Verify with World ID first</h3>
          <p className="onboard-text muted">API keys belong to a verified human, so every agent that uses one is backed by you.</p>
          <div>
            <Link href="/verify" className="btn btn-primary">
              Verify with World ID
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <ApiKeys creator={address} canSign={live} />
    </Shell>
  );
}
