'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount } from 'wagmi';
import type { Hash } from 'viem';
import { HEDERA_TESTNET, hashscan } from '@reputed/shared';
import { SLOW_AFTER_MS, confirmTx, type ConfirmedTx, type TxFailure } from '@/lib/confirmTx';
import { describeWalletError } from '@/lib/walletError';
import { useToast } from './Toasts';

type TxState =
  | { step: 'idle' }
  | { step: 'signing' }
  // Sent, and the outcome is not known yet. There is deliberately no way to send again from here:
  // a slow or failing poll says nothing about the transaction, so a second send could run it twice.
  | { step: 'confirming'; hash: Hash; slow: boolean }
  | { step: 'confirmed'; hash: Hash }
  | { step: 'failed'; message: string; hash?: Hash }
  | { step: 'rejected' };

interface Props {
  label: string;
  /** Asks the wallet to sign and send, then returns the transaction hash (for example writeContractAsync). */
  onSend: () => Promise<Hash>;
  /** Runs once the Mirror Node records success. `logs` are `{address, topics, data}`. */
  onConfirmed?: (tx: ConfirmedTx) => void;
  /** Runs as soon as the hash is known, so the caller can save it and resume after a closed tab. */
  onSubmitted?: (hash: Hash) => void;
  /** Runs on a revert, which has a `hash`, or when sending failed. Not when the user cancels. */
  onFailed?: (failure: TxFailure) => void;
  /** A transaction sent earlier: starts in the confirming state and watches it. Read on mount. */
  resumeHash?: Hash;
  disabled?: boolean;
}

function TxLink({ hash, children }: { hash: Hash; children: string }) {
  return (
    <a href={hashscan.tx(hash)} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export function TransactionButton({ label, onSend, onConfirmed, onSubmitted, onFailed, resumeHash, disabled = false }: Props) {
  const { isConnected, chainId } = useAccount();
  const { toast } = useToast();
  const [state, setState] = useState<TxState>(() =>
    resumeHash ? { step: 'confirming', hash: resumeHash, slow: false } : { step: 'idle' },
  );
  // Bumped by Refresh to look again at once.
  const [attempt, setAttempt] = useState(0);

  const latest = useRef({ onConfirmed, onFailed, toast });
  useEffect(() => {
    latest.current = { onConfirmed, onFailed, toast };
  });

  const watching = state.step === 'confirming' ? state.hash : null;
  useEffect(() => {
    if (!watching) return;
    const controller = new AbortController();
    const markSlow = () => setState((current) => (current.step === 'confirming' ? { ...current, slow: true } : current));
    const slowTimer = setTimeout(markSlow, SLOW_AFTER_MS);

    confirmTx(watching, { signal: controller.signal }).then(
      (outcome) => {
        const { onConfirmed, onFailed, toast } = latest.current;
        if (outcome.status === 'unknown') {
          // Polling has stopped. Refresh starts it again, and sending again is never offered.
          markSlow();
        } else if (outcome.status === 'confirmed') {
          setState({ step: 'confirmed', hash: outcome.hash });
          toast('success', 'Transaction confirmed');
          onConfirmed?.({ hash: outcome.hash, logs: outcome.logs });
        } else {
          setState({ step: 'failed', message: outcome.reason, hash: outcome.hash });
          toast('error', outcome.reason);
          onFailed?.(outcome);
        }
      },
      () => {
        // Aborted: this button unmounted, or Refresh started a new look.
      },
    );

    return () => {
      controller.abort();
      clearTimeout(slowTimer);
    };
  }, [watching, attempt]);

  const onWrongNetwork = isConnected && chainId !== HEDERA_TESTNET.id;
  const busy = state.step === 'signing' || state.step === 'confirming';
  const blocked = disabled || !isConnected || onWrongNetwork || busy || state.step === 'confirmed';

  async function run() {
    setState({ step: 'signing' });
    let hash: Hash;
    try {
      hash = await onSend();
    } catch (err) {
      const { rejected, message } = describeWalletError(err);
      if (rejected) {
        setState({ step: 'rejected' });
        toast('error', 'Cancelled in your wallet');
      } else {
        setState({ step: 'failed', message });
        toast('error', message);
        onFailed?.({ reason: message });
      }
      return;
    }

    onSubmitted?.(hash);
    setState({ step: 'confirming', hash, slow: false });
    toast('info', 'Transaction submitted');
  }

  const retrying = state.step === 'failed' || state.step === 'rejected';
  const buttonText = state.step === 'signing' ? 'Waiting for signature…' : retrying ? 'Retry' : label;

  return (
    <div className="tx">
      <button type="button" className="btn btn-primary" disabled={blocked} onClick={run}>
        {buttonText}
      </button>
      <div className="tx-status" role="status">
        {!isConnected && <span className="muted">Connect your wallet first.</span>}
        {onWrongNetwork && <span className="muted">Switch to {HEDERA_TESTNET.name} to continue.</span>}
        {state.step === 'signing' && <span className="muted">Confirm the transaction in your wallet.</span>}
        {state.step === 'confirming' && !state.slow && (
          <span className="muted">
            Confirming on Hedera — usually a few seconds. <TxLink hash={state.hash}>View transaction</TxLink>
          </span>
        )}
        {state.step === 'confirming' && state.slow && (
          <span className="muted tx-slow">
            <span>
              Taking longer than usual. <TxLink hash={state.hash}>View transaction</TxLink>
            </span>
            <button type="button" className="btn btn-outline btn-small" onClick={() => setAttempt((n) => n + 1)}>
              Refresh
            </button>
          </span>
        )}
        {state.step === 'confirmed' && (
          <span className="pay-ok">
            Confirmed. <TxLink hash={state.hash}>View on HashScan</TxLink>
          </span>
        )}
        {state.step === 'rejected' && <span className="error-text">Cancelled in your wallet.</span>}
        {state.step === 'failed' && (
          <span className="error-text">
            {state.message}
            {state.hash && (
              <>
                {' '}
                <TxLink hash={state.hash}>View on HashScan</TxLink>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
