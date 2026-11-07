/** Everything that can stop onboarding or a reputation call, in words a developer can act on. */
export type ReputedAgentErrorCode =
  | 'INVALID_ARGUMENT' // a bad option, caught before any request
  | 'INVALID_API_KEY' // not an rpk_… key
  | 'NO_OPERATOR' // the Client has no operator account, so it cannot sign
  | 'NOT_CONFIGURED' // no API URL, or the server has no CreatorRegistry yet
  | 'API_ERROR' // the Reputed API was unreachable or answered badly
  | 'MIRROR_ERROR' // the Mirror Node was unreachable or answered badly
  | 'GRANT_NOT_FOUND' // the key was never authorized on-chain (or the transaction is still settling)
  | 'GRANT_EXPIRED'
  | 'GRANT_REVOKED'
  | 'GRANT_EXHAUSTED' // the key has already linked its maximum number of agents
  | 'INSUFFICIENT_HBAR' // the agent account cannot pay for the next transaction
  | 'LINKED_TO_OTHER_CREATOR' // the agent already belongs to someone else
  | 'OWNER_MISMATCH' // the registry's owner is not the account we expected
  | 'TRANSACTION_FAILED' // Hedera rejected or reverted a transaction
  | 'TIMEOUT'; // a transaction was submitted but its result never showed up

export class ReputedAgentError extends Error {
  readonly code: ReputedAgentErrorCode;
  /** Set when the failure came with a transaction, so it can be looked up on HashScan. */
  readonly transactionId: string | undefined;

  constructor(code: ReputedAgentErrorCode, message: string, options: { cause?: unknown; transactionId?: string } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ReputedAgentError';
    this.code = code;
    this.transactionId = options.transactionId;
  }
}
