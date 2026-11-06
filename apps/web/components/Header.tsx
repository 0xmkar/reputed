'use client';

import Link from 'next/link';
import { useAccount } from 'wagmi';
import { NetworkPill } from './NetworkPill';
import { WalletButton } from './WalletButton';

export function Header() {
  const { address, isConnected } = useAccount();
  return (
    <header className="header">
      <div className="header-inner container">
        <Link href="/" className="brand">
          Reputed
        </Link>
        <nav className="nav" aria-label="Main">
          <Link href="/explore">Explore</Link>
          {isConnected && address && <Link href={`/creator/${address}`}>My agents</Link>}
        </nav>
        <div className="header-right">
          <Link href="/onboard" className="btn btn-primary">
            Onboard agent
          </Link>
          <NetworkPill />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
