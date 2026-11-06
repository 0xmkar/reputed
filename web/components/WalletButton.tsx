'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount, useConnect, useConnectors, useDisconnect } from 'wagmi';
import { hashscan } from '@reputed/shared';
import { shortAddress } from '@/lib/format';
import { useCreator } from '@/lib/useCreator';
import { useToast } from './Toasts';
import { VerifiedCreatorBadge } from './VerifiedCreatorBadge';

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const connectors = useConnectors();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const creator = useCreator(address);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!isConnected || !address) {
    return (
      <button
        type="button"
        className="btn btn-primary"
        disabled={isPending}
        onClick={() => {
          const connector = connectors[0];
          if (!connector) {
            toast('error', 'No browser wallet found. Install MetaMask or another EVM wallet.');
            return;
          }
          connect(
            { connector },
            { onError: (err) => toast('error', err.message.split('\n')[0] ?? 'Could not connect the wallet.') },
          );
        }}
      >
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
    );
  }

  return (
    <div className="wallet" ref={menuRef}>
      <button type="button" className="btn btn-outline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="mono">{shortAddress(address)}</span>
        {creator.data && <VerifiedCreatorBadge />}
      </button>
      {open && (
        <div className="menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              navigator.clipboard.writeText(address).then(
                () => toast('success', 'Address copied'),
                () => toast('error', 'Could not copy the address.'),
              );
              setOpen(false);
            }}
          >
            Copy address
          </button>
          <a role="menuitem" href={hashscan.address(address)} target="_blank" rel="noreferrer">
            View on HashScan
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              disconnect();
              setOpen(false);
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
