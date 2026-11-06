import { parseReviewFile } from '../scoring/filter.ts';
import { compareConsensus, type ConsensusTimestamp } from '../scoring/time.ts';
import { parsePaymentProof } from '../scoring/txid.ts';
import { loadAgentFile } from './agentFile.ts';
import { feedbackKey, type ChainState, type FeedbackEvent } from './fold.ts';
import {
  agentInput,
  factsForReview,
  fileIsCurrent,
  parseHcsUri,
  paymentIsCurrent,
  reviewsInScope,
  walletsForPayment,
} from './inputs.ts';
import { MirrorError, type MirrorClient } from './mirror.ts';
import type { Store } from './store.ts';

const AGENT_FILE_RETRY_MS = 3_600_000;

export interface EnrichOptions {
  /** A consensus time the mirror had fully ingested before any lookup here started. */
  asOf: ConsensusTimestamp;
  /** The newest epoch boundary at or before asOf. See accountIsSettled. */
  epochBoundary: ConsensusTimestamp;
  reviewsTopicId: string;
  ipfsGateway: string;
  fetch?: typeof fetch;
  now?: () => number;
  /**
   * How many uncached reviews and agent files to fetch in this pass. Reviews past it stay
   * unresolved for a later pass. Unset for linked agents, which an epoch cannot publish without.
   */
  maxLookups?: number;
}

/**
 * Fetches each review's file and payment. A not-found answer is final for this review, since it
 * can only cite things that reached consensus before it and the mirror ingests in order. It is not
 * final for a later review citing the same thing, so each lookup records what it covers. Any other
 * failure throws, so a mirror outage delays the epoch instead of marking real payments as not found.
 */
async function enrichReview(
  store: Store,
  mirror: MirrorClient,
  feedback: FeedbackEvent,
  { reviewsTopicId, asOf }: EnrichOptions,
): Promise<void> {
  const hcs = parseHcsUri(feedback.feedbackUri);
  if (hcs?.topicId !== reviewsTopicId) return;

  if (!fileIsCurrent(store.reviewFile(feedback.feedbackUri), feedback)) {
    const message = await mirror.topicMessage(hcs.topicId, hcs.sequence);
    store.saveReviewFile(
      feedback.feedbackUri,
      message && { message: message.message, consensusTimestamp: message.consensus_timestamp },
      asOf,
    );
  }

  const { fileBase64 } = factsForReview(feedback, store, reviewsTopicId);
  const proof = parsePaymentProof(parseReviewFile(fileBase64)?.proofOfPayment);
  if (proof && !paymentIsCurrent(store.payment(proof.key), feedback)) {
    store.savePayment(proof.key, await mirror.payment(proof), asOf);
  }
}

/**
 * True when this wallet needs no lookup. A miss only proves absence up to its lookup, and it is what
 * stops a wallet with no account from being read again on every sync, ahead of every later review.
 * It lasts to the next epoch boundary rather than for a wall-clock period, because the inputs hash
 * covers accounts: an epoch must see any account created before it ended (T5.8), and the first sync
 * past the boundary re-reads the miss before that epoch is built.
 */
function accountIsSettled(
  store: Store,
  wallet: string,
  epochBoundary: ConsensusTimestamp,
): boolean {
  if (store.account(wallet)) return true;
  const miss = store.accountMiss(wallet);
  return miss !== undefined && compareConsensus(miss, epochBoundary) >= 0;
}

async function resolveAccounts(
  store: Store,
  mirror: MirrorClient,
  wallets: string[],
  { asOf, epochBoundary }: EnrichOptions,
): Promise<void> {
  for (const wallet of wallets) {
    if (accountIsSettled(store, wallet, epochBoundary)) continue;
    const record = await mirror.account(wallet);
    if (record) store.saveAccount(wallet, record);
    else store.saveAccountMiss(wallet, asOf);
  }
}

/** True when enriching this review would reach the mirror. */
function needsLookup(
  store: Store,
  state: ChainState,
  feedback: FeedbackEvent,
  { reviewsTopicId, epochBoundary }: EnrichOptions,
): boolean {
  const { payment, complete } = factsForReview(feedback, store, reviewsTopicId);
  if (!complete) return true;
  if (!payment) return false;
  const agent = agentInput(state, feedback.agentId);
  return walletsForPayment(feedback, payment, agent).some(
    (wallet) => !accountIsSettled(store, wallet, epochBoundary),
  );
}

/**
 * Returns the feedbackKeys of reviews that could not be resolved. One bad review must not stop the
 * others, but a failure the mirror's own health check shares is an outage, so that still throws.
 */
export async function enrichState(
  store: Store,
  mirror: MirrorClient,
  state: ChainState,
  scope: ReadonlySet<string>,
  options: EnrichOptions,
): Promise<Set<string>> {
  let lookupsLeft = options.maxLookups ?? Number.POSITIVE_INFINITY;

  // Before the reviews, so an agent with more reviews than the limit still gets its name and image.
  const now = (options.now ?? Date.now)();
  for (const agentId of scope) {
    const uri = state.identities.get(agentId)?.agentUri;
    if (!uri) continue;
    const cached = store.agentFile(uri);
    if (cached && (cached.body !== null || now - cached.fetchedAt < AGENT_FILE_RETRY_MS)) continue;
    if (lookupsLeft <= 0) break;
    lookupsLeft -= 1;
    store.saveAgentFile(uri, await loadAgentFile(uri, options), now);
  }

  const unresolved = new Set<string>();
  for (const feedback of reviewsInScope(state, scope)) {
    const key = feedbackKey(feedback.agentId, feedback.client, feedback.feedbackIndex);
    if (needsLookup(store, state, feedback, options)) {
      if (lookupsLeft <= 0) {
        unresolved.add(key);
        continue;
      }
      lookupsLeft -= 1;
    }
    try {
      await enrichReview(store, mirror, feedback, options);
      const { payment } = factsForReview(feedback, store, options.reviewsTopicId);
      if (payment) {
        const agent = agentInput(state, feedback.agentId);
        await resolveAccounts(store, mirror, walletsForPayment(feedback, payment, agent), options);
      }
    } catch (err) {
      if (!(err instanceof MirrorError)) throw err;
      await mirror.latestConsensusTimestamp();
      unresolved.add(key);
    }
  }
  return unresolved;
}
