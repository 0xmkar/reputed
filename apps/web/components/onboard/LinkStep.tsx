'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, useWriteContract } from 'wagmi';
import { getAddress, zeroAddress, type Address, type Hash } from 'viem';
import { HEDERA_TESTNET, IDENTITY_REGISTRY, creatorRegistryAbi, identityRegistryAbi } from '@reputed/shared';
import { serialFromLogs } from '@/lib/agentLogs';
import { chainClient } from '@/lib/chainClient';
import type { TxFailure } from '@/lib/confirmTx';
import { ASSOCIATE_GAS_ESTIMATE, CREATOR_REGISTRY, GAS, LINK_GAS_ESTIMATE, associateTokenAbi, gasCostUsd, hbarForGasLimit, tokenIdFromAddress } from '@/lib/contracts';
import { fetchHolderState } from '@/lib/mirror';
import type { OnboardDraft } from '@/lib/onboardDraft';
import { useCredentialToken } from '@/lib/useOnboardProgress';
import { AddressChip } from '../AddressChip';
import { CostHint } from '../CostHint';
import { InlineError } from '../InlineError';
import { TransactionButton } from '../TransactionButton';
import { LockIcon } from '../icons';
import { AgentWalletPanel, ShareWallet, inWallet } from './AgentWalletPanel';
import type { PatchDraft } from './OnboardWizard';

interface Props {
  creator: Address;
  agentId: string;
  draft: OnboardDraft;
  patch: PatchDraft;
  onLinked: (agentId: string, serial: number | null) => void;
  onRecheck: () => void;
}

const WALLET_POLL_MS = 2_000;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function LinkStep({ creator, agentId, draft, patch, onLinked, onRecheck }: Props) {
  const { addresses } = useAccount();
  const { mutateAsync: writeContract } = useWriteContract();
  const separate = draft.walletMode === 'separate';

  const chainWallet = useQuery({
    queryKey: ['agent-wallet', agentId],
    retry: 2,
    // A read can trail the confirmation just after register, and an unset wallet reads as zero.
    refetchInterval: (query) => (query.state.data === zeroAddress ? WALLET_POLL_MS : false),
    queryFn: () =>
      chainClient.readContract({ address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: 'getAgentWallet', args: [BigInt(agentId)] }),
  });
  const token = useCredentialToken();
  const tokenId = token.data ? tokenIdFromAddress(token.data) : undefined;

  // Set from the Mirror Node's confirmation, because a read can trail it for a moment.
  const [walletSet, setWalletSet] = useState(false);
  const [associated, setAssociated] = useState(false);
  const [forceAssociate, setForceAssociate] = useState(false);

  const target = separate ? getAddress(draft.agentWallet.toLowerCase()) : undefined;
  const walletReady = !separate || walletSet || (chainWallet.data !== undefined && same(chainWallet.data, target as Address));
  const readWallet = chainWallet.data === zeroAddress ? undefined : chainWallet.data;
  const holder = target ?? readWallet;

  const holderState = useQuery({
    queryKey: ['holder-state', holder, tokenId],
    enabled: Boolean(holder && tokenId && walletReady),
    retry: 1,
    queryFn: ({ signal }) => fetchHolderState(holder as Address, tokenId as string, signal),
  });

  const state = associated ? 'associated' : forceAssociate ? 'needs-association' : holderState.data;
  const holderBlocked = state === 'needs-association' || state === 'no-account';
  const creatorAvailable = inWallet(addresses, creator);
  const holderAvailable = holder !== undefined && inWallet(addresses, holder);

  function linkFailed({ hash, errorName, responseCode }: TxFailure) {
    if (hash) patch({ linkTx: undefined });
    if (errorName === 'AlreadyLinked') onRecheck();
    if (responseCode === 184 || responseCode === 262) {
      setAssociated(false);
      setForceAssociate(true);
    }
    if (responseCode === 15) void holderState.refetch();
  }

  function sendAssociate(): Promise<Hash> {
    return writeContract({
      address: token.data as Address,
      abi: associateTokenAbi,
      functionName: 'associate',
      gas: GAS.associate,
      account: holder as Address,
      chainId: HEDERA_TESTNET.id,
    });
  }

  function sendLink(): Promise<Hash> {
    return writeContract({
      address: CREATOR_REGISTRY,
      abi: creatorRegistryAbi,
      functionName: 'linkAgent',
      args: [BigInt(agentId)],
      gas: GAS.linkAgent,
      account: creator,
      chainId: HEDERA_TESTNET.id,
    });
  }

  if (chainWallet.data === undefined && chainWallet.isError) {
    return <InlineError message="Could not read this agent's wallet from Hedera." onRetry={() => void chainWallet.refetch()} />;
  }

  return (
    <div className="card onboard-card">
      <h2>Link and credential</h2>
      <p className="onboard-text">
        Agent <strong className="mono">#{agentId}</strong> is registered. Link it to your creator identity to receive its credential.
      </p>

      {!creatorAvailable && (
        <p className="note-warn">
          Switch your wallet back to <AddressChip address={creator} /> to continue.
        </p>
      )}

      {chainWallet.data === undefined || holder === undefined ? (
        <p className="onboard-text muted">Reading the agent wallet from Hedera…</p>
      ) : !walletReady && target ? (
        <AgentWalletPanel
          agentId={agentId}
          creator={creator}
          agentWallet={target}
          pendingTx={draft.walletTx}
          creatorAvailable={creatorAvailable}
          onSubmitted={(hash) => patch({ walletTx: hash })}
          onSet={() => {
            setWalletSet(true);
            patch({ walletTx: undefined });
            void chainWallet.refetch();
          }}
          onCleared={() => patch({ walletTx: undefined })}
        />
      ) : (
        <p className="onboard-row">
          <span className="pay-ok">✓ Agent wallet</span> {holder && <AddressChip address={holder} />}
        </p>
      )}

      {walletReady && token.isError && !token.data && (
        <InlineError message="Could not read the credential token from Hedera." onRetry={() => void token.refetch()} />
      )}

      {walletReady && tokenId && (
        <div className="onboard-association">
          {holderState.isPending && !state && <span className="skeleton skeleton-text" />}
          {holderState.isError && !state && (
            <InlineError message="Could not check the token association. You can still try to link." onRetry={() => void holderState.refetch()} />
          )}
          {state === 'associated' && <p className="onboard-row pay-ok">✓ Associated</p>}
          {state === 'auto' && <p className="onboard-row pay-ok">✓ Associates automatically when you link</p>}
          {state === 'no-account' && (
            <InlineError message="This wallet has no Hedera account yet. Send it some HBAR, then check again." onRetry={() => void holderState.refetch()} />
          )}
          {state === 'needs-association' &&
            (holder && !holderAvailable && !draft.associateTx ? (
              <ShareWallet address={holder} action="associate the credential token" />
            ) : (
              <div className="onboard-step-box">
                <p className="onboard-text">
                  This wallet has to accept the credential token before it can receive one. <CostHint usd={gasCostUsd(ASSOCIATE_GAS_ESTIMATE)} />
                </p>
                <TransactionButton
                  label="Associate token"
                  resumeHash={draft.associateTx}
                  onSend={sendAssociate}
                  onSubmitted={(hash) => patch({ associateTx: hash })}
                  onConfirmed={() => {
                    patch({ associateTx: undefined });
                    setForceAssociate(false);
                    setAssociated(true);
                  }}
                  onFailed={({ hash, responseCode }) => {
                    if (hash) patch({ associateTx: undefined });
                    // 194: it was already associated, which is what this step wanted.
                    if (responseCode === 194) {
                      setForceAssociate(false);
                      setAssociated(true);
                    }
                  }}
                />
              </div>
            ))}
        </div>
      )}

      <article className="card onboard-preview" aria-label="Credential preview">
        <header className="credential-head">
          <h3>Human-backed</h3>
          <span className="badge tier-new tier-badge">Not issued yet</span>
        </header>
        <p className="onboard-text muted">
          <LockIcon /> Non-transferable. Issued by CreatorRegistry to the agent wallet when you link.
        </p>
      </article>

      <p className="onboard-text">
        <CostHint usd={gasCostUsd(LINK_GAS_ESTIMATE)} />{' '}
        <span className="cost-hint muted">Your wallet needs at least {hbarForGasLimit(GAS.linkAgent)} HBAR to send this.</span>
      </p>

      <TransactionButton
        label="Link to my creator identity"
        resumeHash={draft.linkTx}
        disabled={!walletReady || !holder || holderBlocked || holderState.isLoading || !creatorAvailable || !tokenId}
        onSend={sendLink}
        onSubmitted={(hash) => patch({ linkTx: hash })}
        onConfirmed={({ logs }) => onLinked(agentId, serialFromLogs(logs))}
        onFailed={linkFailed}
      />
    </div>
  );
}
