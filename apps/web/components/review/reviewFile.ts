import {
  HEDERA_TESTNET,
  IDENTITY_REGISTRY,
  serializeReviewFile,
  type Address,
  type ReviewFile,
  type ReviewFileRequest,
  type ReviewFileResponse,
} from '@reputed/shared';
import { apiPost } from '@/lib/api';

// The review file is what the reviewer signs and what the server publishes to HCS. Its keccak-256
// goes on-chain as feedbackHash, so the file is built, signed and uploaded before giveFeedback is
// sent, and the transaction only references it.

export const MAX_COMMENT_LENGTH = 500;
/** The server refuses a file of this many bytes or more, because HCS caps a message at 1,024. */
export const MAX_FILE_BYTES = 1024;
const TAG2 = /^[a-z0-9-]{1,32}$/;

export const QUALITY_CATEGORIES = [
  { value: 'accuracy', label: 'Accuracy' },
  { value: 'speed', label: 'Speed' },
  { value: 'uptime', label: 'Uptime' },
  { value: 'communication', label: 'Communication' },
] as const;

// The scorer only penalises `fraud` and `failed-settlement` (server/src/scoring/config.ts).
export const MISCONDUCT_CATEGORIES = [
  { value: 'fraud', label: 'Fraud' },
  { value: 'failed-settlement', label: 'Failed settlement' },
  { value: 'other', label: 'Other' },
] as const;

const caip10 = (address: Address) => `eip155:${HEDERA_TESTNET.id}:${address}`;

export interface ReviewDraft {
  agentId: string;
  client: Address;
  value: number;
  tag1: ReviewFile['tag1'];
  tag2: string;
  endpoint: string;
  comment: string;
  proofOfPayment?: string | undefined;
}

/** An empty comment and a missing proof are left out, not written as empty strings. */
export function buildReviewFile(draft: ReviewDraft, createdAt: Date): ReviewFile {
  if (!TAG2.test(draft.tag2)) throw new Error('That category can’t be used in a review.');
  const comment = draft.comment.trim();
  return {
    agentRegistry: caip10(IDENTITY_REGISTRY),
    agentId: draft.agentId,
    clientAddress: caip10(draft.client),
    createdAt: createdAt.toISOString(),
    value: draft.value,
    valueDecimals: 0,
    tag1: draft.tag1,
    tag2: draft.tag2,
    endpoint: draft.endpoint,
    ...(comment ? { comment } : {}),
    ...(draft.proofOfPayment ? { proofOfPayment: draft.proofOfPayment } : {}),
  };
}

/** The size the file will be. toISOString always has the same length, so any date gives the answer. */
export function draftBytes(draft: ReviewDraft): number {
  return serializeReviewFile(buildReviewFile(draft, new Date(0))).length;
}

export function postReviewFile(file: ReviewFile, signature: `0x${string}`): Promise<ReviewFileResponse> {
  const body: ReviewFileRequest = { ...file, signature };
  return apiPost<ReviewFileResponse>('/api/review-file', body);
}
