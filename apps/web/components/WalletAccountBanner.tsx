'use client';

import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { HEDERA_TESTNET } from '@reputed/shared';
import { checkConnectedWallet } from '@/lib/mirror';

/**
 * Warns when the connected account can't make signatures the API accepts, for example a HashPack
 * Ed25519 account. It doesn't block anything: the wallet still works for reading.
 */
export function WalletAccountBanner() {
  const { address, chainId } = useAccount();
  const onHedera = chainId === HEDERA_TESTNET.id;
  const { data: problem } = useQuery({
    queryKey: ['wallet-account', address],
    enabled: Boolean(address) && onHedera,
    retry: false,
    staleTime: 60_000,
    queryFn: ({ signal }) => checkConnectedWallet(address!, signal),
  });

  if (!address || !onHedera || !problem) return null;
  return (
    <div className="banner" role="alert">
      <span>{problem}</span>
    </div>
  );
}
