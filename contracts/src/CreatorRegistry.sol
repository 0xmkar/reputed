// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {Hts} from "./hedera/Hts.sol";
import {IHederaTokenService} from "./hedera/IHederaTokenService.sol";
import {ICreatorRegistry} from "./interfaces/ICreatorRegistry.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// Ties each agent to one World ID verified human, and owns the HTS credential collection.
/// DEFAULT_ADMIN_ROLE is the admin role. It also grants and revokes the other two roles.
contract CreatorRegistry is ICreatorRegistry, AccessControl {
    /// A wallet set after linking now has this contract's backing. Not in ICreatorRegistry, so the
    /// interface other tracks build against stays as agreed.
    event AgentWalletSynced(uint256 indexed agentId, address indexed creator, address indexed agentWallet, int64 serial);

    error ZeroAddress();
    error CredentialTokenAlreadyInitialized();
    error CredentialTokenNotInitialized();
    error NullifierAlreadyRegistered(bytes32 nullifierHash);
    error WalletAlreadyRegistered(address wallet);
    error NotCreator(address caller);
    error AlreadyLinked(uint256 agentId);
    error NotAgentOwner(uint256 agentId, address caller);
    error AgentWalletNotSet(uint256 agentId);
    error NotAgentCreator(uint256 agentId, address caller);
    error AlreadyCompromised(uint256 agentId);
    error WalletAlreadyLinked(uint256 agentId, address wallet);
    error InvalidMetadataLength(uint256 length);
    error InvalidHolder(address holder);

    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    uint256 public constant MAX_METADATA_BYTES = 100;

    string private constant TOKEN_NAME = "Reputed Credential";
    string private constant TOKEN_SYMBOL = "RPTD";
    string private constant TOKEN_MEMO = "Non-transferable agent credentials issued by CreatorRegistry";
    string private constant HUMAN_BACKED_PREFIX = "reputed:human-backed:";

    uint256 private constant FREEZE_KEY = 1 << 2;
    uint256 private constant WIPE_KEY = 1 << 3;
    uint256 private constant SUPPLY_KEY = 1 << 4;
    int64 private constant AUTO_RENEW_PERIOD = 7_776_000; // 90 days, inside the network's allowed range

    address public immutable identityRegistry;
    address public credentialToken;

    mapping(address wallet => bool) public isCreator;
    mapping(bytes32 nullifierHash => address) public walletOfNullifier;
    mapping(uint256 agentId => address) public creatorOf;
    mapping(uint256 agentId => uint256) public compromisedAt;

    mapping(address creator => uint256[]) private _agentsOfCreator;
    /// Agents this address was linked or synced to. A hint only: isHumanBacked re-checks each one.
    mapping(address wallet => uint256[]) private _agentsLinkedToWallet;
    mapping(uint256 agentId => mapping(address wallet => bool)) private _walletLinked;

    constructor(address identityRegistry_, address admin, address verifier, address issuer) {
        if (
            identityRegistry_ == address(0) || admin == address(0) || verifier == address(0) || issuer == address(0)
        ) revert ZeroAddress();
        identityRegistry = identityRegistry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VERIFIER_ROLE, verifier);
        _grantRole(ISSUER_ROLE, issuer);
    }

    /// Send the creation fee as value. Whatever the network does not charge stays in this contract,
    /// which is the token's auto-renew payer.
    function initCredentialToken() external payable onlyRole(DEFAULT_ADMIN_ROLE) {
        if (credentialToken != address(0)) revert CredentialTokenAlreadyInitialized();

        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](1);
        keys[0] = IHederaTokenService.TokenKey({
            keyType: FREEZE_KEY | WIPE_KEY | SUPPLY_KEY,
            key: IHederaTokenService.KeyValue({
                inheritAccountKey: false,
                contractId: address(this),
                ed25519: "",
                ECDSA_secp256k1: "",
                delegatableContractId: address(0)
            })
        });

        // freezeDefault must stay false: a default-frozen token cannot be auto-associated at all,
        // so holders with free auto-association slots could never receive a credential.
        credentialToken = Hts.createNft(
            IHederaTokenService.HederaToken({
                name: TOKEN_NAME,
                symbol: TOKEN_SYMBOL,
                treasury: address(this),
                memo: TOKEN_MEMO,
                tokenSupplyType: false,
                maxSupply: 0,
                freezeDefault: false,
                tokenKeys: keys,
                expiry: IHederaTokenService.Expiry({
                    second: 0,
                    autoRenewAccount: address(this),
                    autoRenewPeriod: AUTO_RENEW_PERIOD
                })
            }),
            msg.value
        );
    }

    function registerCreator(bytes32 nullifierHash, address wallet) external onlyRole(VERIFIER_ROLE) {
        if (wallet == address(0)) revert ZeroAddress();
        if (walletOfNullifier[nullifierHash] != address(0)) revert NullifierAlreadyRegistered(nullifierHash);
        if (isCreator[wallet]) revert WalletAlreadyRegistered(wallet);

        walletOfNullifier[nullifierHash] = wallet;
        isCreator[wallet] = true;
        emit CreatorRegistered(nullifierHash, wallet);
    }

    function linkAgent(uint256 agentId) external {
        if (!isCreator[msg.sender]) revert NotCreator(msg.sender);
        if (creatorOf[agentId] != address(0)) revert AlreadyLinked(agentId);

        address wallet = _currentWalletOfOwnedAgent(agentId);
        creatorOf[agentId] = msg.sender;
        _agentsOfCreator[msg.sender].push(agentId);

        emit AgentLinked(agentId, msg.sender, wallet, _vouchFor(agentId, wallet));
    }

    /// Backs the wallet an agent was rotated to after linking, and issues it a credential. The wallet
    /// signed setAgentWallet itself, so a creator cannot vouch for a wallet that did not agree to it.
    /// The previous wallet keeps its frozen credential until the issuer revokes it.
    function syncAgentWallet(uint256 agentId) external {
        if (creatorOf[agentId] != msg.sender) revert NotAgentCreator(agentId, msg.sender);
        if (compromisedAt[agentId] != 0) revert AlreadyCompromised(agentId);

        address wallet = _currentWalletOfOwnedAgent(agentId);
        if (_walletLinked[agentId][wallet]) revert WalletAlreadyLinked(agentId, wallet);

        emit AgentWalletSynced(agentId, msg.sender, wallet, _vouchFor(agentId, wallet));
    }

    /// One report per agent, so the time the scorer works from cannot be moved afterwards.
    function reportCompromise(uint256 agentId) external {
        if (creatorOf[agentId] != msg.sender) revert NotAgentCreator(agentId, msg.sender);
        if (compromisedAt[agentId] != 0) revert AlreadyCompromised(agentId);

        compromisedAt[agentId] = block.timestamp;
        emit AgentCompromised(agentId, msg.sender, block.timestamp);
    }

    function issueCredential(address to, bytes calldata metadata)
        external
        onlyRole(ISSUER_ROLE)
        returns (int64 serial)
    {
        serial = _issueCredential(to, metadata);
    }

    /// Wiping needs an unfrozen relationship, so the holder is unfrozen and refrozen around it.
    /// A failed wipe relies on the revert undoing the unfreeze. On Hedera that is unproven until T1.9b.
    function revokeCredential(address holder, int64 serial) external onlyRole(ISSUER_ROLE) {
        address token = _requireToken();
        if (Hts.isFrozen(token, holder)) Hts.unfreeze(token, holder);
        Hts.wipeOne(token, holder, serial);
        Hts.freeze(token, holder);
        emit CredentialRevoked(holder, serial);
    }

    function agentsOf(address creator) external view returns (uint256[] memory) {
        return _agentsOfCreator[creator];
    }

    /// True for creator wallets, and for a wallet that a linked agent still answers to right now.
    /// The recorded wallet is only a hint, because setAgentWallet and NFT transfers happen in the
    /// Identity Registry without telling this contract. See _backsWallet for what is re-checked.
    /// A compromise report means the key is untrusted, so one report voids the wallet for every agent
    /// sharing it. A creator wallet is exempt: it has no way to register again, so a report on one
    /// agent would otherwise lock that human out for good.
    function isHumanBacked(address wallet) external view returns (bool) {
        if (isCreator[wallet]) return true;

        bool backed;
        uint256[] storage agentIds = _agentsLinkedToWallet[wallet];
        for (uint256 i = 0; i < agentIds.length; ++i) {
            if (compromisedAt[agentIds[i]] != 0) return false;
            backed = backed || _backsWallet(agentIds[i], wallet);
        }
        return backed;
    }

    /// Fails closed on anything that could mean the verified human no longer stands behind the wallet:
    /// the wallet was rotated or cleared, the agent NFT left the creator, or the Identity Registry
    /// call failed.
    function _backsWallet(uint256 agentId, address wallet) private view returns (bool) {
        IIdentityRegistry registry = IIdentityRegistry(identityRegistry);
        try registry.getAgentWallet(agentId) returns (address current) {
            if (current != wallet) return false;
        } catch {
            return false;
        }
        try registry.ownerOf(agentId) returns (address owner) {
            return owner == creatorOf[agentId];
        } catch {
            return false;
        }
    }

    function _currentWalletOfOwnedAgent(uint256 agentId) private view returns (address wallet) {
        IIdentityRegistry registry = IIdentityRegistry(identityRegistry);
        if (registry.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        wallet = registry.getAgentWallet(agentId);
        if (wallet == address(0)) revert AgentWalletNotSet(agentId);
    }

    function _vouchFor(uint256 agentId, address wallet) private returns (int64 serial) {
        _walletLinked[agentId][wallet] = true;
        _agentsLinkedToWallet[wallet].push(agentId);
        serial = _issueCredential(wallet, bytes(string.concat(HUMAN_BACKED_PREFIX, _toDecimal(agentId))));
    }

    /// Mints to the treasury, delivers, then freezes. Holder states at the start of a call:
    ///   frozen (already holds a credential):  unfreeze, transfer, freeze
    ///   associated and not frozen:            transfer, freeze
    ///   not associated, free auto-assoc slot: transfer associates it, freeze
    ///   not associated, no slots:             transfer fails with 184 TOKEN_NOT_ASSOCIATED_TO_ACCOUNT
    ///   not associated, slots all used:       transfer fails with 262 NO_REMAINING_AUTOMATIC_ASSOCIATIONS
    /// isFrozen is what makes this work: unfreeze fails on an account with no association, and freeze
    /// fails on an account that is already frozen, so neither can be called blindly. Every failure
    /// reverts the whole call, which is what stops a credential ending up transferable. See T1.9b.
    function _issueCredential(address to, bytes memory metadata) private returns (int64 serial) {
        address token = _requireToken();
        if (metadata.length == 0 || metadata.length > MAX_METADATA_BYTES) {
            revert InvalidMetadataLength(metadata.length);
        }
        if (to == address(0) || to == address(this)) revert InvalidHolder(to);

        bool frozen = Hts.isFrozen(token, to);
        serial = Hts.mintOne(token, metadata);
        if (frozen) Hts.unfreeze(token, to);
        Hts.transferNft(token, address(this), to, serial);
        Hts.freeze(token, to);
        emit CredentialIssued(to, serial);
    }

    function _requireToken() private view returns (address token) {
        token = credentialToken;
        if (token == address(0)) revert CredentialTokenNotInitialized();
    }

    function _toDecimal(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 rest = value; rest != 0; rest /= 10) ++digits;
        bytes memory text = new bytes(digits);
        for (; value != 0; value /= 10) text[--digits] = bytes1(uint8(48 + value % 10));
        return string(text);
    }
}
