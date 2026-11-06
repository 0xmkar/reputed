'use client';

import { useEffect, useRef } from 'react';
import { useAccount, useSignMessage } from 'wagmi';
import { isAddressEqual } from 'viem';
import { sessionMessage, type SessionInfo, type SessionRequest, type SessionResponse } from '@reputed/shared';
import { ApiRequestError, apiGet, apiPost } from '@/lib/api';
import { clearSession, markSignInDeclined, saveSession, useStoredSession, wasSignInDeclined } from '@/lib/session';
import { describeWalletError } from '@/lib/walletError';
import { useToast } from './Toasts';

/**
 * Keeps the visitor signed in across reloads. The first time a wallet connects, it signs one free
 * message and the server answers with a token that is stored here. After that, a reload
 * recognizes the wallet from the token and never asks for a signature or a World ID scan again.
 */
export function SessionSync() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const session = useStoredSession();
  const { toast } = useToast();
  const signingFor = useRef<string | null>(null);

  // The server may no longer honor a stored token, for example after its secret changed.
  const token = session?.token;
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    apiGet<SessionInfo>('/api/session', controller.signal, { authorization: `Bearer ${token}` }).catch((err) => {
      if (err instanceof ApiRequestError && err.status === 401) clearSession();
    });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (!isConnected || !address) return;
    if (session && isAddressEqual(session.wallet, address)) return;
    if (wasSignInDeclined(address) || signingFor.current === address.toLowerCase()) return;

    const wallet = address;
    signingFor.current = wallet.toLowerCase();
    void (async () => {
      try {
        const issuedAt = Math.floor(Date.now() / 1000);
        const signature = await signMessageAsync({ account: wallet, message: sessionMessage(wallet, issuedAt) });
        const body: SessionRequest = { wallet, issuedAt, signature };
        saveSession(await apiPost<SessionResponse>('/api/session', body));
      } catch (err) {
        markSignInDeclined(wallet);
        const { rejected, message } = describeWalletError(err);
        if (!rejected) toast('error', message || 'Could not sign in. Reconnect your wallet to try again.');
      } finally {
        signingFor.current = null;
      }
    })();
  }, [address, isConnected, session, signMessageAsync, toast]);

  return null;
}
