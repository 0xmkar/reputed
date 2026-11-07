// Scorer settings, read without throwing on absence: the read API serves with whatever is set,
// and startEpochLoop reports, by name, what the publishing loop still needs.
import { HEDERA_TESTNET, IDENTITY_REGISTRY, REPUTATION_REGISTRY } from '@reputed/shared';

export interface ScorerSettings {
  mirrorNode: string;
  identityRegistry: string;
  reputationRegistry: string;
  /** Null until the contract is deployed: the read API then serves an empty set. */
  creatorRegistry: string | null;
  reviewsTopicId: string;
  scoresTopicId: string;
  credentialTokenId: string | null;
  dbPath: string;
  ipfsGateway: string;
  epochSeconds: number | null;
  pollMs: number;
  maxBackfillEpochs: number;
}

type Env = Record<string, string | undefined>;

const value = (env: Env, key: string) => (env[key] ? env[key] : undefined);

function positiveInteger(env: Env, key: string): number | null {
  const raw = value(env, key);
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive whole number`);
  }
  return parsed;
}

export function loadScorerSettings(env: Env = process.env): ScorerSettings {
  return {
    mirrorNode: value(env, 'MIRROR_NODE') ?? HEDERA_TESTNET.mirrorNode,
    identityRegistry: value(env, 'IDENTITY_REGISTRY') ?? IDENTITY_REGISTRY,
    reputationRegistry: value(env, 'REPUTATION_REGISTRY') ?? REPUTATION_REGISTRY,
    creatorRegistry: value(env, 'CREATOR_REGISTRY') ?? null,
    reviewsTopicId: value(env, 'REVIEWS_TOPIC_ID') ?? '',
    scoresTopicId: value(env, 'SCORES_TOPIC_ID') ?? '',
    credentialTokenId: value(env, 'CREDENTIAL_TOKEN_ID') ?? null,
    dbPath: value(env, 'SCORER_DB_PATH') ?? 'cache/scorer.sqlite',
    ipfsGateway: value(env, 'IPFS_GATEWAY') ?? 'https://ipfs.io/ipfs/',
    epochSeconds: positiveInteger(env, 'SCORER_EPOCH_SECONDS'),
    pollMs: positiveInteger(env, 'SCORER_POLL_MS') ?? 5_000,
    maxBackfillEpochs: positiveInteger(env, 'SCORER_MAX_BACKFILL_EPOCHS') ?? 24,
  };
}

/** What the loop cannot run without. Names only, never values. */
export function missingForLoop(settings: ScorerSettings): string[] {
  const missing: string[] = [];
  if (!settings.creatorRegistry) missing.push('CREATOR_REGISTRY');
  if (!settings.reviewsTopicId) missing.push('REVIEWS_TOPIC_ID');
  if (!settings.scoresTopicId) missing.push('SCORES_TOPIC_ID');
  if (!settings.credentialTokenId) missing.push('CREDENTIAL_TOKEN_ID');
  return missing;
}
