'use client';

import { useId } from 'react';
import type { Connector } from 'wagmi';
import { Dialog } from './review/Dialog';

interface Props {
  open: boolean;
  connectors: readonly Connector[];
  onPick: (connector: Connector) => void;
  onClose: () => void;
}

const HINTS: Record<string, string> = {
  walletConnect: 'HashPack and mobile wallets, by QR code',
};

/** Extension wallets announce themselves, so the generic entry only matters when none did. */
export function walletChoices(connectors: readonly Connector[]): Connector[] {
  const unique = connectors.filter((c, i) => connectors.findIndex((o) => o.id === c.id) === i);
  const announced = unique.some((c) => c.type === 'injected' && c.id !== 'injected');
  return announced ? unique.filter((c) => c.id !== 'injected') : unique;
}

function label(connector: Connector): string {
  return connector.id === 'injected' ? 'Browser wallet' : connector.name;
}

export function WalletPicker({ open, connectors, onPick, onClose }: Props) {
  const titleId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId} className="wallet-picker">
      <div className="dialog-head">
        <h2 id={titleId}>Connect a wallet</h2>
        <button type="button" className="btn btn-outline btn-small" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted">Use an ECDSA account on Hedera testnet. HashPack&apos;s default Ed25519 accounts can&apos;t sign here.</p>
      <ul className="wallet-options">
        {connectors.map((connector) => (
          <li key={connector.uid}>
            <button type="button" className="wallet-option" onClick={() => onPick(connector)}>
              {connector.icon ? <img src={connector.icon} alt="" width={28} height={28} /> : <span className="wallet-option-icon" aria-hidden />}
              <span>
                <strong>{label(connector)}</strong>
                {HINTS[connector.id] && <small>{HINTS[connector.id]}</small>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
