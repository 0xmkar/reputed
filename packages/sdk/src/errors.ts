/** Why a gate refused a counterparty. These are returned by verifyCounterparty, not thrown. */
export type GateFailure = 'NOT_HUMAN_BACKED' | 'SCORE_TOO_LOW' | 'AGENT_COMPROMISED';

/** Every code a ReputedError can carry. */
export type ReputedErrorCode =
  | GateFailure
  | 'INVALID_ARGUMENT' // a bad agent ID or option, caught before any request
  | 'AGENT_NOT_FOUND' // the API answered 404
  | 'API_ERROR' // the API was unreachable, or answered with an unexpected error
  | 'CHAIN_ERROR' // the API reported a Hedera or RPC failure
  | 'PAYMENT_NOT_FOUND' // reserved for review()
  | 'SELF_REVIEW'; // reserved for review()

export class ReputedError extends Error {
  readonly code: ReputedErrorCode;
  /** The HTTP status when the error came from an API response. */
  readonly status: number | undefined;

  constructor(code: ReputedErrorCode, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ReputedError';
    this.code = code;
    this.status = options.status;
  }
}
