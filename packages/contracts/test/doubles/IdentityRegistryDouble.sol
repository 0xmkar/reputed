// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

/// Stand-in for the ERC-8004 Identity Registry v2.0.0, with the behaviour CreatorRegistry relies on:
/// IDs start at 0, register sets the wallet to the owner, transfer clears the wallet, ownerOf reverts
/// for an unknown ID and getAgentWallet does not.
contract IdentityRegistryDouble {
    error ERC721NonexistentToken(uint256 tokenId);

    uint256 public nextId;
    bool public broken;
    mapping(uint256 => address) private _owners;
    mapping(uint256 => address) private _wallets;

    function register(address owner) external returns (uint256 agentId) {
        agentId = nextId++;
        _owners[agentId] = owner;
        _wallets[agentId] = owner;
    }

    function registerAt(uint256 agentId, address owner) external {
        _owners[agentId] = owner;
        _wallets[agentId] = owner;
    }

    function setAgentWallet(uint256 agentId, address wallet) external {
        _wallets[agentId] = wallet;
    }

    function transfer(uint256 agentId, address to) external {
        _owners[agentId] = to;
        delete _wallets[agentId];
    }

    function setBroken(bool value) external {
        broken = value;
    }

    function ownerOf(uint256 agentId) external view returns (address owner) {
        require(!broken, "registry down");
        owner = _owners[agentId];
        if (owner == address(0)) revert ERC721NonexistentToken(agentId);
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        require(!broken, "registry down");
        return _wallets[agentId];
    }
}
