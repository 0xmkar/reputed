'use client';

import { useMemo, useRef, useState } from 'react';
import { useWriteContract } from 'wagmi';
import type { Address, Hash } from 'viem';
import { HEDERA_TESTNET, IDENTITY_REGISTRY, type AgentFileResponse } from '@reputed/shared';
import { agentIdFromLogs } from '@/lib/agentLogs';
import { MAX_AGENT_URI_BYTES, agentUriBytes, buildAgentFile } from '@/lib/agentFile';
import { apiPost } from '@/lib/api';
import type { ConfirmedTx, TxFailure } from '@/lib/confirmTx';
import { LINK_GAS_ESTIMATE, gasCostUsd, hbarForGasLimit, registerGas, registerGasEstimate, registerWithUriAbi } from '@/lib/contracts';
import { findRegistration } from '@/lib/mirror';
import type { OnboardDraft } from '@/lib/onboardDraft';
import { CostHint } from '../CostHint';
import { InlineError } from '../InlineError';
import { TransactionButton } from '../TransactionButton';
import { AddressChip } from '../AddressChip';
import type { PatchDraft } from './OnboardWizard';

const RECONCILE_ATTEMPTS = 3;
const RECONCILE_GAP_MS = 4_000;

interface Props {
  creator: Address;
  draft: OnboardDraft;
  patch: PatchDraft;
  error: string | null;
  onBack: () => void;
  onRegistered: (agentId: string) => void;
}

export function ReviewStep({ creator, draft, patch, error, onBack, onRegistered }: Props) {
  const { mutateAsync: writeContract } = useWriteContract();
  const file = useMemo(() => buildAgentFile(draft.fields), [draft.fields]);
  const uriBytes = agentUriBytes(file);
  const tooLarge = uriBytes > MAX_AGENT_URI_BYTES;

  const [reconciling, setReconciling] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const attempt = useRef<{ uri: string; startedAt: number } | null>(null);

  async function send(): Promise<Hash> {
    setNotice(null);
    setSending(true);
    attempt.current = null;
    try {
      const { uri } = await apiPost<AgentFileResponse>('/api/agent-file', file);
      const startedAt = Date.now();
      attempt.current = { uri, startedAt };
      patch({ pendingUri: uri, registerStartedAt: startedAt });
      return await writeContract({
        address: IDENTITY_REGISTRY,
        abi: registerWithUriAbi,
        functionName: 'register',
        args: [uri],
        gas: registerGas(uri.length),
        account: creator,
        chainId: HEDERA_TESTNET.id,
      });
    } catch (err) {
      setSending(false);
      throw err;
    }
  }

  function confirmed({ hash, logs }: ConfirmedTx) {
    const agentId = agentIdFromLogs(logs);
    if (agentId === null) {
      setNotice(`Hedera confirmed ${hash}, but its logs name no agent. Check it on HashScan.`);
      return;
    }
    onRegistered(agentId);
  }

  /**
   * A wallet can report an error after the relay accepted the transaction, and then no hash ever
   * reaches us. Sending again would register a second agent, so look on-chain before allowing Retry.
   */
  async function failed({ hash }: TxFailure) {
    setSending(false);
    if (hash) {
      patch({ registerTx: undefined, registerStartedAt: undefined, pendingUri: undefined });
      return;
    }
    const sent = attempt.current;
    if (!sent) return;
    setReconciling(true);
    for (let i = 0; i < RECONCILE_ATTEMPTS; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, RECONCILE_GAP_MS));
      const agentId = await findRegistration(creator, sent.uri, sent.startedAt).catch(() => null);
      if (agentId !== null) {
        onRegistered(agentId);
        return;
      }
    }
    setReconciling(false);
  }

  const inFlight = sending || Boolean(draft.registerTx);

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
        disabled={tooLarge || reconciling}
        onSend={send}
        onSubmitted={(hash) => patch({ registerTx: hash })}
        onConfirmed={confirmed}
        onFailed={failed}
      />
      {reconciling && <p className="onboard-text muted">Checking whether your registration went through…</p>}

      <div className="onboard-nav">
        <button type="button" className="btn btn-outline" disabled={inFlight || reconciling} onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
