import type { Address } from 'viem';
import { HEDERA_TESTNET, IDENTITY_REGISTRY } from '@reputed/shared';

// setAgentWallet proves the new wallet agreed by checking an EIP-712 signature from it. The type
// string is AGENT_WALLET_SET_TYPEHASH in erc-8004-contracts@b9e466c, IdentityRegistryUpgradeable.sol:
//   AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)
// Its hash is in the deployed implementation's bytecode, and eip712Domain() on the proxy returns
// this domain.

/** The contract refuses a deadline over 5 minutes past the block time. This leaves room for clock drift. */
export const SIGNATURE_LIFETIME_SECONDS = 240;
/** Ask for a fresh signature this long before the deadline, so the transaction lands in time. */
export const SIGNATURE_SAFETY_SECONDS = 30;

export function agentWalletTypedData(input: { agentId: bigint; newWallet: Address; owner: Address; deadline: bigint }) {
  return {
    domain: {
      name: 'ERC8004IdentityRegistry',
      version: '1',
      chainId: HEDERA_TESTNET.id,
      verifyingContract: IDENTITY_REGISTRY,
    },
    types: {
      AgentWalletSet: [
        { name: 'agentId', type: 'uint256' },
        { name: 'newWallet', type: 'address' },
        { name: 'owner', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'AgentWalletSet',
    message: input,
  } as const;
}
