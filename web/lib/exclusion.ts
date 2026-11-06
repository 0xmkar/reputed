import type { ExclusionReason } from '@reputed/shared';

/** Why a review was not counted, phrased to follow "Not counted: ". */
export const EXCLUSION_TEXT: Record<ExclusionReason, string> = {
  revoked: 'the reviewer revoked this review',
  'hash-mismatch': 'the review file does not match its on-chain hash',
  'not-human-backed': 'the reviewer is not human-backed',
  'payment-not-found': 'no matching payment was found',
  'same-creator': 'the reviewer shares the agent’s creator',
};
