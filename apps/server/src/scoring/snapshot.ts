// Snapshots and what makes them reproducible. inputsHash is keccak over canonical JSON of
// exactly what computeScores reads (asOf, config, creators, agents, reviews with their file
// hashes and sorted transfers, accounts), so two scorers with the same public data produce the
// same hash whatever order they fetched it in. Epoch arithmetic stays in BigInt nanoseconds.
import { keccak256, stringToHex } from 'viem';
import type { ScoringConfig } from './config.ts';
import { compareReviews } from './filter.ts';
import { compareIds } from './score.ts';
import { toNanos, type ConsensusTimestamp } from './time.ts';
import type { ReviewInput, ScoreResult, ScoringInputs, Snapshot } from './types.ts';

export const HCS_CHUNK_BYTES = 1024;

/** JSON with sorted keys and no optional whitespace, so equal data gives equal bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** The file body is replaced by its keccak: the bytes stay pinned and the hash input stays small. */
function canonicalReview(review: ReviewInput) {
  const { fileBase64, payment, ...rest } = review;
  return {
    ...rest,
    fileKeccak: fileBase64 === null ? null : keccak256(Buffer.from(fileBase64, 'base64')),
    payment: payment && {
      ...payment,
      transfers: [...payment.transfers].sort(
        (a, b) =>
          (a.tokenId ?? '').localeCompare(b.tokenId ?? '') ||
          a.account.localeCompare(b.account) ||
          a.amount.localeCompare(b.amount),
      ),
    },
  };
}

/** The hash covers everything the scores depend on, and nothing about how it was fetched. */
export function computeInputsHash(
  inputs: ScoringInputs,
  config: ScoringConfig,
  asOf: ConsensusTimestamp,
): `0x${string}` {
  const canonical = {
    asOf,
    config,
    reviewsTopicId: inputs.reviewsTopicId,
    creators: [...inputs.creators].sort((a, b) => a.wallet.localeCompare(b.wallet)),
    agents: [...inputs.agents].sort((a, b) => compareIds(a.agentId, b.agentId)),
    reviews: [...inputs.reviews].sort(compareReviews).map(canonicalReview),
    accounts: inputs.accounts,
  };
  return keccak256(stringToHex(canonicalJson(canonical)));
}

export function buildSnapshot(
  epoch: number,
  inputsHash: `0x${string}`,
  result: ScoreResult,
): Snapshot {
  return {
    epoch,
    configVersion: result.configVersion,
    epochSeconds: result.epochSeconds,
    inputsHash,
    agents: result.agents.map(({ agentId, score, tier, counted, excluded }) => ({
      agentId,
      score,
      tier,
      counted,
      excluded,
    })),
    creators: result.creators.map(({ creator, score, P }) => ({ creator, score, P })),
  };
}

/** JSON turns NaN and Infinity into null, so a bad score would otherwise publish as "no score". */
export function hasOnlyFiniteScores(snapshot: Snapshot): boolean {
  return [
    ...snapshot.agents.map((agent) => agent.score),
    ...snapshot.creators.flatMap((creator) => [creator.score, creator.P]),
  ].every(Number.isFinite);
}

export function chunksNeeded(message: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(message, 'utf8') / HCS_CHUNK_BYTES));
}

/** In BigInt because a double rounds the last nanosecond of an epoch up into the next one. */
export function epochOf(ts: ConsensusTimestamp, config: ScoringConfig): number {
  return Number(toNanos(ts) / (BigInt(config.epochSeconds) * 1_000_000_000n));
}

export function epochEnd(epoch: number, config: ScoringConfig): ConsensusTimestamp {
  return `${epoch * config.epochSeconds}.000000000`;
}
