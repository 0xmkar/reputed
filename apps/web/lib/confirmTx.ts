import { decodeErrorResult, hexToString, isHex, type Abi, type Address, type Hash, type Hex } from 'viem';
import { HEDERA_TESTNET, creatorRegistryAbi, identityRegistryAbi, reputationRegistryAbi } from '@reputed/shared';

// The Hashio relay answers 400 and 502 while polling for a receipt after a transaction has landed,
// so a failed receipt poll says nothing about the transaction. The Mirror Node is the record of what
// happened: it lags a few seconds, and until it answers the outcome is unknown, never failed.

export const POLL_INTERVAL_MS = 2_000;
/** When the UI switches to "Taking longer than usual". */
export const SLOW_AFTER_MS = 30_000;
/** Polling then stops until the user presses Refresh. The outcome stays unknown, not failed. */
export const STOP_POLLING_AFTER_MS = 180_000;
/** How long a send that returned no hash stays locked while Hedera is searched for it. */
export const RECONCILE_WINDOW_MS = 180_000;
const RECONCILE_GAP_MS = 4_000;

export interface TxLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

export interface ConfirmedTx {
  hash: Hash;
  logs: TxLog[];
  /** What the call returned, or `0x` if nothing. A token call can return a failure code here without reverting. */
  callResult: Hex;
}

export interface TxFailure {
  /** Set when the transaction reached the chain. Without it, nothing is known to have been sent. */
  hash?: Hash;
  /** Plain language, ready to show. */
  reason: string;
  /** The contract's custom error, for example `AlreadyLinked`. */
  errorName?: string;
  /** The Hedera response code behind a failed token call, for example 184. */
  responseCode?: number;
}

/** `unknown` means the Mirror Node has not answered yet. It is never treated as a failure. */
export type TxOutcome =
  | ({ status: 'confirmed' } & ConfirmedTx)
  | ({ status: 'reverted'; hash: Hash } & TxFailure)
  | { status: 'unknown'; hash: Hash };

const TOP_UP = 'Not enough HBAR. Top up from the testnet faucet.';

const CONTRACT_ERRORS: Record<string, string> = {
  NotCreator: 'This wallet is not a verified creator. Verify with World ID first.',
  AlreadyLinked: 'This agent is already linked to a creator.',
  NotAgentOwner: 'This wallet does not own that agent.',
  AgentWalletNotSet: 'This agent has no wallet set.',
  NotAgentCreator: 'Only the creator of this agent can do that.',
  AlreadyCompromised: 'This agent has been reported compromised.',
  WalletAlreadyLinked: 'That wallet is already linked to this agent.',
  CredentialTokenNotInitialized: 'The credential collection has not been set up yet.',
  InvalidHolder: 'That wallet cannot hold a credential.',
  ERC721NonexistentToken: 'This agent does not exist.',
  ERC721InsufficientApproval: 'This wallet is not allowed to manage that agent.',
  ERC721IncorrectOwner: 'This wallet does not own that agent.',
};

const REVERT_STRINGS: Record<string, string> = {
  'Not authorized': 'This wallet is not allowed to manage that agent.',
  'bad wallet': 'That agent wallet address is not valid.',
  expired: 'The agent wallet signature expired. Sign again.',
  'deadline too far': 'The agent wallet signature has too long a deadline. Sign again.',
  'invalid wallet sig': 'That signature did not come from the agent wallet. Sign again with that wallet.',
};

/** https://github.com/hashgraph/hedera-protobufs, ResponseCodeEnum. */
const RESPONSE_CODES: Record<number, string> = {
  15: 'That wallet has no Hedera account yet. Send it some HBAR first.',
  165: 'The credential is frozen on that wallet.',
  184: 'That wallet has to associate the credential token first.',
  194: 'That wallet is already associated with the credential token.',
  262: 'That wallet has no free token association slots. Associate the credential token first.',
};

const STATUS_TEXT: Record<string, string> = {
  INSUFFICIENT_GAS: 'The transaction ran out of gas.',
  INSUFFICIENT_PAYER_BALANCE: TOP_UP,
  INSUFFICIENT_ACCOUNT_BALANCE: TOP_UP,
  INSUFFICIENT_TX_FEE: TOP_UP,
  WRONG_NONCE: 'Your wallet was out of step with Hedera. Try again.',
};

const FALLBACK_REASON = 'The contract rejected the transaction.';

const knownErrors = [...creatorRegistryAbi, ...identityRegistryAbi, ...reputationRegistryAbi].filter(
  (item) => item.type === 'error',
) as Abi;

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function responseCodeText(code: number): string {
  return RESPONSE_CODES[code] ?? `Hedera refused the token operation (code ${code}).`;
}

/**
 * Turns a Mirror Node result into a reason. `error_message` is one of: ABI-encoded revert data, a
 * bare 32-byte Hedera response code when a token is called directly, a status name, or that status
 * name hex-encoded.
 */
export function describeRevert(result: string | null | undefined, errorMessage: string | null | undefined): Omit<TxFailure, 'hash'> {
  const fromStatus = (status: string | null | undefined): Omit<TxFailure, 'hash'> => ({
    reason: (status && STATUS_TEXT[status]) || FALLBACK_REASON,
  });

  if (!errorMessage) return fromStatus(result);
  if (!isHex(errorMessage) || errorMessage.length < 10) return fromStatus(STATUS_TEXT[errorMessage] ? errorMessage : result);

  try {
    const decoded = decodeErrorResult({ abi: knownErrors, data: errorMessage });
    const args = (decoded.args ?? []) as readonly unknown[];
    if (decoded.errorName === 'Error') {
      const text = String(args[0] ?? '');
      return { reason: REVERT_STRINGS[text] ?? sentence(`The contract said: ${text}`) };
    }
    if (decoded.errorName === 'HtsCallFailed') {
      const responseCode = Number(args[1]);
      return { reason: responseCodeText(responseCode), errorName: decoded.errorName, responseCode };
    }
    return { reason: CONTRACT_ERRORS[decoded.errorName] ?? FALLBACK_REASON, errorName: decoded.errorName };
  } catch {
    // Not an error any of these contracts declares. Try the two other encodings.
  }

  if (errorMessage.length === 66) {
    const responseCode = Number(BigInt(errorMessage));
    if (Number.isSafeInteger(responseCode)) return { reason: responseCodeText(responseCode), responseCode };
  }
  const text = hexToString(errorMessage);
  return fromStatus(/^[A-Z0-9_]+$/.test(text) ? text : result);
}

interface MirrorContractResult {
  result?: string | null;
  status?: string | null;
  error_message?: string | null;
  call_result?: string | null;
  logs?: { address: Address; topics: Hex[]; data: Hex | null }[] | null;
}

/** One look at the Mirror Node. Anything short of a complete record leaves the outcome unknown. */
export async function fetchTxOutcome(hash: Hash, signal?: AbortSignal): Promise<TxOutcome> {
  const unknown: TxOutcome = { status: 'unknown', hash };
  let body: MirrorContractResult;
  try {
    const res = await fetch(`${HEDERA_TESTNET.mirrorNode}/api/v1/contracts/results/${hash}`, { signal, cache: 'no-store' });
    // 404: not indexed yet. 206: the record is still being filled in.
    if (res.status !== 200) return unknown;
    body = (await res.json()) as MirrorContractResult;
  } catch (err) {
    if (signal?.aborted) throw err;
    return unknown;
  }

  // Two spellings of success: `result` is Hedera's response code name, `status` the EVM receipt field.
  if (body.result === 'SUCCESS' || body.status === '0x1') {
    const logs = (body.logs ?? []).map(({ address, topics, data }) => ({ address, topics, data: data ?? '0x' }));
    const callResult = isHex(body.call_result) ? body.call_result : '0x';
    return { status: 'confirmed', hash, logs, callResult };
  }
  // A 200 with neither field is a record that exists but has no verdict yet.
  if (!body.result && !body.status) return unknown;
  return { status: 'reverted', hash, ...describeRevert(body.result, body.error_message) };
}

const SUCCESS_CODE = 22;
const ALREADY_ASSOCIATED_CODE = 194;
const WORD_LENGTH = 66;

/**
 * HIP-719's associate() returns a Hedera response code as data and does not revert, so a transaction
 * that succeeded can still have failed to associate. Null means the wallet holds the association.
 */
export function associateFailure(callResult: Hex): Omit<TxFailure, 'hash'> | null {
  if (callResult.length !== WORD_LENGTH) return { reason: 'Hedera did not say whether the token was associated.' };
  const responseCode = Number(BigInt(callResult));
  if (responseCode === SUCCESS_CODE || responseCode === ALREADY_ASSOCIATED_CODE) return null;
  return { reason: responseCodeText(responseCode), responseCode };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Polls until the Mirror Node gives a verdict, or returns `unknown` after `stopAfterMs`. Rejects only
 * when `signal` aborts. An `unknown` result must never lead to the transaction being sent again.
 */
export async function confirmTx(
  hash: Hash,
  { signal, intervalMs = POLL_INTERVAL_MS, stopAfterMs = STOP_POLLING_AFTER_MS }: { signal?: AbortSignal; intervalMs?: number; stopAfterMs?: number } = {},
): Promise<TxOutcome> {
  const stopAt = Date.now() + stopAfterMs;
  for (;;) {
    const outcome = await fetchTxOutcome(hash, signal);
    if (outcome.status !== 'unknown' || Date.now() >= stopAt) return outcome;
    await sleep(intervalMs, signal);
  }
}

export type SendLookup<T> =
  | { status: 'found'; value: T }
  /** A clean look that found nothing. It may still appear. */
  | { status: 'absent' }
  /** The last look failed, which says nothing either way. */
  | { status: 'unavailable' };

/**
 * Searches for a send that returned no hash, at least once and then until `until`. `find` gives null
 * for nothing there, and throws when it could not look. Rejects only when `signal` aborts.
 */
export async function lookForSend<T>(
  find: (signal: AbortSignal) => Promise<T | null>,
  until: number,
  signal: AbortSignal,
  intervalMs = RECONCILE_GAP_MS,
): Promise<SendLookup<T>> {
  for (;;) {
    let last: SendLookup<T>;
    try {
      const value = await find(signal);
      if (value !== null) return { status: 'found', value };
      last = { status: 'absent' };
    } catch (err) {
      if (signal.aborted) throw err;
      last = { status: 'unavailable' };
    }
    if (Date.now() >= until) return last;
    await sleep(intervalMs, signal);
  }
}
