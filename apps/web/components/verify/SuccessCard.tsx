'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { hashscan, type Address, type VerifyResponse } from '@reputed/shared';
import { AddressChip } from '@/components/AddressChip';
import { VerifiedCreatorBadge } from '@/components/VerifiedCreatorBadge';
import { useCreator } from '@/lib/useCreator';

const REFRESH_MS = 2000;
const MAX_REFRESHES = 30;

/** The header badge reads the API, which trails the chain, so ask again until the record is there. */
function useRefreshHeaderBadge(wallet: Address) {
  const queryClient = useQueryClient();
  const indexed = Boolean(useCreator(wallet).data);

  useEffect(() => {
    if (indexed) return;
    let refreshes = 0;
    const timer = setInterval(() => {
      refreshes += 1;
      if (refreshes >= MAX_REFRESHES) clearInterval(timer);
      void queryClient.invalidateQueries({ queryKey: ['creator', wallet] });
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [indexed, queryClient, wallet]);
}

export function SuccessCard({ wallet, tx }: { wallet: Address; tx: VerifyResponse | null }) {
  useRefreshHeaderBadge(wallet);

  return (
    <div className="card verify-success">
      <div>
        <VerifiedCreatorBadge />
      </div>
      <h2>You&apos;re a verified creator</h2>
      <div className="row">
        <span className="muted">Creator wallet</span>
        <AddressChip address={wallet} />
      </div>
      <a href={tx ? hashscan.tx(tx.transactionHash) : hashscan.address(wallet)} target="_blank" rel="noreferrer">
        {tx ? 'View registration on HashScan' : 'View wallet on HashScan'}
      </a>
      <div>
        <Link href="/onboard" className="btn btn-primary">
          Onboard your first agent
        </Link>
      </div>
    </div>
  );
}
