'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import type { Address } from 'viem';
import { creatorRegistryAbi } from '@reputed/shared';
import { chainClient } from '@/lib/chainClient';
import { CREATOR_REGISTRY } from '@/lib/contracts';
import { InlineError } from '../InlineError';
import { WalletButton } from '../WalletButton';
import { OnboardWizard } from './OnboardWizard';

function Loading() {
  return (
    <section className="onboard" aria-busy="true">
      <h1>Onboard agent</h1>
      <div className="card">
        <span className="skeleton skeleton-text" />
        <span className="skeleton skeleton-text" />
      </div>
    </section>
  );
}

/** Reads isCreator from the chain, so a creator verified a moment ago passes before the indexer catches up. */
export function OnboardGate() {
  const { address, status } = useAccount();
  // While an agent wallet signs, the wallet's selected account can move to it. The wizard stays with the creator.
  const [pinned, setPinned] = useState<Address | null>(null);
  const creator = address ? (pinned ?? address) : undefined;

  const isCreator = useQuery({
    queryKey: ['is-creator', creator],
    enabled: Boolean(creator),
    retry: 2,
    queryFn: () =>
      chainClient.readContract({ address: CREATOR_REGISTRY, abi: creatorRegistryAbi, functionName: 'isCreator', args: [creator as Address] }),
  });

  if (!creator) {
    if (status === 'connecting' || status === 'reconnecting') return <Loading />;
    return (
      <section className="onboard">
        <h1>Onboard agent</h1>
        <div className="card">
          <h3>Connect your creator wallet</h3>
          <p className="onboard-text muted">Use the wallet you verified with World ID.</p>
          <div>
            <WalletButton />
          </div>
        </div>
      </section>
    );
  }

  if (isCreator.data === undefined) {
    if (!isCreator.isError) return <Loading />;
    return (
      <section className="onboard">
        <h1>Onboard agent</h1>
        <InlineError message="Could not check this wallet on Hedera." onRetry={() => void isCreator.refetch()} />
      </section>
    );
  }

  if (!isCreator.data) {
    return (
      <section className="onboard">
        <h1>Onboard agent</h1>
        <div className="card">
          <h3>Verify with World ID first</h3>
          <p className="onboard-text muted">
            Every agent is tied to one verified human. Verify once, then come back to onboard your agents.
          </p>
          <div>
            <Link href="/verify" className="btn btn-primary">
              Verify with World ID
            </Link>
          </div>
          <p className="onboard-text muted">Already verified? Switch to your creator wallet.</p>
        </div>
      </section>
    );
  }

  return <OnboardWizard key={creator} creator={creator} onPinCreator={setPinned} />;
}
