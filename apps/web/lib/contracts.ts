import type { Address } from 'viem';

/** Deployed on Hedera testnet; see packages/contracts/README.md. NEXT_PUBLIC_CREATOR_REGISTRY overrides it. */
export const CREATOR_REGISTRY: Address =
  (process.env.NEXT_PUBLIC_CREATOR_REGISTRY as Address | undefined) || '0xcbd506592be9f52ae48196d592df8919c9fa4dd2';

// Gas limits are shared with the SDK.
export { GAS } from '@reputed/shared';
