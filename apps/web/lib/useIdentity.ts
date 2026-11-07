'use client';

import { useAccount, useDisconnect } from 'wagmi';
import type { Address } from 'viem';
import { clearSession, useStoredSession } from './session';

export interface Identity {
  /** The connected wallet, else the one signed in on this device. */
  address: Address | undefined;
  /** The wallet is connected now, so it can sign. When false, `address` is only remembered. */
  live: boolean;
  /** The wallet is reconnecting after a reload. */
  restoring: boolean;
}

/**
 * Who the visitor is. A reload drops the wallet connection for a moment, and sometimes for good
 * (a locked extension, an expired WalletConnect pairing), but the signed-in wallet survives it.
 * Reading and showing things needs only `address`; sending anything needs `live`.
 */
export function useIdentity(): Identity {
  const { address, status } = useAccount();
  const session = useStoredSession();
  if (address) return { address, live: true, restoring: false };
  return {
    address: session?.wallet,
    live: false,
    restoring: status === 'connecting' || status === 'reconnecting',
  };
}

/** Disconnects the wallet and forgets the session, so the next visit starts signed out. */
export function useSignOut() {
  const { disconnect } = useDisconnect();
  return () => {
    clearSession();
    disconnect();
  };
}
