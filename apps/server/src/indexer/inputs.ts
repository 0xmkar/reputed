import { parseReviewFile } from '../scoring/filter.ts';
import { compareConsensus, type ConsensusTimestamp } from '../scoring/time.ts';
import { parsePaymentProof } from '../scoring/txid.ts';
import type { AgentInput, PaymentFact, ReviewInput, ScoringInputs } from '../scoring/types.ts';
import { agentWalletAt } from '../scoring/wallets.ts';
import { feedbackKey, type AgentIdentity, type ChainState, type FeedbackEvent } from './fold.ts';
import { toPaymentFact } from './mirror.ts';
import type { Facts, PaymentRecord, ReviewFileRecord } from './store.ts';

const HCS_URI = /^hcs:\/\/(\d+\.\d+\.\d+)\/(\d+)$/;

export function parseHcsUri(uri: string): { topicId: string; sequence: number } | null {
  const match = HCS_URI.exec(uri);
  if (!match) return null;
  // Safe integers only: 2^63-1 would round up to 2^63 here, which Mirror rejects.
  const sequence = Number(match[2]);
  return sequence >= 1 && Number.isSafeInteger(sequence) ? { topicId: match[1]!, sequence } : null;
}

export function agentInput(state: ChainState, agentId: string): AgentInput {
  const id: AgentIdentity | undefined = state.identities.get(agentId);
  const link = state.links.get(agentId);
  return {
    agentId,
    creator: link?.creator ?? null,
    // Only when it differs from the creator, so inputs of classic links hash as they did before grants.
    ...(link && link.owner !== link.creator ? { linkedOwner: link.owner } : {}),
    vouchedWallets: link?.wallets.map(({ wallet, from }) => ({ wallet, from })) ?? [],
    compromisedAt: state.compromisedAt.get(agentId) ?? null,
    walletHistory: id?.walletHistory ?? [],
    ownerHistory: id?.ownerHistory ?? [],
  };
}

export function reviewsInScope(state: ChainState, scope: ReadonlySet<string>): FeedbackEvent[] {
  return state.feedback.filter((feedback) => scope.has(feedback.agentId));
}

export function scoringScope(state: ChainState, extraAgentIds: Iterable<string> = []): Set<string> {
  return new Set([...state.links.keys(), ...extraAgentIds]);
}

/**
 * Agents a verified creator minted but nobody has linked, however early they were minted. These
 * come from the identity logs every sync already ingests, so finding them costs no Mirror request.
 * They belong to the live view only: snapshots hold linked agents.
 *
 * Only the mint counts. A transfer needs no consent from the receiver, so holding an agent would let
 * anyone with no World ID push agents into this list. A creator who received one can still link it.
 */
export function unlinkedCreatorAgents(state: ChainState): string[] {
  return [...state.identities.values()]
    .filter(({ agentId, ownerHistory }) => {
      const minter = ownerHistory[0]?.owner;
      return !state.links.has(agentId) && !!minter && state.creators.has(minter);
    })
    .map(({ agentId }) => agentId);
}

/** A found file cannot change. A miss only proves absence up to the time of the lookup. */
export function fileIsCurrent(
  record: ReviewFileRecord | undefined,
  feedback: FeedbackEvent,
): boolean {
  if (!record) return false;
  return record.fact !== null || compareConsensus(record.fetchedThrough, feedback.timestamp) >= 0;
}

/** Entries can appear under a known ID later: a scheduled transaction shares its ScheduleCreate's. */
export function paymentIsCurrent(
  record: PaymentRecord | undefined,
  feedback: FeedbackEvent,
): boolean {
  return !!record && compareConsensus(record.fetchedThrough, feedback.timestamp) >= 0;
}

/**
 * What a review's facts are worth at its own consensus time. A file or payment entry that appeared
 * after the review counts as absent, and a lookup older than the review counts as not done, so it
 * makes no difference when the cache learned of them: an old cache and a rebuild give the same
 * inputs (T5.8).
 */
export function factsForReview(
  feedback: FeedbackEvent,
  facts: Facts,
  reviewsTopicId: string,
): { fileBase64: string | null; payment: PaymentFact | null; complete: boolean } {
  const hcs = parseHcsUri(feedback.feedbackUri);
  if (hcs?.topicId !== reviewsTopicId) return { fileBase64: null, payment: null, complete: true };

  const record = facts.reviewFile(feedback.feedbackUri);
  if (!fileIsCurrent(record, feedback)) return { fileBase64: null, payment: null, complete: false };
  const file = record!.fact;
  const fileBase64 =
    file && compareConsensus(file.consensusTimestamp, feedback.timestamp) <= 0
      ? file.message
      : null;

  const proof = parsePaymentProof(parseReviewFile(fileBase64)?.proofOfPayment);
  if (!proof) return { fileBase64, payment: null, complete: true };

  const paymentRecord = facts.payment(proof.key);
  if (!paymentIsCurrent(paymentRecord, feedback)) {
    return { fileBase64, payment: null, complete: false };
  }
  const payment = toPaymentFact(
    paymentRecord!.transactions.filter(
      (entry) => compareConsensus(entry.consensus_timestamp, feedback.timestamp) < 0,
    ),
  );
  return { fileBase64, payment, complete: true };
}

/** The two wallets a payment check compares. Resolving only these keeps the input set minimal. */
export function walletsForPayment(
  feedback: FeedbackEvent,
  payment: PaymentFact,
  agent: AgentInput,
): string[] {
  const wallet = agentWalletAt(agent, payment.consensusTimestamp);
  return wallet ? [feedback.client, wallet] : [feedback.client];
}

export interface BuiltInputs {
  inputs: ScoringInputs;
  /** Reviews left out because their file, payment or accounts have not been fetched yet. */
  pending: number;
}

export function buildInputs(
  state: ChainState,
  facts: Facts,
  options: {
    asOf: ConsensusTimestamp;
    reviewsTopicId: string;
    extraAgentIds?: Iterable<string>;
    /** feedbackKeys of reviews whose last lookup failed, so their facts cannot be trusted. */
    unresolved?: ReadonlySet<string>;
  },
): BuiltInputs {
  const { asOf, reviewsTopicId, extraAgentIds, unresolved } = options;
  const scope = scoringScope(state, extraAgentIds);
  const agents = [...scope].map((id) => agentInput(state, id));
  const agentById = new Map(agents.map((agent) => [agent.agentId, agent]));

  const accounts: Record<string, string> = {};
  const reviews: ReviewInput[] = [];
  let pending = 0;

  for (const feedback of reviewsInScope(state, scope)) {
    const { fileBase64, payment, complete } = factsForReview(feedback, facts, reviewsTopicId);
    const key = feedbackKey(feedback.agentId, feedback.client, feedback.feedbackIndex);
    if (!complete || unresolved?.has(key)) {
      pending += 1;
      continue;
    }
    if (payment) {
      for (const wallet of walletsForPayment(feedback, payment, agentById.get(feedback.agentId)!)) {
        const record = facts.account(wallet);
        if (record && compareConsensus(record.createdAt, asOf) <= 0) {
          accounts[wallet] = record.accountId;
        }
      }
    }
    reviews.push({ ...feedback, fileBase64, payment });
  }

  return {
    inputs: {
      reviewsTopicId,
      creators: [...state.creators.values()],
      agents,
      reviews,
      accounts,
    },
    pending,
  };
}
