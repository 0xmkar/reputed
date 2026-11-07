'use client';

import { useState } from 'react';
import { useSignMessage } from 'wagmi';
import type { Hex } from 'viem';
import {
  walletBindingMessage,
  type Address,
  type RpSignatureResponse,
  type VerifyRequest,
  type VerifyResponse,
} from '@reputed/shared';
import { postJson } from './api';
import {
  REQUEST_EXPIRED,
  describeSignatureError,
  describeStartError,
  describeVerifyError,
  describeWorldError,
  type Failure,
} from './failures';

export type Phase =
  | { name: 'idle' }
  | { name: 'preparing' }
  | { name: 'signing' }
  | { name: 'world'; rp: RpSignatureResponse; walletSignature: Hex }
  | { name: 'verifying' }
  /** The server is done. `tx` is null when an earlier attempt landed and only the chain knows it. */
  | { name: 'confirming'; tx: VerifyResponse | null }
  | { name: 'failed'; failure: Failure; request?: VerifyRequest };

/**
 * The verify sequence: POST /api/rp-signature for a server-signed World ID request, an EIP-191
 * signature binding this wallet to that request's nonce, the IDKit proof, then POST /api/verify with
 * both. The server checks the proof, submits the registration transaction and returns its hash.
 */
export function useVerifyFlow(wallet: Address) {
  const { signMessageAsync } = useSignMessage();
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });

  async function start() {
    setPhase({ name: 'preparing' });
    let rp: RpSignatureResponse;
    try {
      rp = await postJson<RpSignatureResponse>('/api/rp-signature', {});
    } catch (err) {
      setPhase({ name: 'failed', failure: describeStartError(err) });
      return;
    }

    setPhase({ name: 'signing' });
    let walletSignature: Hex;
    try {
      walletSignature = await signMessageAsync({
        account: wallet,
        message: walletBindingMessage(wallet, rp.action, rp.rp_context.nonce),
      });
    } catch (err) {
      setPhase({ name: 'failed', failure: describeSignatureError(err) });
      return;
    }

    // The signature is bound to this nonce, so a request left waiting in the wallet starts over.
    if (Date.now() / 1000 >= rp.rp_context.expires_at) {
      setPhase({ name: 'failed', failure: REQUEST_EXPIRED });
      return;
    }
    setPhase({ name: 'world', rp, walletSignature });
  }

  async function send(request: VerifyRequest) {
    setPhase({ name: 'verifying' });
    try {
      const tx = await postJson<VerifyResponse>('/api/verify', request);
      setPhase({ name: 'confirming', tx });
    } catch (err) {
      // 'registered' means an earlier attempt landed: show it confirming, with no hash to link.
      const outcome = describeVerifyError(err, wallet);
      setPhase(
        outcome === 'registered'
          ? { name: 'confirming', tx: null }
          : { name: 'failed', failure: outcome, request },
      );
    }
  }

  function retry() {
    if (phase.name !== 'failed') return;
    if (phase.failure.retry === 'resend' && phase.request) void send(phase.request);
    else void start();
  }

  function onWorldResult(idkitResponse: unknown) {
    if (phase.name !== 'world') return;
    void send({ wallet, walletSignature: phase.walletSignature, idkitResponse });
  }

  function onWorldError(code: string) {
    setPhase({ name: 'failed', failure: describeWorldError(code) });
  }

  /** The user closed the modal. Nothing went wrong, so go back to the button. */
  function onWorldClosed() {
    setPhase((current) => (current.name === 'world' ? { name: 'idle' } : current));
  }

  return { phase, start, retry, onWorldResult, onWorldError, onWorldClosed };
}
