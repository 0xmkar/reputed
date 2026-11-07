// Mirror Node client for the indexer. Every read goes through getJson, which separates the
// three outcomes callers need: a record, a definitive miss from Mirror itself (null), and
// everything else, which is retried with exponential backoff and then thrown as MirrorError so
// the caller holds the epoch back instead of recording a guess.
import type { ConsensusTimestamp } from '../scoring/time.ts';
import { toMirrorTransactionId, type PaymentProof } from '../scoring/txid.ts';
import type { PaymentFact, PaymentTransfer } from '../scoring/types.ts';
import type { MirrorLog } from './decode.ts';

export class MirrorError extends Error {
  constructor(
    readonly status: number | null,
    path: string,
  ) {
    super(`Mirror Node ${status ?? 'network error'} for ${path}`);
    this.name = 'MirrorError';
  }
}

export interface MirrorClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

export interface LogPage {
  logs: MirrorLog[];
  next: string | null;
}

export interface TopicMessage {
  consensus_timestamp: ConsensusTimestamp;
  message: string;
  sequence_number: number;
  chunk_info?: {
    number: number;
    total: number;
    initial_transaction_id?: { account_id: string; transaction_valid_start: string; nonce: number };
  } | null;
}

export interface AccountRecord {
  accountId: string;
  createdAt: ConsensusTimestamp;
}

export interface MirrorTransaction {
  transaction_id: string;
  consensus_timestamp: ConsensusTimestamp;
  result: string;
  transfers?: { account: string; amount: number }[];
  token_transfers?: { token_id: string; account: string; amount: number }[];
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

/**
 * Mirror answers a miss with {"_status":{"messages":[...]}}. A gateway in front of it has been seen
 * answering a plain-text 404 for a valid path, and a miss can be final, so anything else is a failure.
 */
async function isMirrorNotFound(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { _status?: { messages?: unknown } } | null;
    return Array.isArray(body?._status?.messages);
  } catch {
    return false;
  }
}

export class MirrorClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly timeoutMs: number;

  constructor(options: MirrorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.doFetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 6;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /**
   * Null when Mirror itself says not found. Backs off on 429, 5xx, a 404 from anything else and
   * network failures, then throws MirrorError.
   */
  async getJson<T>(path: string): Promise<T | null> {
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) await this.sleep(this.delayFor(attempt, this.retryAfterMs));
      this.retryAfterMs = null;
      let response: Response;
      try {
        response = await this.doFetch(`${this.baseUrl}${path}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        lastStatus = null;
        continue;
      }
      if (response.status === 404 && (await isMirrorNotFound(response))) return null;
      if (response.ok) return (await response.json()) as T;
      lastStatus = response.status;
      if (response.status !== 404 && !RETRYABLE(response.status)) break;
      const header = Number(response.headers.get('retry-after'));
      this.retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : null;
    }
    throw new MirrorError(lastStatus, path);
  }

  /**
   * For IDs a review chose. Mirror answers 400 to an ID it could never hold, so here that means
   * not found, the same as 404. Everywhere else a 400 is our bug and stays an error.
   */
  private async lookup<T>(path: string): Promise<T | null> {
    try {
      return await this.getJson<T>(path);
    } catch (err) {
      if (err instanceof MirrorError && err.status === 400) return null;
      throw err;
    }
  }

  private retryAfterMs: number | null = null;

  private delayFor(attempt: number, retryAfterMs: number | null): number {
    const exponential = this.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(this.maxDelayMs, Math.max(exponential, retryAfterMs ?? 0));
  }

  /** The newest consensus time the mirror has fully ingested. Anything older is already readable. */
  async latestConsensusTimestamp(): Promise<ConsensusTimestamp> {
    const path = '/api/v1/blocks?limit=1&order=desc';
    const body = await this.getJson<{ blocks?: { timestamp?: { to?: string } }[] }>(path);
    const to = body?.blocks?.[0]?.timestamp?.to;
    if (!to) throw new MirrorError(null, path);
    return to;
  }

  firstLogsPath(address: string, fromTimestamp: ConsensusTimestamp | null): string {
    const from = fromTimestamp ? `&timestamp=gte:${fromTimestamp}` : '';
    return `/api/v1/contracts/${address}/results/logs?limit=100&order=asc${from}`;
  }

  async logsPage(path: string): Promise<LogPage> {
    const body = await this.getJson<{ logs?: MirrorLog[]; links?: { next?: string | null } }>(path);
    return { logs: body?.logs ?? [], next: body?.links?.next ?? null };
  }

  async topicMessage(topicId: string, sequence: number): Promise<TopicMessage | null> {
    return this.lookup<TopicMessage>(`/api/v1/topics/${topicId}/messages/${sequence}`);
  }

  async topicMessagesPage(path: string): Promise<{ messages: TopicMessage[]; next: string | null }> {
    const body = await this.getJson<{
      messages?: TopicMessage[];
      links?: { next?: string | null };
    }>(path);
    return { messages: body?.messages ?? [], next: body?.links?.next ?? null };
  }

  async account(evmAddress: string): Promise<AccountRecord | null> {
    const body = await this.lookup<{ account?: string; created_timestamp?: string | null }>(
      `/api/v1/accounts/${evmAddress}?transactions=false`,
    );
    if (!body?.account) return null;
    return { accountId: body.account, createdAt: body.created_timestamp ?? '0.000000000' };
  }

  /** Every entry under the proof, empty if there are none. See factsForReview for why not merged. */
  async payment(proof: PaymentProof): Promise<MirrorTransaction[]> {
    if (proof.kind === 'transaction-id') {
      const body = await this.lookup<{ transactions?: MirrorTransaction[] }>(
        `/api/v1/transactions/${proof.key}`,
      );
      return body?.transactions ?? [];
    }
    const result = await this.lookup<{ timestamp?: string }>(
      `/api/v1/contracts/results/${proof.key}`,
    );
    if (!result?.timestamp) return [];
    const body = await this.lookup<{ transactions?: MirrorTransaction[] }>(
      `/api/v1/transactions?timestamp=${result.timestamp}`,
    );
    return body?.transactions ?? [];
  }
}

/** One ID can return a parent and its children; only entries that succeeded moved money. */
export function toPaymentFact(entries: MirrorTransaction[]): PaymentFact | null {
  const first = entries[0];
  if (!first) return null;
  const succeeded = entries.filter((entry) => entry.result === 'SUCCESS');
  const txId = toMirrorTransactionId(first.transaction_id) ?? first.transaction_id;
  if (succeeded.length === 0) {
    return {
      txId,
      result: first.result,
      consensusTimestamp: first.consensus_timestamp,
      transfers: [],
    };
  }

  const transfers: PaymentTransfer[] = succeeded.flatMap((entry) => [
    ...(entry.transfers ?? []).map(({ account, amount }) => ({
      account,
      amount: String(amount),
      tokenId: null,
    })),
    ...(entry.token_transfers ?? []).map(({ account, amount, token_id }) => ({
      account,
      amount: String(amount),
      tokenId: token_id,
    })),
  ]);

  return {
    txId,
    result: 'SUCCESS',
    consensusTimestamp: succeeded
      .map((entry) => entry.consensus_timestamp)
      .sort()
      .at(-1)!,
    transfers,
  };
}
