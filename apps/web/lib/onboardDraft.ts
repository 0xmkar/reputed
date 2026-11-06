import { isAddress, isHash, type Address, type Hash } from 'viem';
import { EMPTY_FIELDS, type AgentFields } from './agentFile';

export type WizardStep = 1 | 2 | 3 | 4 | 5;
export type WalletMode = 'creator' | 'separate';

/**
 * What a closed tab needs to pick up again, kept per wallet. This is a hint only: anything about the
 * chain in here is checked against the chain before it is believed. See useOnboardProgress.
 */
export interface OnboardDraft {
  step: WizardStep;
  fields: AgentFields;
  walletMode: WalletMode;
  /** The separate agent wallet, when walletMode is 'separate'. */
  agentWallet: string;
  /** Decimal string. 0 is a valid agent ID, so compare against undefined and never for truthiness. */
  agentId?: string;
  /** Set just before the wallet is asked to register, so a lost hash can still be traced. */
  registerStartedAt?: number;
  pendingUri?: string;
  registerTx?: Hash;
  walletTx?: Hash;
  associateTx?: Hash;
  linkTx?: Hash;
}

export const newDraft = (): OnboardDraft => ({
  step: 1,
  fields: { ...EMPTY_FIELDS, tags: [] },
  walletMode: 'creator',
  agentWallet: '',
});

/** Everything in a draft that points at the chain. An unlinked agent has no other record, as no API lists agents by owner. */
const CHAIN_FIELDS = ['agentId', 'registerStartedAt', 'pendingUri', 'registerTx', 'walletTx', 'associateTx', 'linkTx'] as const;

export const draftKey = (wallet: Address) => `reputed:onboard:v1:${wallet.toLowerCase()}`;

/**
 * What a tab may save, given what another tab may have stored since this one last read. A chain field
 * only changes when `changes` names it: a tab holding an old copy must never erase an agent by saving.
 */
export function keepChainFields(next: OnboardDraft, stored: OnboardDraft | null, changes: Partial<OnboardDraft>): OnboardDraft {
  if (!stored) return next;
  const kept = CHAIN_FIELDS.filter((field) => !(field in changes)).map((field) => [field, stored[field]]);
  return { ...next, ...(Object.fromEntries(kept) as Partial<OnboardDraft>) };
}

export const chainFieldsDiffer = (a: OnboardDraft, b: OnboardDraft): boolean => CHAIN_FIELDS.some((field) => a[field] !== b[field]);

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const hash = (value: unknown) => (typeof value === 'string' && isHash(value) ? value : undefined);

/** Storage can hold anything, so each field is rebuilt rather than cast. */
function readDraft(raw: unknown): OnboardDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const draft = raw as Record<string, unknown>;
  const fields = (draft['fields'] ?? {}) as Record<string, unknown>;
  const step = draft['step'];
  const agentId = draft['agentId'];
  const startedAt = draft['registerStartedAt'];
  const agentWallet = text(draft['agentWallet']);

  const result: OnboardDraft = {
    step: step === 2 || step === 3 || step === 4 || step === 5 ? step : 1,
    fields: {
      name: text(fields['name']),
      description: text(fields['description']),
      image: text(fields['image']),
      tags: Array.isArray(fields['tags']) ? fields['tags'].filter((tag) => typeof tag === 'string') : [],
      a2a: text(fields['a2a']),
      mcp: text(fields['mcp']),
      web: text(fields['web']),
      x402: fields['x402'] === true,
      x402Price: text(fields['x402Price']),
    },
    walletMode: draft['walletMode'] === 'separate' ? 'separate' : 'creator',
    agentWallet: isAddress(agentWallet, { strict: false }) ? agentWallet : '',
  };
  if (typeof agentId === 'string' && /^\d+$/.test(agentId)) result.agentId = agentId;
  if (typeof startedAt === 'number' && Number.isFinite(startedAt)) result.registerStartedAt = startedAt;
  if (typeof draft['pendingUri'] === 'string') result.pendingUri = draft['pendingUri'];
  const registerTx = hash(draft['registerTx']);
  const walletTx = hash(draft['walletTx']);
  const associateTx = hash(draft['associateTx']);
  const linkTx = hash(draft['linkTx']);
  if (registerTx) result.registerTx = registerTx;
  if (walletTx) result.walletTx = walletTx;
  if (associateTx) result.associateTx = associateTx;
  if (linkTx) result.linkTx = linkTx;

  // Later steps need a wallet address, and an unusable one is only caught on the Agent wallet step.
  if (result.walletMode === 'separate' && !result.agentWallet && result.step > 3) {
    if (result.agentId === undefined) result.step = 3;
    else result.walletMode = 'creator';
  }
  return result;
}

export function loadDraft(wallet: Address): OnboardDraft | null {
  try {
    const stored = localStorage.getItem(draftKey(wallet));
    return stored === null ? null : readDraft(JSON.parse(stored));
  } catch {
    return null;
  }
}

/** False when the browser refused, so the page can stop promising that progress is saved. */
export function saveDraft(wallet: Address, draft: OnboardDraft): boolean {
  try {
    localStorage.setItem(draftKey(wallet), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(wallet: Address): void {
  try {
    localStorage.removeItem(draftKey(wallet));
  } catch {
    // Nothing to do: the draft stays, and its next check against the chain reports it as linked.
  }
}
