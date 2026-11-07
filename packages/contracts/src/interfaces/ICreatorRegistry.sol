// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// The interface server/, web/ and the scorer build against. Change it only with all of them agreed.
/// Grants, syncAgentWallet and their events are deliberately absent: they live on CreatorRegistry, so
/// this surface did not change for v2.
interface ICreatorRegistry {
    event CreatorRegistered(bytes32 indexed nullifierHash, address indexed wallet);
    /// serial is the credential issued to agentWallet. Pair it with CredentialRevoked by holder and serial.
    event AgentLinked(uint256 indexed agentId, address indexed creator, address indexed agentWallet, int64 serial);
    /// Emitted once per agent. timestamp equals compromisedAt(agentId).
    event AgentCompromised(uint256 indexed agentId, address indexed creator, uint256 timestamp);
    /// Emitted for every credential, including the ones linkAgent and syncAgentWallet issue, so
    /// holder plus serial across these two events is a complete ledger of the collection.
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
