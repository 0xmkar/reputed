import type { Address, ExclusionReason, Tier } from '@reputed/shared';
import type { ConsensusTimestamp } from './time.ts';

export interface CreatorInput {
  wallet: Address;
  registeredAt: ConsensusTimestamp;
}

export interface WalletPeriodStart {
  wallet: Address | null;
  from: ConsensusTimestamp;
}

export interface VouchedWalletStart {
  wallet: Address;
  from: ConsensusTimestamp;
}

export interface OwnerPeriodStart {
  owner: Address;
  from: ConsensusTimestamp;
}

export interface AgentInput {
  agentId: string;
  /** Null for an agent that is not linked to a verified creator. */
  creator: Address | null;
  /** The wallets in AgentLinked and AgentWalletSynced: the only ones CreatorRegistry vouches for. */
  vouchedWallets: VouchedWalletStart[];
  compromisedAt: ConsensusTimestamp | null;
  walletHistory: WalletPeriodStart[];
  ownerHistory: OwnerPeriodStart[];
}

export interface PaymentTransfer {
  account: string;
  amount: string;
  /** Null means HBAR. */
  tokenId: string | null;
}

export interface PaymentFact {
  /** Canonical Mirror Node ID, also the single-use key. */
  txId: string;
  result: string;
  consensusTimestamp: ConsensusTimestamp;
  transfers: PaymentTransfer[];
}

export interface ReviewInput {
  agentId: string;
  client: Address;
  feedbackIndex: number;
  /** Raw int128 from the log, as a decimal string. */
  value: string;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackUri: string;
  feedbackHash: `0x${string}`;
  timestamp: ConsensusTimestamp;
  logIndex: number;
  txHash: string;
  revokedAt: ConsensusTimestamp | null;
  /** Base64 of the HCS message; null when there is no readable file on the reviews topic. */
  fileBase64: string | null;
  payment: PaymentFact | null;
}

export interface ScoringInputs {
  reviewsTopicId: string;
  creators: CreatorInput[];
  agents: AgentInput[];
  reviews: ReviewInput[];
  /** EVM address (lowercase) to Hedera account ID. */
  accounts: Record<string, string>;
}

export interface ClassifiedReview extends ReviewInput {
  normalizedValue: number | null;
  reviewerCreator: Address | null;
  reviewerHumanBacked: boolean;
  paymentVerified: boolean;
  counted: boolean;
  /** Passes every rule but the revocation one, so it counted until revokedAt, if that is set. */
  eligible: boolean;
  exclusionReason?: ExclusionReason;
  comment?: string;
}

export interface ConfirmedPenalty {
  agentId: string;
  creator: Address | null;
  category: string;
  basePoints: number;
  firstReportAt: ConsensusTimestamp;
  confirmedAt: ConsensusTimestamp;
  reporters: Address[];
  /** False when the first report came after the agent's compromise report. */
  countsAgainstCreator: boolean;
  /** After decay, at the scoring time. */
  points: number;
}

export interface AgentResult {
  agentId: string;
  creator: Address | null;
  score: number;
  tier: Tier;
  isNew: boolean;
  counted: number;
  excluded: number;
  /** Distinct reviewer creators: the agent's weight in its creator's average. */
  distinctReviewers: number;
  penaltiesConfirmed: number;
}

export interface CreatorResult {
  creator: Address;
  score: number;
  tier: Tier;
  P: number;
  penalties: ConfirmedPenalty[];
}

export interface ScoreResult {
  asOf: ConsensusTimestamp;
  configVersion: number;
  epochSeconds: number;
  agents: AgentResult[];
  creators: CreatorResult[];
  reviews: ClassifiedReview[];
  penalties: ConfirmedPenalty[];
  iterations: number;
}

export interface Snapshot {
  epoch: number;
  configVersion: number;
  epochSeconds: number;
  inputsHash: `0x${string}`;
  agents: { agentId: string; score: number; tier: Tier; counted: number; excluded: number }[];
  creators: { creator: Address; score: number; P: number }[];
}
