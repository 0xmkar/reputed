'use client';

import { useState } from 'react';
import type { OnboardDraft } from '@/lib/onboardDraft';

interface Props {
  draft: OnboardDraft;
  onConfirm: () => void;
}

/** The way out when a transaction never resolves. It can't undo anything on-chain, so it says what it leaves behind. */
export function StartOver({ draft, onConfirm }: Props) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <button type="button" className="onboard-link" onClick={() => setAsking(true)}>
        Start over
      </button>
    );
  }

  return (
    <div className="note-warn onboard-confirm" role="alert">
      <span>
        {draft.registerTx
          ? 'Your registration may still go through. Check it on HashScan first: starting over now could register a second agent.'
          : draft.linkTx
            ? 'Your link may still go through. Check it on HashScan first.'
            : draft.agentId !== undefined
              ? `Agent #${draft.agentId} stays registered on Hedera, but it won't be linked to you.`
              : 'This clears everything you have entered.'}
      </span>
      <span className="row">
        <button type="button" className="btn btn-outline btn-small" onClick={() => setAsking(false)}>
          Keep going
        </button>
        <button type="button" className="btn btn-primary btn-small" onClick={onConfirm}>
          Start over
        </button>
      </span>
    </div>
  );
}
