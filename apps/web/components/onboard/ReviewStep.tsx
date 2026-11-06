'use client';

import { useMemo, useRef, useState } from 'react';
import { useWriteContract } from 'wagmi';
import type { Address, Hash } from 'viem';
import { HEDERA_TESTNET, IDENTITY_REGISTRY, type AgentFileResponse } from '@reputed/shared';
import { agentIdFromLogs } from '@/lib/agentLogs';
import { MAX_AGENT_URI_BYTES, agentUriBytes, buildAgentFile } from '@/lib/agentFile';
import { apiPost } from '@/lib/api';
import type { ConfirmedTx } from '@/lib/confirmTx';
import { LINK_GAS_ESTIMATE, gasCostUsd, hbarForGasLimit, registerGas, registerGasEstimate, registerWithUriAbi } from '@/lib/contracts';
import { findRegistration } from '@/lib/mirror';
import { loadDraft, type OnboardDraft } from '@/lib/onboardDraft';
import { withSendLock } from '@/lib/sendLock';
import { NotSentError, notSent } from '@/lib/walletError';
import { CostHint } from '../CostHint';
import { InlineError } from '../InlineError';
import { TransactionButton, type TxPhase } from '../TransactionButton';
import { AddressChip } from '../AddressChip';
import type { PatchDraft } from './OnboardWizard';

const OTHER_TAB = 'This agent is already being registered in another tab.';

interface Props {
  creator: Address;
  draft: OnboardDraft;
  patch: PatchDraft;
  error: string | null;
  onBack: () => void;
  onRegistered: (agentId: string) => void;
  onSigning: (signing: boolean) => void;
}

export function ReviewStep({ creator, draft, patch, error, onBack, onRegistered, onSigning }: Props) {
  const { mutateAsync: writeContract } = useWriteContract();
  const file = useMemo(() => buildAgentFile(draft.fields), [draft.fields]);
  const uriBytes = agentUriBytes(file);
  const tooLarge = uriBytes > MAX_AGENT_URI_BYTES;

  const [phase, setPhase] = useState<TxPhase>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  // Set once this send reaches the wallet. Stopping sooner leaves any earlier attempt's record alone.
  const walletAsked = useRef(false);

  /** Only one tab at a time gets past here, and it re-reads storage so it can't overtake another tab's attempt. */
  function send(): Promise<Hash> {
    setNotice(null);
    walletAsked.current = false;
    return withSendLock(`reputed:register:${creator.toLowerCase()}`, OTHER_TAB, async () => {
      const stored = loadDraft(creator);
      if (stored && (stored.registerTx || stored.agentId !== undefined || stored.registerStartedAt !== draft.registerStartedAt)) {
        throw notSent(OTHER_TAB);
      }
      const uri = await apiPost<AgentFileResponse>('/api/agent-file', file).then(
        (response) => response.uri,
        (err: unknown) => {
          throw new NotSentError(err);
        },
      );
      patch({ pendingUri: uri, registerStartedAt: Date.now() });
      walletAsked.current = true;
      return writeContract({
        address: IDENTITY_REGISTRY,
        abi: registerWithUriAbi,
        functionName: 'register',
        args: [uri],
        gas: registerGas(uri.length),
        account: creator,
        chainId: HEDERA_TESTNET.id,
      });
    });
  }

  function confirmed({ hash, logs }: ConfirmedTx) {
    const agentId = agentIdFromLogs(logs);
    if (agentId === null) {
      setNotice(`Hedera confirmed ${hash}, but its logs name no agent. Check it on HashScan.`);
      return;
    }
    onRegistered(agentId);
  }

  /** A second send mints a second agent, so a lost hash is searched for by the URI and the time it was sent. */
  function findSent(signal: AbortSignal): Promise<string | null> {
    const { pendingUri, registerStartedAt } = draft;
    if (!pendingUri || registerStartedAt === undefined) return Promise.resolve(null);
    return findRegistration(creator, pendingUri, registerStartedAt, signal);
  }

  const inFlight = phase === 'signing' || phase === 'confirming' || phase === 'unknown' || Boolean(draft.registerTx);

  return (
    <div className="card onboard-card">
      <h2>Review and register</h2>

      <dl className="onboard-summary">
        <div>
          <dt>Name</dt>
          <dd>{file.name}</dd>
        </div>
        {file.description && (
          <div>
            <dt>Description</dt>
            <dd>{file.description}</dd>
          </div>
        )}
        {file.services.map((service) => (
          <div key={service.name}>
            <dt>{service.name}</dt>
            <dd>{service.endpoint}</dd>
          </div>
        ))}
        {draft.fields.x402 && (
          <div>
            <dt>x402 price</dt>
            <dd>{draft.fields.x402Price} HBAR per call</dd>
          </div>
        )}
        <div>
          <dt>Agent wallet</dt>
          <dd>
            <AddressChip address={draft.walletMode === 'separate' ? draft.agentWallet : creator} />
          </dd>
        </div>
      </dl>

      <details className="onboard-json">
        <summary>Agent file (JSON)</summary>
        <pre className="mono">{JSON.stringify(file, null, 2)}</pre>
      </details>

      {tooLarge && (
        <InlineError
          message={`The agent file is too long: ${uriBytes.toLocaleString()} bytes, and the limit is ${MAX_AGENT_URI_BYTES.toLocaleString()}. Shorten the description or the URLs.`}
        />
      )}
      {error && <InlineError message={error} />}
      {notice && <InlineError message={notice} />}

      <p className="onboard-text">
        <CostHint usd={gasCostUsd(registerGasEstimate(uriBytes) + LINK_GAS_ESTIMATE)} />{' '}
        <span className="cost-hint muted">
          for registering and linking. Your wallet needs at least {hbarForGasLimit(registerGas(uriBytes))} HBAR to send each
          transaction.
        </span>
      </p>

      <TransactionButton
        label="Register agent"
        resumeHash={draft.registerTx}
        resumeStartedAt={draft.pendingUri ? draft.registerStartedAt : undefined}
        disabled={tooLarge}
        resendRisk="Registering again could mint a second agent and charge you twice."
        onSend={send}
        onSubmitted={(hash) => patch({ registerTx: hash })}
        onConfirmed={confirmed}
        onFailed={() => patch({ registerTx: undefined, registerStartedAt: undefined, pendingUri: undefined })}
        onNotSent={() => {
          if (walletAsked.current) patch({ registerStartedAt: undefined, pendingUri: undefined });
        }}
        findSent={findSent}
        onFound={onRegistered}
        onPhase={(next) => {
          setPhase(next);
          onSigning(next === 'signing');
        }}
      />

      <div className="onboard-nav">
        <button type="button" className="btn btn-outline" disabled={inFlight} onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
