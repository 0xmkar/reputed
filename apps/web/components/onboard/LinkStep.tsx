'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, useWriteContract } from 'wagmi';
import { getAddress, zeroAddress, type Address, type Hash } from 'viem';
import { HEDERA_TESTNET, IDENTITY_REGISTRY, creatorRegistryAbi, identityRegistryAbi } from '@reputed/shared';
import { serialFromLogs } from '@/lib/agentLogs';
import { chainClient } from '@/lib/chainClient';
import { associateFailure, type ConfirmedTx, type TxFailure } from '@/lib/confirmTx';
import { ASSOCIATE_GAS_ESTIMATE, CREATOR_REGISTRY, GAS, LINK_GAS_ESTIMATE, associateTokenAbi, gasCostUsd, hbarForGasLimit, tokenIdFromAddress } from '@/lib/contracts';
import { fetchHolderState } from '@/lib/mirror';
import type { OnboardDraft } from '@/lib/onboardDraft';
import { useCredentialToken } from '@/lib/useOnboardProgress';
import { AddressChip } from '../AddressChip';
import { CostHint } from '../CostHint';
import { InlineError } from '../InlineError';
import { TransactionButton, type TxPhase } from '../TransactionButton';
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
  onSigning: (signing: boolean) => void;
}

const WALLET_POLL_MS = 2_000;
/** How long a read gets to catch up with a confirmed setAgentWallet before that transaction is doubted. */
const WALLET_READBACK_MS = 60_000;
const NOT_A_LINK = 'NotALink';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function LinkStep({ creator, agentId, draft, patch, onLinked, onRecheck, onSigning }: Props) {
  const { addresses } = useAccount();
  const { mutateAsync: writeContract } = useWriteContract();
  const separate = draft.walletMode === 'separate';
  const target = separate ? getAddress(draft.agentWallet.toLowerCase()) : undefined;
  // A confirmed hash from a resumed draft could be any transaction, so only the chain's answer counts.
  const [walletCheck, setWalletCheck] = useState<'none' | 'waiting' | 'failed'>('none');

  const chainWallet = useQuery({
    queryKey: ['agent-wallet', agentId],
    retry: 2,
    // A read can trail the confirmation just after register, and an unset wallet reads as zero.
    refetchInterval: ({ state: { data } }) => {
      const awaited = walletCheck === 'waiting' && (data === undefined || !same(data, target as Address));
      return data === zeroAddress || awaited ? WALLET_POLL_MS : false;
    },
    queryFn: () =>
      chainClient.readContract({ address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: 'getAgentWallet', args: [BigInt(agentId)] }),
  });
  const token = useCredentialToken();
  const tokenId = token.data ? tokenIdFromAddress(token.data) : undefined;

  const [associated, setAssociated] = useState(false);
  const [forceAssociate, setForceAssociate] = useState(false);

  const walletReady = !separate || (chainWallet.data !== undefined && same(chainWallet.data, target as Address));
  const readWallet = chainWallet.data === zeroAddress ? undefined : chainWallet.data;
  const holder = target ?? readWallet;

  useEffect(() => {
    if (walletCheck !== 'waiting') return;
    const timer = setTimeout(() => setWalletCheck('failed'), WALLET_READBACK_MS);
    return () => clearTimeout(timer);
  }, [walletCheck]);

  const holderState = useQuery({
    queryKey: ['holder-state', holder, tokenId],
    enabled: Boolean(holder && tokenId && walletReady),
    retry: 1,
    queryFn: ({ signal }) => fetchHolderState(holder as Address, tokenId as string, signal),
  });

  // A failed link overrides a read that said the wallet needed no association, unless a later read finds one.
  const state = associated ? 'associated' : forceAssociate && holderState.data !== 'associated' ? 'needs-association' : holderState.data;
  const holderBlocked = state === 'needs-association' || state === 'no-account';
  const creatorAvailable = inWallet(addresses, creator);
  const holderAvailable = holder !== undefined && inWallet(addresses, holder);

  function linkFailed({ errorName, responseCode }: TxFailure) {
    patch({ linkTx: undefined });
    if (errorName === 'AlreadyLinked' || errorName === NOT_A_LINK) onRecheck();
    if (responseCode === 184 || responseCode === 262) {
      setAssociated(false);
      setForceAssociate(true);
      void holderState.refetch();
    }
    if (responseCode === 15) void holderState.refetch();
  }

  /** A hash read back from a resumed draft is only a link if it says it linked this agent. */
  function inspectLink({ logs }: ConfirmedTx) {
    return serialFromLogs(logs, agentId) === null ? { reason: 'That transaction did not link this agent.', errorName: NOT_A_LINK } : null;
  }

  function markAssociated() {
    setForceAssociate(false);
    setAssociated(true);
  }

  async function findAssociation(signal: AbortSignal): Promise<true | null> {
    return (await fetchHolderState(holder as Address, tokenId as string, signal)) === 'associated' ? true : null;
  }

  async function findLink(): Promise<true | null> {
    const linkedTo = await chainClient.readContract({
      address: CREATOR_REGISTRY,
      abi: creatorRegistryAbi,
      functionName: 'creatorOf',
      args: [BigInt(agentId)],
    });
    return same(linkedTo, creator) ? true : null;
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

  const signingFrom = (phase: TxPhase) => onSigning(phase === 'signing');

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
      ) : !walletReady && target && walletCheck === 'waiting' ? (
        <p className="onboard-text muted">Reading the new agent wallet from Hedera…</p>
      ) : !walletReady && target ? (
        <AgentWalletPanel
          agentId={agentId}
          creator={creator}
          agentWallet={target}
          pendingTx={draft.walletTx}
          creatorAvailable={creatorAvailable}
          onSubmitted={(hash) => patch({ walletTx: hash })}
          onSet={() => {
            setWalletCheck('waiting');
            patch({ walletTx: undefined });
            void chainWallet.refetch();
          }}
          onCleared={() => patch({ walletTx: undefined })}
          onPhase={signingFrom}
          notice={walletCheck === 'failed' ? 'Hedera still shows another wallet for this agent, so that transaction did not set it. Sign again.' : null}
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
                  inspect={({ callResult }) => associateFailure(callResult)}
                  onConfirmed={() => {
                    patch({ associateTx: undefined });
                    markAssociated();
                  }}
                  onFailed={() => {
                    patch({ associateTx: undefined });
                    // A result Hedera lost can hide a success, so look before asking for another try.
                    void holderState.refetch();
                  }}
                  findSent={findAssociation}
                  onFound={markAssociated}
                  onPhase={signingFrom}
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
        inspect={inspectLink}
        onConfirmed={({ logs }) => onLinked(agentId, serialFromLogs(logs, agentId))}
        onFailed={linkFailed}
        findSent={findLink}
        onFound={() => onLinked(agentId, null)}
        onPhase={signingFrom}
      />
    </div>
  );
}
