'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Address } from 'viem';
import { clearDraft, loadDraft, newDraft, saveDraft, type OnboardDraft, type WizardStep } from '@/lib/onboardDraft';
import { hasChainState, useOnboardProgress, type OnboardProgress } from '@/lib/useOnboardProgress';
import { InlineError } from '../InlineError';
import { DetailsStep } from './DetailsStep';
import { EndpointsStep } from './EndpointsStep';
import { LinkStep } from './LinkStep';
import { ReviewStep } from './ReviewStep';
import { StartOver } from './StartOver';
import { StepBar } from './StepBar';
import { SuccessScreen } from './SuccessScreen';
import { WalletStep } from './WalletStep';

export type PatchDraft = (changes: Partial<OnboardDraft>) => void;

const REGISTERED = { registerTx: undefined, registerStartedAt: undefined, pendingUri: undefined } as const;

interface Props {
  creator: Address;
  onPinCreator: (creator: Address | null) => void;
}

export function OnboardWizard({ creator, onPinCreator }: Props) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<OnboardDraft>(() => loadDraft(creator) ?? newDraft());
  // Transaction callbacks can arrive back to back, so each patch builds on the last one, not on a render.
  const current = useRef(draft);
  const [saved, setSaved] = useState(true);

  const patch = useCallback<PatchDraft>(
    (changes) => {
      const next = { ...current.current, ...changes };
      current.current = next;
      setDraft(next);
      setSaved(saveDraft(creator, next));
    },
    [creator],
  );

  // Stored progress is checked against the chain before any of it is shown.
  const [check, setCheck] = useState<{ draft: OnboardDraft; nonce: number } | null>(() =>
    hasChainState(draft) ? { draft, nonce: 0 } : null,
  );
  const progress = useOnboardProgress(creator, check?.draft ?? null, check?.nonce);
  const [problem, setProblem] = useState<Extract<OnboardProgress, { state: 'missing' | 'not-yours' }> | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [done, setDone] = useState<{ agentId: string; serial: number | null } | null>(null);

  const finish = useCallback(
    (agentId: string, serial: number | null) => {
      // Finished work should not resume, so a later visit starts a new agent.
      clearDraft(creator);
      setDone({ agentId, serial });
      void queryClient.invalidateQueries({ queryKey: ['agent', agentId] });
      void queryClient.invalidateQueries({ queryKey: ['creator', creator] });
    },
    [creator, queryClient],
  );

  const recheck = useCallback(() => {
    setProblem(null);
    setCheck((previous) => ({ draft: current.current, nonce: (previous?.nonce ?? 0) + 1 }));
  }, []);

  const result = check ? progress.data : undefined;
  useEffect(() => {
    if (!result) return;
    setCheck(null);
    switch (result.state) {
      case 'none':
        if (current.current.step === 5) patch({ step: 4 });
        break;
      case 'register-pending':
        patch({ step: 4 });
        break;
      case 'register-failed':
        patch({ ...REGISTERED, step: 4 });
        setRegisterError(result.reason);
        break;
      case 'unlinked':
        patch({ ...REGISTERED, agentId: result.agentId, step: 5 });
        break;
      case 'linked':
        finish(result.agentId, null);
        break;
      default:
        setProblem(result);
    }
  }, [result, patch, finish]);

  // Signing with a separate agent wallet can move the wallet's selected account. Hold on to the creator
  // from then on, including on the success screen, or the wizard would reload as the agent wallet.
  const holdCreator = done !== null || (draft.agentId !== undefined && draft.walletMode === 'separate');
  useEffect(() => {
    onPinCreator(holdCreator ? creator : null);
  }, [holdCreator, creator, onPinCreator]);
  useEffect(() => () => onPinCreator(null), [onPinCreator]);

  function startNew() {
    const fresh = newDraft();
    current.current = fresh;
    setDraft(fresh);
    clearDraft(creator);
    setDone(null);
    setProblem(null);
    setRegisterError(null);
  }

  const goTo = (step: WizardStep) => patch({ step });

  if (done) {
    return (
      <section className="onboard">
        <SuccessScreen agentId={done.agentId} serial={done.serial} onAnother={startNew} />
      </section>
    );
  }

  if (check) {
    return (
      <section className="onboard">
        <h1>Onboard agent</h1>
        {progress.isError ? (
          <InlineError message="Could not read your agent from Hedera." onRetry={() => void progress.refetch()} />
        ) : (
          <div className="card" aria-busy="true">
            <p className="onboard-text muted">Checking your progress on Hedera…</p>
            <span className="skeleton skeleton-text" />
          </div>
        )}
      </section>
    );
  }

  if (problem) {
    return (
      <section className="onboard">
        <h1>Onboard agent</h1>
        <div className="card">
          <h3>Agent #{problem.agentId} can&apos;t be linked from this wallet</h3>
          <p className="onboard-text muted">
            {problem.state === 'missing'
              ? 'Hedera has no agent with this ID.'
              : 'It belongs to another wallet, or it is linked to another creator.'}
          </p>
          <div className="row">
            <button type="button" className="btn btn-outline" onClick={recheck}>
              Check again
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                patch({ agentId: undefined, linkTx: undefined, walletTx: undefined, associateTx: undefined, step: 4 });
                setProblem(null);
              }}
            >
              Back to review
            </button>
          </div>
        </div>
      </section>
    );
  }

  const step: WizardStep = draft.agentId !== undefined ? 5 : draft.step === 5 ? 4 : draft.step;

  return (
    <section className="onboard">
      <h1>Onboard agent</h1>
      <StepBar current={step} />

      {step === 1 && <DetailsStep draft={draft} patch={patch} onNext={() => goTo(2)} />}
      {step === 2 && <EndpointsStep draft={draft} patch={patch} onBack={() => goTo(1)} onNext={() => goTo(3)} />}
      {step === 3 && (
        <WalletStep creator={creator} draft={draft} patch={patch} onBack={() => goTo(2)} onNext={() => goTo(4)} />
      )}
      {step === 4 && (
        <ReviewStep
          creator={creator}
          draft={draft}
          patch={patch}
          error={registerError}
          onBack={() => goTo(3)}
          onRegistered={(agentId) => {
            setRegisterError(null);
            patch({ ...REGISTERED, agentId, step: 5 });
          }}
        />
      )}
      {step === 5 && draft.agentId !== undefined && (
        <LinkStep
          creator={creator}
          agentId={draft.agentId}
          draft={draft}
          patch={patch}
          onLinked={finish}
          onRecheck={recheck}
        />
      )}

      <footer className="onboard-foot">
        <p className="muted">
          {saved ? 'Progress saved — you can come back later' : 'This browser is blocking storage, so progress won’t be saved.'}
        </p>
        <StartOver draft={draft} onConfirm={startNew} />
      </footer>
    </section>
  );
}
