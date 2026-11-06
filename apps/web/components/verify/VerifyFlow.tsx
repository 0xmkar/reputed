'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useAccount } from 'wagmi';
import { HEDERA_TESTNET, type Address } from '@reputed/shared';
import { AddressChip } from '@/components/AddressChip';
import { InlineError } from '@/components/InlineError';
import { useToast } from '@/components/Toasts';
import { useSignOut } from '@/lib/useIdentity';
import { SuccessCard } from './SuccessCard';
import { StepIndicator } from './StepIndicator';
import { useCreatorStatus } from './useCreatorStatus';
import { useVerifyFlow } from './useVerifyFlow';
import { VerifyProgress } from './VerifyProgress';

// IDKit needs the browser, and only people who start verifying should download it.
const WorldIdWidget = dynamic(() => import('./WorldIdWidget'), { ssr: false });

const SLOW_AFTER_MS = 30_000;

function worldAppId(): `app_${string}` | null {
  const id = process.env.NEXT_PUBLIC_WORLD_APP_ID;
  return id?.startsWith('app_') ? (id as `app_${string}`) : null;
}

export function VerifyLayout({ step, children }: { step: number; children: ReactNode }) {
  return (
    <section className="verify">
      <h1>Become a verified creator</h1>
      <StepIndicator current={step} />
      {step < 2 && (
        <div className="verify-explainer">
          <p>One person, one creator. Your agents&apos; reputation follows you.</p>
          <p className="muted">World ID proves you&apos;re unique without telling us who you are.</p>
        </div>
      )}
      {children}
    </section>
  );
}

/** Mount with `key={wallet}`: a different wallet starts over, because the proof is bound to this one. */
export function VerifyFlow({ wallet }: { wallet: Address }) {
  const { chainId } = useAccount();
  const signOut = useSignOut();
  const { toast } = useToast();
  const { phase, start, retry, onWorldResult, onWorldError, onWorldClosed } = useVerifyFlow(wallet);

  // A send that can be retried may still have landed, so keep watching the chain.
  const watching = phase.name === 'confirming' || (phase.name === 'failed' && phase.failure.retry === 'resend');
  const status = useCreatorStatus(wallet, watching);
  const confirmed = status.data === true;

  const [slowTimer, setSlowTimer] = useState(0);
  const [slow, setSlow] = useState(false);
  const confirming = phase.name === 'confirming' && !confirmed;
  useEffect(() => {
    setSlow(false);
    if (!confirming) return;
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [confirming, slowTimer]);

  // Only a verification finished here gets a toast, not a wallet that was already a creator.
  const announced = useRef(false);
  useEffect(() => {
    if (!confirmed || announced.current || phase.name === 'idle') return;
    announced.current = true;
    toast('success', "You're a verified creator");
  }, [confirmed, phase.name, toast]);

  if (confirmed) {
    return (
      <VerifyLayout step={2}>
        <SuccessCard wallet={wallet} tx={phase.name === 'confirming' ? phase.tx : null} />
      </VerifyLayout>
    );
  }

  const appId = worldAppId();
  const wrongNetwork = chainId !== HEDERA_TESTNET.id;
  const checking = status.data === undefined && status.isPending;
  const checkFailed = status.data === undefined && status.isError;
  const sending = phase.name === 'verifying' || phase.name === 'confirming';
  const busy = sending || phase.name === 'preparing' || phase.name === 'signing' || phase.name === 'world';

  return (
    <VerifyLayout step={1}>
      <div className="verify-wallet">
        <AddressChip address={wallet} />
        <span>This wallet becomes your creator wallet</span>
        <button type="button" className="verify-link" disabled={sending} onClick={signOut}>
          Use a different wallet
        </button>
      </div>

      {checking && <span className="skeleton skeleton-text verify-skeleton" />}
      {checkFailed && (
        <InlineError message="Could not check this wallet. The server may be down." onRetry={() => void status.refetch()} />
      )}

      {!appId && (
        <InlineError message="World ID isn't set up on this site, so verification can't run. NEXT_PUBLIC_WORLD_APP_ID is missing." />
      )}

      {status.data === false && appId && !sending && phase.name !== 'failed' && (
        <div className="tx">
          <button type="button" className="btn btn-primary" disabled={busy || wrongNetwork} onClick={() => void start()}>
            {phase.name === 'signing' ? 'Waiting for signature…' : 'Verify with World ID'}
          </button>
          <div className="tx-status" role="status">
            {wrongNetwork && <span className="muted">Switch to {HEDERA_TESTNET.name} to continue.</span>}
            {phase.name === 'signing' && (
              <span className="muted">Sign the message in your wallet. It proves you own this wallet and costs nothing.</span>
            )}
            {phase.name === 'world' && <span className="muted">Finish in World App.</span>}
          </div>
        </div>
      )}

      {sending && (
        <VerifyProgress
          submitted={phase.name === 'confirming'}
          tx={phase.name === 'confirming' ? phase.tx : null}
          slow={slow}
          onRefresh={() => {
            setSlowTimer((n) => n + 1);
            void status.refetch();
          }}
        />
      )}

      {phase.name === 'failed' && (
        <div className="verify-failure">
          <InlineError message={phase.failure.message} onRetry={phase.failure.retry ? retry : undefined} />
          {phase.failure.detail && <p className="muted verify-note">{phase.failure.detail}</p>}
        </div>
      )}

      {phase.name === 'world' && appId && (
        <WorldIdWidget
          appId={appId}
          rp={phase.rp}
          wallet={wallet}
          onResult={onWorldResult}
          onError={onWorldError}
          onClosed={onWorldClosed}
        />
      )}
    </VerifyLayout>
  );
}
