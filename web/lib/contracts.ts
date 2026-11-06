import { parseAbi, type Address } from 'viem';

/** Deployed on Hedera testnet; see contracts/README.md. NEXT_PUBLIC_CREATOR_REGISTRY overrides it. */
export const CREATOR_REGISTRY: Address =
  (process.env.NEXT_PUBLIC_CREATOR_REGISTRY as Address | undefined) || '0x424afbefd2d91cd771785909bfc9aeb66e89a80a';

// Hedera's gas estimates are unreliable for system contract calls, so these are set by hand from
// real testnet use. The sender is charged for gas used, but must hold enough to cover the limit.
export const GAS = {
  register: 1_500_000n,
  linkAgent: 1_500_000n,
  giveFeedback: 800_000n,
  reportCompromise: 300_000n,
  setAgentWallet: 400_000n,
  /** Mirror Node estimate for `associate()` on the credential token was 782,243 on 2026-11-06. */
  associate: 1_000_000n,
} as const;

/**
 * The Identity Registry overloads `register`, so this names the one that takes only a URI (selector
 * 0xf2c298be) instead of leaving the choice to argument matching.
 */
export const registerWithUriAbi = parseAbi(['function register(string agentURI) returns (uint256 agentId)']);

/** HIP-719: the wallet that calls this on a token's address associates itself with that token. */
export const associateTokenAbi = parseAbi(['function associate() returns (uint256 responseCode)']);

// Measured against the testnet Identity Registry: see MAX_AGENT_URI_BYTES in server/src/routes/agentFile.ts.
const REGISTER_BASE_GAS = 165_000;
const REGISTER_GAS_PER_URI_BYTE = 780;

export function registerGasEstimate(uriBytes: number): number {
  return REGISTER_BASE_GAS + REGISTER_GAS_PER_URI_BYTE * uriBytes;
}

/** The URI is stored on-chain, so a long agent file needs more than the flat limit. */
export function registerGas(uriBytes: number): bigint {
  const padded = (BigInt(registerGasEstimate(uriBytes)) * 5n) / 4n;
  return padded > GAS.register ? padded : GAS.register;
}

/** Gas used by `linkAgent` when the wallet auto-associates. See the gas table in contracts/README.md. */
export const LINK_GAS_ESTIMATE = 1_170_000;
export const ASSOCIATE_GAS_ESTIMATE = 782_243;

// Hedera prices gas in dollars: 124 tinybar at 6.87 cents per HBAR on testnet, 2026-11-06.
const USD_PER_GAS = 0.000_000_085;
const HBAR_PER_GAS = 0.000_001_24;

export const gasCostUsd = (gas: number): number => gas * USD_PER_GAS;
/** The balance a sender needs for a gas limit, rounded up to a tenth of an HBAR. */
export const hbarForGasLimit = (gas: bigint): string => (Math.ceil(Number(gas) * HBAR_PER_GAS * 10) / 10).toFixed(1);

/** A long-zero token address (0x…ad0701) as its 0.0.x ID. */
export function tokenIdFromAddress(address: Address): string {
  return `0.0.${BigInt(address).toString()}`;
}
