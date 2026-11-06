'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount, useConnect, useConnectors, useDisconnect, type Connector } from 'wagmi';
import { hashscan } from '@reputed/shared';
import { shortAddress } from '@/lib/format';
import { useCreator } from '@/lib/useCreator';
import { describeWalletError } from '@/lib/walletError';
import { useToast } from './Toasts';
import { VerifiedCreatorBadge } from './VerifiedCreatorBadge';
import { WalletPicker, walletChoices } from './WalletPicker';

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const connectors = useConnectors();
  const { connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const creator = useCreator(address);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
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
    const choices = walletChoices(connectors);
    const connectWith = (connector: Connector) => {
      // Closed first: the WalletConnect QR modal can't show above an open <dialog>.
      setPicking(false);
      connect(
        { connector },
        {
          onError: (err) => {
            const { rejected, message } = describeWalletError(err);
            if (!rejected) toast('error', message || 'Could not connect the wallet.');
          },
        },
      );
    };
    return (
      <>
        <button
          type="button"
          className="btn btn-primary"
          disabled={isPending}
          onClick={() => {
            if (choices.length === 0) {
              toast('error', 'No wallet found. Install HashPack, MetaMask or another EVM wallet.');
            } else if (choices.length === 1) {
              connectWith(choices[0]!);
            } else {
              setPicking(true);
            }
          }}
        >
          {isPending ? 'Connecting…' : 'Connect wallet'}
        </button>
        <WalletPicker open={picking} connectors={choices} onPick={connectWith} onClose={() => setPicking(false)} />
      </>
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
