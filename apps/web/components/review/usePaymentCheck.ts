'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentDetail, Address, Review } from '@reputed/shared';
import {
  checkPayment,
  fetchAccountId,
  fetchCitedProof,
  fetchPaymentEntries,
  fetchRecentPayments,
  parsePaymentProof,
  toMirrorTransactionId,
  type PaymentParties,
  type VerifiedPayment,
} from './mirror';

// Decides, before the review is signed, whether the chosen payment will count. The checks are the
// scorer's: the transaction exists and succeeded, moves value from the reviewer to the agent, is not
// older than the agent, and has not been cited by another counted review from this wallet.

const POLL_MS = 2_000;
const LOOK_FOR_MS = 30_000;

export type PaymentState =
  /** Nothing chosen. The review can go ahead, but it won't count. */
  | { kind: 'none' }
  /** No payment can be made or checked, for the reason given. */
  | { kind: 'unavailable'; message: string }
  | { kind: 'invalid' }
  | { kind: 'checking' }
  /** The Mirror Node has no such transaction. It may still be lagging until `searching` is false. */
  | { kind: 'not-found'; searching: boolean }
  | { kind: 'rejected'; message: string }
  | { kind: 'error' }
  | { kind: 'verified'; payment: VerifiedPayment };

export interface PaymentCheck {
  state: PaymentState;
  /** Set once both accounts are known. */
  parties: PaymentParties | null;
  recent: { payments: VerifiedPayment[]; isLoading: boolean; isError: boolean; refetch: () => void };
  usedIds: ReadonlySet<string>;
  retry: () => void;
}

const REJECTED_TEXT = {
  failed: 'That transaction failed on Hedera, so no payment was made.',
  'no-match': 'That transaction isn’t a payment from this wallet to the agent’s wallet.',
  'too-early': 'That payment was made before this agent was registered.',
} as const;

/** Only these reviews claimed their payment: the scorer ignores the rest when it marks one as used. */
function claimedPayment(review: Review, client: Address): boolean {
  return (
    review.clientAddress.toLowerCase() === client.toLowerCase() &&
    review.paymentVerified &&
    review.reviewerHumanBacked &&
    review.exclusionReason !== 'revoked' &&
    review.exclusionReason !== 'hash-mismatch' &&
    review.exclusionReason !== 'invalid-value'
  );
}

/** Each payment counts for one review. Review doesn't say which it cited, so read that from the files. */
async function fetchUsedIds(uris: string[], signal: AbortSignal): Promise<string[]> {
  const ids = await Promise.all(
    uris.map(async (uri) => {
      const proof = await fetchCitedProof(uri, signal);
      if (!proof) return null;
      const first = (await fetchPaymentEntries(proof, signal))[0];
      return first ? (toMirrorTransactionId(first.transaction_id) ?? first.transaction_id) : null;
    }),
  );
  return ids.filter((id) => id !== null);
}

/** `raw` is what the reviewer picked or pasted, and `settling` is true while they are still typing. */
export function usePaymentCheck(agent: AgentDetail, client: Address, raw: string, settling: boolean): PaymentCheck {
  const wallet = agent.wallet;
  const ownWallet = wallet?.toLowerCase() === client.toLowerCase();

  const reviewerAccount = useQuery({
    queryKey: ['mirror-account', client.toLowerCase()],
    retry: false,
    queryFn: ({ signal }) => fetchAccountId(client, signal),
  });
  const agentAccount = useQuery({
    queryKey: ['mirror-account', wallet?.toLowerCase()],
    enabled: wallet !== null,
    retry: false,
    queryFn: ({ signal }) => fetchAccountId(wallet!, signal),
  });

  const parties = useMemo<PaymentParties | null>(
    () =>
      reviewerAccount.data && agentAccount.data
        ? {
            reviewerAccount: reviewerAccount.data,
            agentAccount: agentAccount.data,
            notBeforeMs: Date.parse(agent.registeredAt) || 0,
          }
        : null,
    [reviewerAccount.data, agentAccount.data, agent.registeredAt],
  );

  const recent = useQuery({
    queryKey: ['recent-payments', parties],
    enabled: parties !== null && !ownWallet,
    retry: false,
    queryFn: ({ signal }) => fetchRecentPayments(parties!, signal),
  });

  const claimedUris = useMemo(
    () => agent.reviews.filter((r) => claimedPayment(r, client)).map((r) => r.feedbackUri),
    [agent.reviews, client],
  );
  const used = useQuery({
    queryKey: ['used-payments', claimedUris],
    enabled: claimedUris.length > 0,
    retry: false,
    queryFn: ({ signal }) => fetchUsedIds(claimedUris, signal),
  });
  const usedIds = useMemo(() => new Set(used.data ?? []), [used.data]);

  const proof = settling ? null : parsePaymentProof(raw);
  const proofKey = proof?.key ?? null;
  // A pasted ID that is not found keeps polling for LOOK_FOR_MS, then is reported missing until Refresh.
  const [searching, setSearching] = useState(true);
  const [searchRun, setSearchRun] = useState(0);
  useEffect(() => {
    setSearching(true);
    if (proofKey === null) return;
    const timer = setTimeout(() => setSearching(false), LOOK_FOR_MS);
    return () => clearTimeout(timer);
  }, [proofKey, searchRun]);

  const entries = useQuery({
    queryKey: ['payment-entries', proof],
    enabled: proof !== null && parties !== null,
    retry: false,
    queryFn: ({ signal }) => fetchPaymentEntries(proof!, signal),
    // A payment sent moments ago takes a few seconds to reach the Mirror Node.
    refetchInterval: (query) => (query.state.data?.length || !searching ? false : POLL_MS),
  });

  function resolve(): PaymentState {
    if (wallet === null) return { kind: 'unavailable', message: 'This agent has no wallet right now, so a payment can’t be sent or checked.' };
    if (ownWallet) return { kind: 'unavailable', message: 'This is the agent’s own wallet, so a payment from it can’t count.' };
    if (reviewerAccount.isError || agentAccount.isError) return { kind: 'error' };
    if (reviewerAccount.data === null) {
      return { kind: 'unavailable', message: 'This wallet has no Hedera account yet. Top up from the testnet faucet.' };
    }
    if (agentAccount.data === null) return { kind: 'unavailable', message: 'The agent’s wallet has no Hedera account yet.' };

    if (!raw.trim()) return { kind: 'none' };
    if (settling) return { kind: 'checking' };
    if (!proof) return { kind: 'invalid' };
    if (!parties) return { kind: 'checking' };
    if (entries.isError || used.isError) return { kind: 'error' };
    if (!entries.data || used.isLoading) return { kind: 'checking' };

    const check = checkPayment(entries.data, parties);
    if (check.ok) {
      if (usedIds.has(check.payment.txId)) {
        return { kind: 'rejected', message: 'You’ve already used this payment for a review. Each payment counts once.' };
      }
      return { kind: 'verified', payment: check.payment };
    }
    if (check.reason === 'not-found') return { kind: 'not-found', searching };
    return { kind: 'rejected', message: REJECTED_TEXT[check.reason] };
  }

  return {
    state: resolve(),
    parties,
    recent: {
      payments: recent.data ?? [],
      isLoading: recent.isLoading || reviewerAccount.isLoading || agentAccount.isLoading,
      isError: recent.isError,
      refetch: () => void recent.refetch(),
    },
    usedIds,
    retry: () => {
      setSearchRun((n) => n + 1);
      if (reviewerAccount.isError) void reviewerAccount.refetch();
      if (agentAccount.isError) void agentAccount.refetch();
      if (used.isError) void used.refetch();
      if (proof && parties) void entries.refetch();
    },
  };
}
