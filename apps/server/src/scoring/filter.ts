// The review filter: which NewFeedback events count. Rules, in the order their failures are
// reported: file hash and fields match the chain, value within 0..100, reviewer human-backed at
// the review's time, payment verified and unclaimed, reviewer never backed by the agent's own
// creator; a revocation overrides them all. Everything here is pure and judged as of each
// review's consensus timestamp, so the same inputs classify the same way on any machine.
import type { Address, ExclusionReason } from '@reputed/shared';
import { keccak256 } from 'viem';
import { compareConsensus } from './time.ts';
import { parsePaymentProof } from './txid.ts';
import type {
  AgentInput,
  ClassifiedReview,
  PaymentFact,
  ReviewInput,
  ScoringInputs,
} from './types.ts';
import { agentWalletAt, buildWalletBindings, walletDirectory } from './wallets.ts';

export const MAX_VALUE_DECIMALS = 18;

/** int128 with valueDecimals, as a 0-100 number. Null when it is outside that range. */
export function normalizeValue(raw: string | bigint, decimals: number): number | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_VALUE_DECIMALS) return null;
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return null;
  }
  const scale = 10n ** BigInt(decimals);
  if (value < 0n || value > 100n * scale) return null;
  return Number(value) / Number(scale);
}

export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** A review file is untrusted JSON, so its tags may not be strings at all. */
function sameTag(fileTag: unknown, tag: string): boolean {
  return normalizeTag(typeof fileTag === 'string' ? fileTag : '') === normalizeTag(tag);
}

export interface ReviewFile {
  agentId?: string | number;
  clientAddress?: string;
  value?: string | number;
  valueDecimals?: string | number;
  tag1?: unknown;
  tag2?: unknown;
  comment?: string;
  proofOfPayment?: unknown;
}

export function parseReviewFile(fileBase64: string | null): ReviewFile | null {
  if (fileBase64 === null) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(fileBase64, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ReviewFile)
      : null;
  } catch {
    return null;
  }
}

/** Review files carry CAIP-10 addresses (eip155:296:0x...); the chain carries bare ones. */
function bareAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.slice(value.lastIndexOf(':') + 1).toLowerCase();
}

function sameInteger(a: string | number | undefined, b: string | number): boolean {
  if (a === undefined) return false;
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

/**
 * The hash alone proves the file was not altered, not that it describes this review: the same
 * file can be cited by a second giveFeedback with a different agent or value.
 */
export function fileMatchesReview(review: ReviewInput, file: ReviewFile | null): boolean {
  if (!file || review.fileBase64 === null) return false;
  const bytes = Buffer.from(review.fileBase64, 'base64');
  if (keccak256(bytes).toLowerCase() !== review.feedbackHash.toLowerCase()) return false;
  return (
    sameInteger(file.agentId, review.agentId) &&
    bareAddress(file.clientAddress) === review.client &&
    sameInteger(file.value, review.value) &&
    sameInteger(file.valueDecimals ?? 0, review.valueDecimals) &&
    sameTag(file.tag1, review.tag1) &&
    sameTag(file.tag2, review.tag2)
  );
}

function assetFlows(payment: PaymentFact): Map<string, Map<string, bigint>> {
  const assets = new Map<string, Map<string, bigint>>();
  for (const transfer of payment.transfers) {
    const asset = transfer.tokenId ?? 'HBAR';
    const accounts = assets.get(asset) ?? new Map<string, bigint>();
    accounts.set(transfer.account, (accounts.get(transfer.account) ?? 0n) + BigInt(transfer.amount));
    assets.set(asset, accounts);
  }
  return assets;
}

/**
 * Exists, SUCCESS, before the review, and in at least one asset the agent's wallet gained a
 * positive amount that the reviewer's account lost. Comparing the reviewer's net loss with the
 * agent's gain matters because a reviewer who only paid the fee on someone else's transfer also
 * shows a negative balance.
 */
export function verifyPayment(
  review: ReviewInput,
  agent: AgentInput | undefined,
  accounts: Record<string, string>,
): boolean {
  const payment = review.payment;
  if (!agent || !payment || payment.result !== 'SUCCESS') return false;
  if (compareConsensus(payment.consensusTimestamp, review.timestamp) >= 0) return false;

  const wallet = agentWalletAt(agent, payment.consensusTimestamp);
  if (!wallet) return false;
  const agentAccount = accounts[wallet];
  const reviewerAccount = accounts[review.client];
  if (!agentAccount || !reviewerAccount || agentAccount === reviewerAccount) return false;

  for (const flows of assetFlows(payment).values()) {
    const received = flows.get(agentAccount) ?? 0n;
    const sent = -(flows.get(reviewerAccount) ?? 0n);
    if (received > 0n && sent >= received) return true;
  }
  return false;
}

export function compareReviews(a: ReviewInput, b: ReviewInput): number {
  return compareConsensus(a.timestamp, b.timestamp) || a.logIndex - b.logIndex;
}

/**
 * Applies the plan's filter in order, so the first failed rule is the reason shown.
 * Runs in consensus order because the first review to cite a payment claims it. A review claims
 * one only after passing the file, value, human-backed and payment rules, and only while it is
 * unrevoked (revoking frees the payment): otherwise anyone could burn a stranger's payment by
 * citing it.
 * Linked agents go first, so an unlinked agent someone looked up cannot take a payment from one:
 * linked agents then classify exactly as they do in an epoch, which holds no unlinked agents.
 */
export function classifyReviews(inputs: ScoringInputs): ClassifiedReview[] {
  const agents = new Map(inputs.agents.map((agent) => [agent.agentId, agent]));
  const directory = walletDirectory(buildWalletBindings(inputs.creators, inputs.agents));
  const claimedPayments = new Set<string>();
  const unlinked = (review: ReviewInput) => (agents.get(review.agentId)?.creator ? 0 : 1);
  const ordered = [...inputs.reviews].sort(
    (a, b) => unlinked(a) - unlinked(b) || compareReviews(a, b),
  );

  return ordered.map((review) => {
    const agent = agents.get(review.agentId);
    const file = parseReviewFile(review.fileBase64);
    const normalizedValue = normalizeValue(review.value, review.valueDecimals);
    const reviewerCreator = directory.creatorAt(review.client, review.timestamp);
    const reviewerHumanBacked = reviewerCreator !== null;
    const fileOk = fileMatchesReview(review, file);
    const valueOk = normalizedValue !== null;
    const proofCited = parsePaymentProof(file?.proofOfPayment) !== null;

    let paymentVerified = proofCited && verifyPayment(review, agent, inputs.accounts);
    if (paymentVerified && fileOk && valueOk && reviewerHumanBacked) {
      const txId = review.payment!.txId;
      if (claimedPayments.has(txId)) paymentVerified = false;
      else if (review.revokedAt === null) claimedPayments.add(txId);
    }

    const sameCreator =
      agent?.creator != null &&
      directory.everBackedBy(review.client, agent.creator as Address, review.timestamp);

    let failedRule: ExclusionReason | undefined;
    if (!fileOk) failedRule = 'hash-mismatch';
    else if (!valueOk) failedRule = 'invalid-value';
    else if (!reviewerHumanBacked) failedRule = 'not-human-backed';
    else if (!paymentVerified) failedRule = 'payment-not-found';
    else if (sameCreator) failedRule = 'same-creator';
    const exclusionReason = review.revokedAt !== null ? 'revoked' : failedRule;

    const comment = typeof file?.comment === 'string' ? file.comment : undefined;
    return {
      ...review,
      normalizedValue,
      reviewerCreator,
      reviewerHumanBacked,
      paymentVerified,
      counted: exclusionReason === undefined,
      eligible: failedRule === undefined,
      ...(exclusionReason ? { exclusionReason } : {}),
      ...(comment !== undefined ? { comment } : {}),
    };
  });
}
