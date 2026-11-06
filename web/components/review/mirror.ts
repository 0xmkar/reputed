import { HEDERA_TESTNET, REPUTATION_REGISTRY, reputationRegistryAbi, type Address } from '@reputed/shared';
import { decodeEventLog, formatUnits, numberToHex, pad, toEventSelector, type Hash, type Hex } from 'viem';

// Everything the review flow reads from the Mirror Node, and the rules the scorer applies to what
// comes back. The tick in the form has to mean what the scorer will later decide, so the ID parsing
// follows server/src/scoring/txid.ts and the payment check follows verifyPayment and toPaymentFact.

export class MirrorUnavailableError extends Error {
  constructor() {
    super('Couldn’t reach the Mirror Node.');
  }
}

async function request(path: string, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(`${HEDERA_TESTNET.mirrorNode}${path}`, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new MirrorUnavailableError();
  }
}

/** For IDs a person chose. Mirror answers 400 to an ID it could never hold, which means not found. */
async function lookup<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  const res = await request(path, signal);
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new MirrorUnavailableError();
  return (await res.json()) as T;
}

// ---- Transaction IDs ----

const SDK_FORM = /^(\d+\.\d+\.\d+)@(\d{1,19})\.(\d{1,9})$/;
const MIRROR_FORM = /^(\d+\.\d+\.\d+)-(\d{1,19})-(\d{1,9})$/;
const ETH_HASH = /^0x[0-9a-fA-F]{64}$/;

const MAX_SHARD = 1023n;
const MAX_REALM = 65535n;
const MAX_ACCOUNT_NUM = 2n ** 38n - 1n;
const MAX_VALID_START_SECONDS = 9_000_000_000n;

function isMirrorAccount(account: string): boolean {
  const [shard, realm, num] = account.split('.').map(BigInt) as [bigint, bigint, bigint];
  return shard <= MAX_SHARD && realm <= MAX_REALM && num <= MAX_ACCOUNT_NUM && shard + realm + num > 0n;
}

/** 0.0.x@s.n (wallets) to 0.0.x-s-n (Mirror Node). Nanos are padded so a payment has one spelling. */
export function toMirrorTransactionId(raw: string): string | null {
  const match = SDK_FORM.exec(raw.trim()) ?? MIRROR_FORM.exec(raw.trim());
  if (!match) return null;
  const [, account, seconds, nanos] = match;
  if (!isMirrorAccount(account!) || BigInt(seconds!) > MAX_VALID_START_SECONDS) return null;
  return `${account}-${seconds}-${nanos!.padStart(9, '0')}`;
}

export function toSdkTransactionId(raw: string): string | null {
  const mirror = toMirrorTransactionId(raw);
  if (!mirror) return null;
  const [account, seconds, nanos] = mirror.split('-');
  return `${account}@${seconds}.${nanos}`;
}

export type PaymentProof = { kind: 'transaction-id'; key: string } | { kind: 'eth-hash'; key: string };

/** A wallet that pays over JSON-RPC only ever shows the 0x hash, so the scorer accepts that too. */
export function parsePaymentProof(raw: unknown): PaymentProof | null {
  if (typeof raw !== 'string') return null;
  const id = toMirrorTransactionId(raw);
  if (id) return { kind: 'transaction-id', key: id };
  const trimmed = raw.trim();
  return ETH_HASH.test(trimmed) ? { kind: 'eth-hash', key: trimmed.toLowerCase() } : null;
}

// ---- Accounts and payments ----

/** The Hedera account behind an EVM address, or null if it has none. */
export async function fetchAccountId(address: Address, signal?: AbortSignal): Promise<string | null> {
  const body = await lookup<{ account?: string }>(`/api/v1/accounts/${address.toLowerCase()}?transactions=false`, signal);
  return body?.account ?? null;
}

export interface MirrorTransaction {
  transaction_id: string;
  consensus_timestamp: string;
  result: string;
  transfers?: { account: string; amount: number }[];
  token_transfers?: { token_id: string; account: string; amount: number }[];
}

/** Every entry under the proof, empty if there are none. One ID can hold a parent and its children. */
export async function fetchPaymentEntries(proof: PaymentProof, signal?: AbortSignal): Promise<MirrorTransaction[]> {
  if (proof.kind === 'transaction-id') {
    const body = await lookup<{ transactions?: MirrorTransaction[] }>(`/api/v1/transactions/${proof.key}`, signal);
    return body?.transactions ?? [];
  }
  const result = await lookup<{ timestamp?: string }>(`/api/v1/contracts/results/${proof.key}`, signal);
  if (!result?.timestamp) return [];
  const body = await lookup<{ transactions?: MirrorTransaction[] }>(`/api/v1/transactions?timestamp=${result.timestamp}`, signal);
  return body?.transactions ?? [];
}

export interface PaymentParties {
  reviewerAccount: string;
  agentAccount: string;
  /** The agent's registration time. It has no wallet before that, so an older payment cannot count. */
  notBeforeMs: number;
}

export interface VerifiedPayment {
  txId: string;
  consensusTimestamp: string;
  amount: string;
  asset: string;
}

export type PaymentCheck =
  | { ok: true; payment: VerifiedPayment }
  | { ok: false; reason: 'not-found' | 'failed' | 'no-match' | 'too-early' };

export function consensusToMs(timestamp: string): number {
  return Math.floor(Number(timestamp) * 1000);
}

/**
 * The scorer's rule: the transaction succeeded and, in at least one asset, the agent's account gained
 * a positive amount that the reviewer's account lost. Comparing the two matters because a reviewer
 * who only paid the fee on someone else's transfer also shows a loss.
 */
export function checkPayment(entries: MirrorTransaction[], parties: PaymentParties): PaymentCheck {
  const first = entries[0];
  if (!first) return { ok: false, reason: 'not-found' };
  const succeeded = entries.filter((entry) => entry.result === 'SUCCESS');
  if (succeeded.length === 0) return { ok: false, reason: 'failed' };

  const assets = new Map<string, Map<string, bigint>>();
  const add = (asset: string, account: string, amount: number) => {
    const accounts = assets.get(asset) ?? new Map<string, bigint>();
    accounts.set(account, (accounts.get(account) ?? 0n) + BigInt(amount));
    assets.set(asset, accounts);
  };
  for (const entry of succeeded) {
    for (const { account, amount } of entry.transfers ?? []) add('HBAR', account, amount);
    for (const { token_id, account, amount } of entry.token_transfers ?? []) add(token_id, account, amount);
  }

  const consensusTimestamp = succeeded.map((entry) => entry.consensus_timestamp).sort().at(-1)!;
  for (const [asset, flows] of assets) {
    const received = flows.get(parties.agentAccount) ?? 0n;
    const sent = -(flows.get(parties.reviewerAccount) ?? 0n);
    if (received > 0n && sent >= received) {
      if (consensusToMs(consensusTimestamp) < parties.notBeforeMs) return { ok: false, reason: 'too-early' };
      return {
        ok: true,
        payment: {
          txId: toMirrorTransactionId(first.transaction_id) ?? first.transaction_id,
          consensusTimestamp,
          amount: asset === 'HBAR' ? `${formatUnits(received, 8)} HBAR` : `${received} of token ${asset}`,
          asset,
        },
      };
    }
  }
  return { ok: false, reason: 'no-match' };
}

const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 3;

/**
 * HBAR payments from the reviewer to the agent, newest first. Mirror lists the reviewer's whole
 * history, including ETHEREUMTRANSACTION entries paid for by the relay's account, so the filter is
 * the payment rule itself and not a transaction type. A page can come back short and still have a
 * next link, so paging follows the link and not the row count.
 */
export async function fetchRecentPayments(parties: PaymentParties, signal?: AbortSignal): Promise<VerifiedPayment[]> {
  const since = Math.floor(parties.notBeforeMs / 1000);
  let path: string | null =
    `/api/v1/transactions?account.id=${parties.reviewerAccount}&timestamp=gte:${since}&limit=${LIST_PAGE_SIZE}&order=desc`;
  const byId = new Map<string, MirrorTransaction[]>();

  for (let page = 0; path && page < LIST_MAX_PAGES; page += 1) {
    const res = await request(path, signal);
    if (!res.ok) throw new MirrorUnavailableError();
    const body = (await res.json()) as { transactions?: MirrorTransaction[]; links?: { next?: string | null } };
    for (const entry of body.transactions ?? []) {
      const group = byId.get(entry.transaction_id);
      if (group) group.push(entry);
      else byId.set(entry.transaction_id, [entry]);
    }
    path = body.links?.next ?? null;
  }

  const payments: VerifiedPayment[] = [];
  for (const entries of byId.values()) {
    const check = checkPayment(entries, parties);
    if (check.ok && check.payment.asset === 'HBAR') payments.push(check.payment);
  }
  return payments.sort((a, b) => consensusToMs(b.consensusTimestamp) - consensusToMs(a.consensusTimestamp));
}

// A send that returned no hash is searched for from a little before it started, as this device's
// clock and Hedera's can differ.
const SEARCH_MARGIN_MS = 60_000;
const MAX_SEARCH_MS = 6 * 24 * 3600 * 1000; // The Mirror Node allows a topic search over at most 7 days.

/**
 * A payment of exactly this amount from the reviewer to the agent, made since the send started, or
 * null if there is none. Payments already cited by a review are skipped, as they are older sends.
 */
export async function findSentPayment(
  parties: PaymentParties,
  tinybars: bigint,
  sinceMs: number,
  used: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<VerifiedPayment | null> {
  const notBeforeMs = Math.max(parties.notBeforeMs, sinceMs - SEARCH_MARGIN_MS);
  const payments = await fetchRecentPayments({ ...parties, notBeforeMs }, signal);
  const amount = `${formatUnits(tinybars, 8)} HBAR`;
  return payments.find((payment) => payment.amount === amount && !used.has(payment.txId)) ?? null;
}

const NEW_FEEDBACK = toEventSelector('NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)');

/** Whether this wallet's review with this file hash is on-chain. Throws if the Mirror Node can't say. */
export async function findFeedback(agentId: string, client: Address, feedbackHash: Hash, sinceMs: number, signal?: AbortSignal): Promise<true | null> {
  const from = Math.floor((sinceMs - SEARCH_MARGIN_MS) / 1000);
  const to = Math.min(Math.ceil((Date.now() + SEARCH_MARGIN_MS) / 1000), from + MAX_SEARCH_MS / 1000);
  const query = new URLSearchParams({
    topic0: NEW_FEEDBACK,
    topic1: numberToHex(BigInt(agentId), { size: 32 }),
    topic2: pad(client.toLowerCase() as Hex),
    order: 'desc',
    limit: '25',
  });
  const res = await request(`/api/v1/contracts/${REPUTATION_REGISTRY}/results/logs?${query}&timestamp=gte:${from}&timestamp=lte:${to}`, signal);
  if (!res.ok) throw new MirrorUnavailableError();
  const body = (await res.json()) as { logs?: { topics: Hex[]; data: Hex | null }[] };

  for (const { topics, data } of body.logs ?? []) {
    const event = decodeEventLog({ abi: reputationRegistryAbi, eventName: 'NewFeedback', topics: topics as [Hex, ...Hex[]], data: data ?? '0x' });
    if (event.args.feedbackHash.toLowerCase() === feedbackHash.toLowerCase()) return true;
  }
  return null;
}

const HCS_URI = /^hcs:\/\/(\d+\.\d+\.\d+)\/(\d+)$/;

/** The payment cited by a published review file, or null if it cites none or cannot be read. */
export async function fetchCitedProof(feedbackUri: string, signal?: AbortSignal): Promise<PaymentProof | null> {
  const hcs = HCS_URI.exec(feedbackUri);
  if (!hcs) return null;
  const message = await lookup<{ message?: string }>(`/api/v1/topics/${hcs[1]}/messages/${hcs[2]}`, signal);
  if (!message?.message) return null;
  try {
    const bytes = Uint8Array.from(atob(message.message), (c) => c.charCodeAt(0));
    const file = JSON.parse(new TextDecoder().decode(bytes)) as { proofOfPayment?: unknown } | null;
    return parsePaymentProof(file?.proofOfPayment);
  } catch {
    return null;
  }
}
