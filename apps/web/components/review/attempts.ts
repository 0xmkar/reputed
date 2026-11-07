import { isHash, type Hash } from 'viem';
import type { Address, ReviewFileResponse } from '@reputed/shared';
import type { ReviewDraft } from './reviewFile';

// A payment or review is on its way the moment the wallet is asked, and a reload loses every in-memory
// trace of that, so each is written down first, per wallet and agent. This is a hint only: it says what
// to look for on Hedera. Nothing in here is believed until the Mirror Node confirms it.

export interface PaymentAttempt {
  startedAt: number;
  /** The amount sent, as a decimal string. */
  weibars: string;
  hash?: Hash;
}

export interface ReviewAttempt {
  startedAt: number;
  /** How many reviews the API had from this wallet when it was sent. */
  reviewsBefore: number;
  draft: ReviewDraft;
  upload: ReviewFileResponse;
  hash?: Hash;
}

const keyFor = (kind: 'payment' | 'review', client: Address, agentId: string) =>
  `reputed:attempt:v1:${kind}:${client.toLowerCase()}:${agentId}`;

function read(key: string): Record<string, unknown> | null {
  try {
    const stored = localStorage.getItem(key);
    const value: unknown = stored === null ? null : JSON.parse(stored);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Without storage, an attempt is only guarded until this tab goes away.
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to do: the next look finds the transaction, or finds nothing and asks.
  }
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const hashOf = (value: unknown): { hash?: Hash } => (typeof value === 'string' && isHash(value) ? { hash: value } : {});

// The loaders check every field. Text left by an older build must read as no attempt, not throw.

export function loadPaymentAttempt(client: Address, agentId: string): PaymentAttempt | null {
  const raw = read(keyFor('payment', client, agentId));
  if (!raw || !isTime(raw['startedAt']) || typeof raw['weibars'] !== 'string' || !/^\d+$/.test(raw['weibars'])) return null;
  return { startedAt: raw['startedAt'], weibars: raw['weibars'], ...hashOf(raw['hash']) };
}

export const savePaymentAttempt = (client: Address, agentId: string, attempt: PaymentAttempt) =>
  write(keyFor('payment', client, agentId), attempt);

export const clearPaymentAttempt = (client: Address, agentId: string) => remove(keyFor('payment', client, agentId));

function readReviewDraft(raw: unknown, client: Address, agentId: string): ReviewDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const draft = raw as Record<string, unknown>;
  const { value, tag1, tag2, endpoint, comment, proofOfPayment } = draft;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) return null;
  if (tag1 !== 'quality' && tag1 !== 'misconduct') return null;
  if (typeof tag2 !== 'string' || typeof endpoint !== 'string' || typeof comment !== 'string') return null;
  return { agentId, client, value, tag1, tag2, endpoint, comment, proofOfPayment: typeof proofOfPayment === 'string' ? proofOfPayment : undefined };
}

export function loadReviewAttempt(client: Address, agentId: string): ReviewAttempt | null {
  const raw = read(keyFor('review', client, agentId));
  if (!raw || !isTime(raw['startedAt']) || !isTime(raw['reviewsBefore'])) return null;
  const draft = readReviewDraft(raw['draft'], client, agentId);
  const upload = raw['upload'] as Partial<ReviewFileResponse> | null | undefined;
  if (!draft || typeof upload?.feedbackUri !== 'string' || typeof upload.feedbackHash !== 'string' || !isHash(upload.feedbackHash)) return null;
  return {
    startedAt: raw['startedAt'],
    reviewsBefore: raw['reviewsBefore'],
    draft,
    upload: { feedbackUri: upload.feedbackUri, feedbackHash: upload.feedbackHash },
    ...hashOf(raw['hash']),
  };
}

export const saveReviewAttempt = (client: Address, agentId: string, attempt: ReviewAttempt) =>
  write(keyFor('review', client, agentId), attempt);

export const clearReviewAttempt = (client: Address, agentId: string) => remove(keyFor('review', client, agentId));
