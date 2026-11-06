import type { Address } from 'viem';

/** Deployed on Hedera testnet; see packages/contracts/README.md. NEXT_PUBLIC_CREATOR_REGISTRY overrides it. */
export const CREATOR_REGISTRY: Address =
  (process.env.NEXT_PUBLIC_CREATOR_REGISTRY as Address | undefined) || '0x424afbefd2d91cd771785909bfc9aeb66e89a80a';

// Gas limits, ABIs and cost helpers are shared with the SDK.
export {
  ASSOCIATE_GAS_ESTIMATE,
  GAS,
  LINK_GAS_ESTIMATE,
  associateTokenAbi,
  gasCostUsd,
  hbarForGasLimit,
  registerGas,
  registerGasEstimate,
  registerWithUriAbi,
  tokenIdFromAddress,
} from '@reputed/shared';
