// The contract between server/ and web/. Change it only with both sides agreed.
export type Address = `0x${string}`;
export type Tier = 'Tier 1' | 'Tier 2' | 'Tier 3';

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INVALID_PROOF'
  | 'ALREADY_REGISTERED'
  | 'WALLET_TAKEN'
  | 'WORLD_UNAVAILABLE'
  | 'CHAIN_ERROR';

/** Every non-2xx response has this body. */
export interface ApiError {
  code: ApiErrorCode;
  message: string;
}

export interface Score {
  value: number; // 0-100
  tier: Tier;
  /** True when the value is inherited from the creator: show the "New" badge. */
  isNew: boolean;
}

export interface AgentEndpoints {
  a2a?: string;
  mcp?: string;
  web?: string;
  x402PriceHbar?: number;
}

export type AgentStatus = 'active' | 'compromised' | 'operator-changed';

export interface AgentSummary {
  agentId: string; // uint256 as a decimal string
  name: string;
  description: string;
  image?: string;
  tags: string[];
  owner: Address;
  wallet: Address | null; // null after the agent NFT is transferred
  creator: Address | null; // null when not linked to a verified human
  humanBacked: boolean;
  score: Score;
  creatorScore: number | null;
  reviewsCounted: number;
  registeredAt: string; // ISO 8601
  acceptsX402: boolean;
  status: AgentStatus;
}

export interface Credential {
  tokenId: string; // 0.0.x
  serial: number;
  kind: 'human-backed' | 'milestone';
  title: string;
  issuer?: string;
  issuedAt: string;
  revoked: boolean;
}

export type ExclusionReason =
  | 'revoked'
  | 'hash-mismatch'
  | 'not-human-backed'
  | 'payment-not-found'
  | 'same-creator';

export interface ReviewResponse {
  responder: Address;
  uri: string;
  text?: string;
  createdAt: string;
}

export interface Review {
  clientAddress: Address;
  feedbackIndex: number;
  value: number; // always normalised to 0-100
  tag1: string; // 'quality' | 'misconduct'
  tag2: string;
  endpoint: string;
  comment?: string;
  createdAt: string;
  paymentVerified: boolean;
  counted: boolean;
  exclusionReason?: ExclusionReason;
  reviewerHumanBacked: boolean;
  feedbackUri: string;
  txId: string; // 0x hash or consensus timestamp: both open with hashscan.tx()
  response?: ReviewResponse;
}

export interface AgentDetail extends AgentSummary {
  endpoints: AgentEndpoints;
  agentUri: string;
  operatorChanged: boolean;
  compromisedAt?: string;
  credentials: Credential[];
  reviews: Review[];
  reviewsExcluded: number;
  penaltiesConfirmed: number;
  updatedAt: string;
  snapshotUrl?: string;
  /** True when the latest snapshot is 2 or more epochs old. */
  scoresStale: boolean;
}

export interface PenaltyReport {
  clientAddress: Address;
  feedbackIndex: number;
  txId: string;
}

export interface Penalty {
  agentId: string;
  category: string;
  points: number; // current, after decay
  confirmedAt: string;
  /** When the points next halve; show as "halving in N days". */
  nextHalvingAt: string;
  reports: PenaltyReport[];
}

export interface CreatorDetail {
  address: Address;
  verifiedAt: string;
  score: number;
  tier: Tier;
  penaltyTotal: number;
  penalties: Penalty[];
  agents: AgentSummary[];
}

export interface AgentQuery {
  q?: string;
  humanBacked?: boolean;
  minScore?: number;
}

export interface AgentListResponse {
  agents: AgentSummary[];
  /** Global totals from the latest snapshot. They do not change with the query filters. */
  stats: { agents: number; humanBacked: number; creators: number; reviewsCounted: number };
  /** True when the latest snapshot is 2 or more epochs old. */
  scoresStale: boolean;
}
