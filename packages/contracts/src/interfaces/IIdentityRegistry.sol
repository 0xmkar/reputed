// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// The two ERC-8004 Identity Registry v2.0.0 reads CreatorRegistry depends on.
interface IIdentityRegistry {
    /// Reverts for an agent ID that does not exist. Agent IDs start at 0.
    function ownerOf(uint256 agentId) external view returns (address);

    /// Returns address(0) after the agent NFT is transferred, or for an unknown agent.
    function getAgentWallet(uint256 agentId) external view returns (address);
}
