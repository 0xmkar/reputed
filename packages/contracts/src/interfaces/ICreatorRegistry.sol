// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// The interface server/, web/ and the scorer build against. Change it only with all of them agreed.
interface ICreatorRegistry {
    event CreatorRegistered(bytes32 indexed nullifierHash, address indexed wallet);
    event AgentLinked(uint256 indexed agentId, address indexed creator, address indexed agentWallet, int64 serial);
    event AgentCompromised(uint256 indexed agentId, address indexed creator, uint256 timestamp);
    event CredentialIssued(address indexed holder, int64 serial);
    event CredentialRevoked(address indexed holder, int64 serial);

    function initCredentialToken() external payable;
    function registerCreator(bytes32 nullifierHash, address wallet) external;
    function linkAgent(uint256 agentId) external;
    function reportCompromise(uint256 agentId) external;
    function issueCredential(address to, bytes calldata metadata) external returns (int64 serial);
    function revokeCredential(address holder, int64 serial) external;
    function creatorOf(uint256 agentId) external view returns (address);
    function agentsOf(address creator) external view returns (uint256[] memory);
    function isCreator(address wallet) external view returns (bool);
    function walletOfNullifier(bytes32 nullifierHash) external view returns (address);
    function isHumanBacked(address wallet) external view returns (bool);
    function compromisedAt(uint256 agentId) external view returns (uint256);
    function identityRegistry() external view returns (address);
    function credentialToken() external view returns (address);
}
