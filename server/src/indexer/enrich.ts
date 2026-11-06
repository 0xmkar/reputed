import { parseReviewFile } from '../scoring/filter.ts';
import type { ConsensusTimestamp } from '../scoring/time.ts';
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
  reviewsTopicId: string;
  ipfsGateway: string;
  fetch?: typeof fetch;
  now?: () => number;
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

async function resolveAccounts(
  store: Store,
  mirror: MirrorClient,
  wallets: string[],
): Promise<void> {
  for (const wallet of wallets) {
    if (store.account(wallet)) continue;
    const record = await mirror.account(wallet);
    if (record) store.saveAccount(wallet, record);
  }
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
  const unresolved = new Set<string>();
  for (const feedback of reviewsInScope(state, scope)) {
    try {
      await enrichReview(store, mirror, feedback, options);
      const { payment } = factsForReview(feedback, store, options.reviewsTopicId);
      if (payment) {
        const agent = agentInput(state, feedback.agentId);
        await resolveAccounts(store, mirror, walletsForPayment(feedback, payment, agent));
      }
    } catch (err) {
      if (!(err instanceof MirrorError)) throw err;
      await mirror.latestConsensusTimestamp();
      unresolved.add(feedbackKey(feedback.agentId, feedback.client, feedback.feedbackIndex));
    }
  }

  const now = (options.now ?? Date.now)();
  for (const agentId of scope) {
    const uri = state.identities.get(agentId)?.agentUri;
    if (!uri) continue;
    const cached = store.agentFile(uri);
    if (cached && (cached.body !== null || now - cached.fetchedAt < AGENT_FILE_RETRY_MS)) continue;
    store.saveAgentFile(uri, await loadAgentFile(uri, options), now);
  }
  return unresolved;
}
