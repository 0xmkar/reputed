'use client';

import Link from 'next/link';
import { useIdentity } from '@/lib/useIdentity';
import { NetworkPill } from './NetworkPill';
import { WalletButton } from './WalletButton';

export function Header() {
  const { address } = useIdentity();
  return (
    <header className="header">
      <div className="header-inner container">
        <Link href="/" className="brand">
          Reputed
        </Link>
        <nav className="nav" aria-label="Main">
          <Link href="/explore">Explore</Link>
          {address && <Link href={`/creator/${address}`}>My agents</Link>}
          {address && <Link href="/dashboard">Dashboard</Link>}
        </nav>
        <div className="header-right">
          <Link href="/dashboard" className="btn btn-primary">
            Add agent
          </Link>
          <NetworkPill />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
