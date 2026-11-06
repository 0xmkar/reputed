import { type Address } from 'viem';

/** Deployed on Hedera testnet; see contracts/README.md. Set by NEXT_PUBLIC_CREATOR_REGISTRY. */
export const CREATOR_REGISTRY = process.env.NEXT_PUBLIC_CREATOR_REGISTRY as Address | undefined;

// Hedera's gas estimates are unreliable for system contract calls, so these are set by hand from
// real testnet use. The sender is charged for gas used, but must hold enough to cover the limit.
export const GAS = {
  register: 1_500_000n,
  linkAgent: 1_500_000n,
  giveFeedback: 800_000n,
  reportCompromise: 300_000n,
  setAgentWallet: 400_000n,
} as const;
