'use client';

import { useAccount } from 'wagmi';
import { WalletButton } from '@/components/WalletButton';
import { VerifyFlow, VerifyLayout } from './VerifyFlow';

export function VerifyScreen() {
  const { address, status } = useAccount();

  if (address) return <VerifyFlow key={address} wallet={address} />;

  return (
    <VerifyLayout step={0}>
      {status === 'reconnecting' ? <span className="skeleton skeleton-text verify-skeleton" /> : <WalletButton />}
    </VerifyLayout>
  );
}
