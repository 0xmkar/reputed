'use client';

import type { Address } from '@reputed/shared';
import { useIdentity } from '@/lib/useIdentity';
import { ConnectButton, WalletButton } from '@/components/WalletButton';
import { SuccessCard } from './SuccessCard';
import { useCreatorStatus } from './useCreatorStatus';
import { VerifyFlow, VerifyLayout } from './VerifyFlow';

const Loading = () => <span className="skeleton skeleton-text verify-skeleton" />;

/** Signed in on this device, wallet not connected. A verified creator has nothing left to do here. */
function RememberedWallet({ wallet }: { wallet: Address }) {
  const status = useCreatorStatus(wallet, false);

  if (status.data === true) {
    return (
      <VerifyLayout step={2}>
        <SuccessCard wallet={wallet} tx={null} />
      </VerifyLayout>
    );
  }
  return (
    <VerifyLayout step={0}>
      {status.isPending ? (
        <Loading />
      ) : (
        <div className="tx">
          <ConnectButton>Reconnect wallet</ConnectButton>
          <div className="tx-status" role="status">
            <span className="muted">Reconnect the wallet you signed in with to verify with World ID.</span>
          </div>
        </div>
      )}
    </VerifyLayout>
  );
}

/**
 * Picks the screen by identity: a live wallet runs the flow, a remembered one can only show its
 * status or ask to reconnect, and no wallet gets Connect. The proof is bound to a fresh wallet
 * signature, so a remembered wallet cannot verify.
 */
export function VerifyScreen() {
  const { address, live, restoring } = useIdentity();

  if (address && live) return <VerifyFlow key={address} wallet={address} />;
  if (restoring) {
    return (
      <VerifyLayout step={0}>
        <Loading />
      </VerifyLayout>
    );
  }
  if (address) return <RememberedWallet wallet={address} />;

  return (
    <VerifyLayout step={0}>
      <WalletButton />
    </VerifyLayout>
  );
}
