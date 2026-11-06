'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HEDERA_TESTNET, hashscan } from '@reputed/shared';
import { shortAddress } from '@/lib/format';
import { CopyIcon, ExternalIcon } from './icons';
import { useToast } from './Toasts';

/** Looks the EVM address up on the Mirror Node: accounts first, then contracts. */
async function fetchHederaId(address: string, signal: AbortSignal): Promise<string | null> {
  const account = await fetch(`${HEDERA_TESTNET.mirrorNode}/api/v1/accounts/${address}`, { signal });
  if (account.ok) return ((await account.json()) as { account?: string }).account ?? null;
  const contract = await fetch(`${HEDERA_TESTNET.mirrorNode}/api/v1/contracts/${address}`, { signal });
  if (contract.ok) return ((await contract.json()) as { contract_id?: string }).contract_id ?? null;
  return null;
}

export function AddressChip({ address }: { address: string }) {
  const { toast } = useToast();
  // The Hedera account ID is only fetched once someone hovers or focuses the chip.
  const [wanted, setWanted] = useState(false);
  const hederaId = useQuery({
    queryKey: ['hedera-id', address],
    enabled: wanted,
    staleTime: Infinity,
    retry: false,
    queryFn: ({ signal }) => fetchHederaId(address, signal),
  });

  const tooltip = hederaId.data ? `${address} (${hederaId.data})` : address;

  return (
    <span className="address-chip" title={tooltip} onMouseEnter={() => setWanted(true)} onFocus={() => setWanted(true)}>
      <span className="mono">{shortAddress(address)}</span>
      <button
        type="button"
        className="icon-btn"
        aria-label="Copy address"
        onClick={() =>
          navigator.clipboard.writeText(address).then(
            () => toast('success', 'Address copied'),
            () => toast('error', 'Could not copy the address.'),
          )
        }
      >
        <CopyIcon />
      </button>
      <a className="icon-btn" href={hashscan.address(address)} target="_blank" rel="noreferrer" aria-label="View on HashScan">
        <ExternalIcon />
      </a>
    </span>
  );
}
