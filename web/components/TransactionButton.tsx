'use client';

import { useState } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { BaseError, InsufficientFundsError, UserRejectedRequestError, type Hash, type TransactionReceipt } from 'viem';
import { HEDERA_TESTNET, hashscan } from '@reputed/shared';
import { useToast } from './Toasts';

type TxState =
  | { step: 'idle' }
  | { step: 'signing' }
  | { step: 'submitted'; hash: Hash }
  | { step: 'confirmed'; hash: Hash }
  | { step: 'failed'; message: string; hash?: Hash }
  | { step: 'rejected' };

interface Props {
  label: string;
  /** Asks the wallet to sign and send, then returns the transaction hash (for example writeContractAsync). */
  onSend: () => Promise<Hash>;
  onConfirmed?: (receipt: TransactionReceipt) => void;
  disabled?: boolean;
}

function describeError(err: unknown): { rejected: boolean; message: string } {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return { rejected: true, message: '' };
    if (err.walk((e) => e instanceof InsufficientFundsError)) {
      return { rejected: false, message: 'Not enough HBAR. Top up from the testnet faucet.' };
    }
    return { rejected: false, message: err.shortMessage };
  }
  const message = err instanceof Error ? (err.message.split('\n')[0] ?? 'Something went wrong.') : 'Something went wrong.';
  return { rejected: /user (rejected|denied)/i.test(message), message };
}

export function TransactionButton({ label, onSend, onConfirmed, disabled = false }: Props) {
  const { isConnected, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { toast } = useToast();
  const [state, setState] = useState<TxState>({ step: 'idle' });

  const onWrongNetwork = isConnected && chainId !== HEDERA_TESTNET.id;
  const busy = state.step === 'signing' || state.step === 'submitted';
  const blocked = disabled || !isConnected || onWrongNetwork || busy || state.step === 'confirmed';

  async function run() {
    setState({ step: 'signing' });
    let hash: Hash;
    try {
      hash = await onSend();
    } catch (err) {
      const { rejected, message } = describeError(err);
      if (rejected) {
        setState({ step: 'rejected' });
        toast('error', 'Cancelled in your wallet');
      } else {
        setState({ step: 'failed', message });
        toast('error', message);
      }
      return;
    }

    setState({ step: 'submitted', hash });
    toast('info', 'Transaction submitted');
    try {
      if (!publicClient) throw new Error('No connection to Hedera.');
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'reverted') {
        const message = 'The transaction was rejected by the contract.';
        setState({ step: 'failed', message, hash });
        toast('error', message);
        return;
      }
      setState({ step: 'confirmed', hash });
      toast('success', 'Transaction confirmed');
      onConfirmed?.(receipt);
    } catch (err) {
      const { message } = describeError(err);
      setState({ step: 'failed', message, hash });
      toast('error', message);
    }
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
        {state.step === 'submitted' && (
          <span className="muted">
            Submitted.{' '}
            <a href={hashscan.tx(state.hash)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          </span>
        )}
        {state.step === 'confirmed' && (
          <span className="pay-ok">
            Confirmed.{' '}
            <a href={hashscan.tx(state.hash)} target="_blank" rel="noreferrer">
              View on HashScan
            </a>
          </span>
        )}
        {state.step === 'rejected' && <span className="error-text">Cancelled in your wallet.</span>}
        {state.step === 'failed' && (
          <span className="error-text">
            {state.message}
            {state.hash && (
              <>
                {' '}
                <a href={hashscan.tx(state.hash)} target="_blank" rel="noreferrer">
                  View on HashScan
                </a>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
