'use client';

import { useAccount, useSwitchChain } from 'wagmi';
import { HEDERA_TESTNET } from '@reputed/shared';
import { useToast } from './Toasts';

export function WrongNetworkBanner() {
  const { isConnected, chainId, chain } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const { toast } = useToast();

  if (!isConnected || chainId === HEDERA_TESTNET.id) return null;

  const current = chain?.name ?? `chain ${chainId}`;
  return (
    <div className="banner" role="alert">
      <span>
        You&apos;re on {current}. Switch to {HEDERA_TESTNET.name}.
      </span>
      <button
        type="button"
        className="btn btn-primary btn-small"
        disabled={isPending}
        onClick={() =>
          switchChain(
            { chainId: HEDERA_TESTNET.id },
            { onError: (err) => toast('error', err.message.split('\n')[0] ?? 'Could not switch the network.') },
          )
        }
      >
        {isPending ? 'Switching…' : 'Switch'}
      </button>
    </div>
  );
}
