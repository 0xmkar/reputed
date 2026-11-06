import type { Address } from '@reputed/shared';
import { compareConsensus, type ConsensusTimestamp } from './time.ts';
import type { AgentInput, CreatorInput } from './types.ts';

export interface WalletBinding {
  wallet: Address;
  creator: Address;
  from: ConsensusTimestamp;
  to: ConsensusTimestamp | null;
  kind: 'creator' | 'agent';
}

export function ownerAt(agent: AgentInput, at: ConsensusTimestamp): Address | null {
  let owner: Address | null = null;
  for (const period of agent.ownerHistory) {
    if (compareConsensus(period.from, at) > 0) break;
    owner = period.owner;
  }
  return owner;
}

/** The wallet that held the agent's agentWallet slot at a moment, or null if it was empty. */
export function agentWalletAt(agent: AgentInput, at: ConsensusTimestamp): Address | null {
  let wallet: Address | null = null;
  for (const period of agent.walletHistory) {
    if (compareConsensus(period.from, at) > 0) break;
    wallet = period.wallet;
  }
  return wallet;
}

/**
 * When each wallet stopped being trusted: the earliest compromise report on any agent recorded on
 * it, even one that has since moved off it, because the report cannot say which key it means.
 */
export function walletVoids(agents: AgentInput[]): Map<Address, ConsensusTimestamp> {
  const voids = new Map<Address, ConsensusTimestamp>();
  for (const { compromisedAt, vouchedWallets } of agents) {
    if (!compromisedAt) continue;
    for (const { wallet } of vouchedWallets) {
      voids.set(wallet, earliest(voids.get(wallet) ?? null, compromisedAt)!);
    }
  }
  return voids;
}

/**
 * Who stood behind which wallet, and when: CreatorRegistry.isHumanBacked replayed over time, since
 * the contract only answers for now and a review must be judged as of its own consensus time.
 * Like the contract it fails closed. An agent wallet binds only once it is vouched for, while it
 * is in the agent's wallet slot and the creator owns the NFT, and until a compromise report on any
 * agent recorded on that wallet. Creator wallets are exempt from that report, as in the contract.
 */
export function buildWalletBindings(
  creators: CreatorInput[],
  agents: AgentInput[],
): WalletBinding[] {
  const bindings: WalletBinding[] = creators.map((creator) => ({
    wallet: creator.wallet,
    creator: creator.wallet,
    from: creator.registeredAt,
    to: null,
    kind: 'creator',
  }));
  const voids = walletVoids(agents);

  for (const agent of agents) {
    const { creator, vouchedWallets, walletHistory } = agent;
    if (!creator) continue;

    for (const { wallet, from: vouchedAt } of vouchedWallets) {
      walletHistory.forEach((period, index) => {
        if (period.wallet !== wallet) return;
        const from = latest(period.from, vouchedAt);
        const to = earliest(walletHistory[index + 1]?.from ?? null, voids.get(wallet) ?? null);
        if (to !== null && compareConsensus(to, from) <= 0) return;
        if (ownerAt(agent, from) !== creator) return;
        bindings.push({ wallet, creator, from, to, kind: 'agent' });
      });
    }
  }

  return bindings.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'creator' ? -1 : 1) ||
      compareConsensus(a.from, b.from) ||
      a.creator.localeCompare(b.creator),
  );
}

function latest(a: ConsensusTimestamp, b: ConsensusTimestamp): ConsensusTimestamp {
  return compareConsensus(a, b) >= 0 ? a : b;
}

function earliest(
  a: ConsensusTimestamp | null,
  b: ConsensusTimestamp | null,
): ConsensusTimestamp | null {
  if (a === null || b === null) return a ?? b;
  return compareConsensus(a, b) <= 0 ? a : b;
}

export interface WalletDirectory {
  /** The creator backing this wallet at that moment, or null if nobody was. */
  creatorAt(wallet: Address, at: ConsensusTimestamp): Address | null;
  /** True if the wallet belonged to this creator at or before that moment, even if it no longer does. */
  everBackedBy(wallet: Address, creator: Address, at: ConsensusTimestamp): boolean;
}

export function walletDirectory(bindings: WalletBinding[]): WalletDirectory {
  const byWallet = new Map<Address, WalletBinding[]>();
  for (const binding of bindings) {
    const list = byWallet.get(binding.wallet);
    if (list) list.push(binding);
    else byWallet.set(binding.wallet, [binding]);
  }

  return {
    // Bindings are sorted, so a wallet claimed by two creators resolves the same way on every run.
    creatorAt(wallet, at) {
      for (const binding of byWallet.get(wallet) ?? []) {
        const started = compareConsensus(binding.from, at) <= 0;
        const ended = binding.to !== null && compareConsensus(binding.to, at) <= 0;
        if (started && !ended) return binding.creator;
      }
      return null;
    },
    everBackedBy(wallet, creator, at) {
      return (byWallet.get(wallet) ?? []).some(
        (binding) => binding.creator === creator && compareConsensus(binding.from, at) <= 0,
      );
    },
  };
}
