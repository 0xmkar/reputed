'use client';

import { useQuery } from '@tanstack/react-query';
import { getAddress, isAddress, type Address } from 'viem';
import { checkAgentWallet } from '@/lib/mirror';
import type { OnboardDraft } from '@/lib/onboardDraft';
import { useDebounced } from '@/lib/useDebounced';
import { AddressChip } from '../AddressChip';
import type { PatchDraft } from './OnboardWizard';
import { StepNav } from './StepNav';

interface Props {
  creator: Address;
  draft: OnboardDraft;
  patch: PatchDraft;
  onBack: () => void;
  onNext: () => void;
}

export function WalletStep({ creator, draft, patch, onBack, onNext }: Props) {
  const separate = draft.walletMode === 'separate';
  const typed = draft.agentWallet.trim();
  const debounced = useDebounced(typed);
  const wellFormed = isAddress(typed, { strict: false });
  const isCreatorWallet = wellFormed && typed.toLowerCase() === creator.toLowerCase();
  const canCheck = separate && isAddress(debounced, { strict: false }) && debounced.toLowerCase() !== creator.toLowerCase();

  const check = useQuery({
    queryKey: ['agent-wallet-check', debounced.toLowerCase()],
    enabled: canCheck,
    retry: 1,
    queryFn: ({ signal }) => checkAgentWallet(debounced as Address, signal),
  });

  const checked = canCheck && debounced === typed;
  const problem = checked ? check.data : undefined;
  const ready = !separate || (wellFormed && !isCreatorWallet && checked && (check.isError || check.data === null));

  function next() {
    if (separate) patch({ agentWallet: getAddress(typed.toLowerCase()) });
    onNext();
  }

  return (
    <div className="card onboard-card">
      <h2>Agent wallet</h2>
      <p className="onboard-text muted">This wallet receives the Human-backed credential and any payments to the agent.</p>

      <div className="onboard-radios" role="radiogroup" aria-label="Agent wallet">
        <label className="check">
          <input type="radio" name="wallet-mode" checked={!separate} onChange={() => patch({ walletMode: 'creator' })} />
          Use my creator wallet
        </label>
        {!separate && (
          <div className="onboard-indent">
            <AddressChip address={creator} />
          </div>
        )}
        <label className="check">
          <input type="radio" name="wallet-mode" checked={separate} onChange={() => patch({ walletMode: 'separate' })} />
          Use a separate agent account
        </label>
      </div>

      {separate && (
        <div className="field">
          <label htmlFor="agent-wallet">Agent wallet address</label>
          <input
            id="agent-wallet"
            className="input mono"
            placeholder="0x"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={(typed !== '' && !wellFormed) || isCreatorWallet || Boolean(problem)}
            value={draft.agentWallet}
            onChange={(event) => patch({ agentWallet: event.target.value })}
          />
          {typed !== '' && !wellFormed && <span className="field-hint error-text">Enter a 0x address.</span>}
          {isCreatorWallet && <span className="field-hint error-text">That is your creator wallet. Choose the first option instead.</span>}
          {problem && <span className="field-hint error-text">{problem}</span>}
          {checked && check.isError && (
            <span className="field-hint muted">Could not look this address up on Hedera. You can still continue.</span>
          )}
          <span className="field-hint muted">
            You sign with this wallet after registering, because the signature has to name the new agent. It needs to be in the
            same browser wallet as your creator wallet.
          </span>
        </div>
      )}

      <StepNav onBack={onBack} onNext={next} nextDisabled={!ready} />
    </div>
  );
}
