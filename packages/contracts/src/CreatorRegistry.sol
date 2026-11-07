// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {Hts} from "./hedera/Hts.sol";
import {IHederaTokenService} from "./hedera/IHederaTokenService.sol";
import {ICreatorRegistry} from "./interfaces/ICreatorRegistry.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// Ties each agent to one World ID verified human, and owns the HTS credential collection.
///
/// Three roles, each granted separately, so holding one never implies another:
///   DEFAULT_ADMIN_ROLE  creates the collection and grants or revokes the other two roles
///   VERIFIER_ROLE       registers a creator wallet after the World ID proof was checked off-chain;
///                       only the proof's nullifier hash reaches the chain
///   ISSUER_ROLE         mints and wipes credentials outside the link flow
/// Creators and agent owners hold no role. linkAgent, grants, syncAgentWallet and reportCompromise
/// are gated on isCreator, creatorOf and live NFT ownership instead.
///
/// The ERC-8004 Identity Registry is the source of truth for who owns an agent NFT and which wallet
/// it uses. This contract only records who linked what, and isHumanBacked re-reads the registry on
/// every call, so a sale or wallet rotation that happens there cannot leave this contract wrong.
///
/// The credential is a frozen HTS NFT. This contract is the treasury and holds the freeze, wipe and
/// supply keys, so a holder cannot transfer one and only the issuer can remove one.
contract CreatorRegistry is ICreatorRegistry, AccessControl, EIP712 {
    /// A creator lets one key link agents on their behalf, without the creator's wallet or the
    /// agent's NFT ever changing hands. The key signs per agent, the agent's owner sends the call.
    struct Grant {
        address creator;
        uint64 expiresAt;
        uint32 maxAgents;
        uint32 used;
        bool revoked;
    }

    /// A wallet set after linking now has this contract's backing. Not in ICreatorRegistry, so the
    /// interface other tracks build against stays as agreed.
    event AgentWalletSynced(uint256 indexed agentId, address indexed creator, address indexed agentWallet, int64 serial);
    event GrantAuthorized(address indexed creator, address indexed grantKey, uint64 expiresAt, uint32 maxAgents);
    event GrantRevoked(address indexed creator, address indexed grantKey);
    /// Emitted beside AgentLinked when a grant did the link, so consumers can tell who owns the NFT.
    event AgentLinkedByGrant(uint256 indexed agentId, address indexed creator, address indexed grantKey, address owner);

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
    error GrantKeyTaken(address grantKey);
    error GrantNotFound(address grantKey);
    error GrantExpired(address grantKey);
    error GrantIsRevoked(address grantKey);
    error GrantExhausted(address grantKey);
    error GrantDeadlinePassed(uint256 deadline);
    error BadGrantSignature();
    error InvalidGrant();

    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    /// HTS refuses NFT metadata over 100 bytes with 227 METADATA_TOO_LONG. Checked here before any
    /// HTS call, so the revert names the length and nothing is minted first.
    uint256 public constant MAX_METADATA_BYTES = 100;

    /// What a grant key signs for linkAgentWithGrant. owner is the caller of that function.
    bytes32 public constant LINK_GRANT_TYPEHASH = keccak256("LinkGrant(uint256 agentId,address owner,uint256 deadline)");

    string private constant TOKEN_NAME = "Reputed Credential";
    string private constant TOKEN_SYMBOL = "RPTD";
    string private constant TOKEN_MEMO = "Non-transferable agent credentials issued by CreatorRegistry";
    /// 21 bytes, plus at most 78 decimal digits for a uint256 agent id: 99, inside MAX_METADATA_BYTES.
    string private constant HUMAN_BACKED_PREFIX = "reputed:human-backed:";

    /// HTS key-type bits: admin 1, kyc 2, freeze 4, wipe 8, supply 16. Only these three are set and
    /// there is no admin key, so the keys can never be moved to another contract.
    uint256 private constant FREEZE_KEY = 1 << 2;
    uint256 private constant WIPE_KEY = 1 << 3;
    uint256 private constant SUPPLY_KEY = 1 << 4;
    int64 private constant AUTO_RENEW_PERIOD = 7_776_000; // 90 days, inside the network's allowed range

    /// ERC-8004 Identity Registry. Read only; this contract never writes to it.
    address public immutable identityRegistry;
    /// Set once by initCredentialToken. While zero, every mint and wipe reverts with
    /// CredentialTokenNotInitialized.
    address public credentialToken;

    /// One nullifier registers one wallet and one wallet registers once, so a human cannot hold two
    /// creator wallets and a wallet cannot be claimed under a second nullifier. Neither entry is ever
    /// changed or removed: a creator wallet cannot rotate, which the compromise rule in isHumanBacked
    /// relies on.
    mapping(address wallet => bool) public isCreator;
    mapping(bytes32 nullifierHash => address) public walletOfNullifier;
    /// Written once, never cleared. Selling the agent NFT does not move the agent to the buyer (T3.8).
    mapping(uint256 agentId => address) public creatorOf;
    /// block.timestamp of the one allowed report, or 0. The scorer uses it as a cut-off.
    mapping(uint256 agentId => uint256) public compromisedAt;
    /// Who held the agent NFT when it was linked. The creator for linkAgent, the agent's own account
    /// for linkAgentWithGrant. isHumanBacked stops counting the agent when the NFT leaves this address.
    mapping(uint256 agentId => address) public linkedOwner;
    mapping(address grantKey => Grant) public grants;

    mapping(address creator => uint256[]) private _agentsOfCreator;
    /// Agents this address was linked or synced to. A hint only: isHumanBacked re-checks each one.
    mapping(address wallet => uint256[]) private _agentsLinkedToWallet;
    /// Stops syncAgentWallet from issuing a second credential to a wallet this agent already vouched for.
    mapping(uint256 agentId => mapping(address wallet => bool)) private _walletLinked;

    /// The three role holders may be the same address, but each role is granted on its own: admin
    /// alone can neither register creators nor issue credentials.
    constructor(address identityRegistry_, address admin, address verifier, address issuer)
        EIP712("ReputedCreatorRegistry", "2")
    {
        if (
            identityRegistry_ == address(0) || admin == address(0) || verifier == address(0) || issuer == address(0)
        ) revert ZeroAddress();
        identityRegistry = identityRegistry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VERIFIER_ROLE, verifier);
        _grantRole(ISSUER_ROLE, issuer);
    }

    /// Send the creation fee as value. Whatever the network does not charge stays in this contract,
    /// which is the token's auto-renew payer. There is no withdraw function.
    /// One TokenKey entry carries freeze, wipe and supply, all pointing at this contract. With no
    /// admin key the keys and treasury are fixed for the life of the collection, so a new contract
    /// version needs a new collection.
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
                // infinite supply; maxSupply is ignored
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

    /// The verifier calls this after checking a World ID proof off-chain; only the nullifier hash
    /// reaches the chain. Both mappings are checked, so a repeated proof and a reused wallet both
    /// fail. There is no update path: once a nullifier is spent, that human cannot register again.
    function registerCreator(bytes32 nullifierHash, address wallet) external onlyRole(VERIFIER_ROLE) {
        if (wallet == address(0)) revert ZeroAddress();
        if (walletOfNullifier[nullifierHash] != address(0)) revert NullifierAlreadyRegistered(nullifierHash);
        if (isCreator[wallet]) revert WalletAlreadyRegistered(wallet);

        walletOfNullifier[nullifierHash] = wallet;
        isCreator[wallet] = true;
        emit CreatorRegistered(nullifierHash, wallet);
    }

    /// The classic link: the creator's own wallet owns the agent NFT and sends the call. creatorOf and
    /// linkedOwner are written before the HTS calls in _vouchFor, so a failed credential delivery
    /// reverts the link with it and nothing is left half-linked. The credential goes to the agent's
    /// wallet from getAgentWallet, not to the creator.
    function linkAgent(uint256 agentId) external {
        if (!isCreator[msg.sender]) revert NotCreator(msg.sender);
        if (creatorOf[agentId] != address(0)) revert AlreadyLinked(agentId);

        address wallet = _currentWalletOfOwnedAgent(agentId);
        creatorOf[agentId] = msg.sender;
        linkedOwner[agentId] = msg.sender;
        _agentsOfCreator[msg.sender].push(agentId);

        emit AgentLinked(agentId, msg.sender, wallet, _vouchFor(agentId, wallet));
    }

    /// Lets a creator hand a key the right to link up to maxAgents agents until expiresAt. The key
    /// belongs to this creator for good, even after it is revoked, so nobody else can reuse it.
    /// Neither expiresAt nor maxAgents can be changed later: revoke and authorize a fresh key.
    function authorizeGrant(address grantKey, uint64 expiresAt, uint32 maxAgents) external {
        if (!isCreator[msg.sender]) revert NotCreator(msg.sender);
        if (grantKey == address(0) || maxAgents == 0 || expiresAt <= block.timestamp) revert InvalidGrant();
        if (grants[grantKey].creator != address(0)) revert GrantKeyTaken(grantKey);

        grants[grantKey] = Grant({creator: msg.sender, expiresAt: expiresAt, maxAgents: maxAgents, used: 0, revoked: false});
        emit GrantAuthorized(msg.sender, grantKey, expiresAt, maxAgents);
    }

    /// Stops new links. Agents the key already linked stay linked: the creator reports those one by one.
    /// Not reversible, and the key stays taken.
    function revokeGrant(address grantKey) external {
        Grant storage grant = grants[grantKey];
        if (grant.creator != msg.sender) revert GrantNotFound(grantKey);
        grant.revoked = true;
        emit GrantRevoked(msg.sender, grantKey);
    }

    /// The agent's owner links the agent to the grant's creator. The grant key signs
    /// LinkGrant(agentId, owner, deadline), so the signature works for one agent and one owner only.
    /// The key only signs; it never sends a transaction or holds funds, and the creator wallet is not
    /// involved. Grant state and the deadline are checked before the signature, and the signature
    /// before any external call. tryRecover turns a malformed signature into BadGrantSignature instead
    /// of an OpenZeppelin error. used is bumped before _vouchFor, so a failed delivery reverts it too.
    function linkAgentWithGrant(uint256 agentId, address grantKey, uint256 deadline, bytes calldata signature) external {
        Grant storage grant = grants[grantKey];
        if (grant.creator == address(0)) revert GrantNotFound(grantKey);
        if (grant.revoked) revert GrantIsRevoked(grantKey);
        if (block.timestamp > grant.expiresAt) revert GrantExpired(grantKey);
        if (grant.used >= grant.maxAgents) revert GrantExhausted(grantKey);
        if (block.timestamp > deadline) revert GrantDeadlinePassed(deadline);
        if (creatorOf[agentId] != address(0)) revert AlreadyLinked(agentId);

        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(LINK_GRANT_TYPEHASH, agentId, msg.sender, deadline)));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != grantKey) revert BadGrantSignature();

        address wallet = _currentWalletOfOwnedAgent(agentId);
        address creator = grant.creator;
        grant.used += 1;
        creatorOf[agentId] = creator;
        linkedOwner[agentId] = msg.sender;
        _agentsOfCreator[creator].push(agentId);

        emit AgentLinked(agentId, creator, wallet, _vouchFor(agentId, wallet));
        emit AgentLinkedByGrant(agentId, creator, grantKey, msg.sender);
    }

    /// Backs the wallet an agent was rotated to after linking, and issues it a credential. The wallet
    /// signed setAgentWallet itself, so a creator cannot vouch for a wallet that did not agree to it.
    /// The previous wallet keeps its frozen credential until the issuer revokes it.
    /// The creator must still own the NFT, so grant-linked agents, whose own account owns the NFT,
    /// cannot use it. creatorOf and agentsOf are untouched: this only adds a wallet record.
    function syncAgentWallet(uint256 agentId) external {
        if (creatorOf[agentId] != msg.sender) revert NotAgentCreator(agentId, msg.sender);
        if (compromisedAt[agentId] != 0) revert AlreadyCompromised(agentId);

        address wallet = _currentWalletOfOwnedAgent(agentId);
        if (_walletLinked[agentId][wallet]) revert WalletAlreadyLinked(agentId, wallet);

        emit AgentWalletSynced(agentId, msg.sender, wallet, _vouchFor(agentId, wallet));
    }

    /// One report per agent, so the time the scorer works from cannot be moved afterwards. Gated on
    /// creatorOf alone, not NFT ownership, so a creator can still report an agent that was sold or is
    /// grant-linked. No HTS call here on purpose: a wipe can fail, and a report must always go
    /// through. Stale credentials are left to the issuer (revokeCredential).
    function reportCompromise(uint256 agentId) external {
        if (creatorOf[agentId] != msg.sender) revert NotAgentCreator(agentId, msg.sender);
        if (compromisedAt[agentId] != 0) revert AlreadyCompromised(agentId);

        compromisedAt[agentId] = block.timestamp;
        emit AgentCompromised(agentId, msg.sender, block.timestamp);
    }

    /// Issuer path for credentials outside the link flow, such as reissuing after a revoke. Metadata
    /// is free-form here; the link flow writes HUMAN_BACKED_PREFIX plus the agent id.
    function issueCredential(address to, bytes calldata metadata)
        external
        onlyRole(ISSUER_ROLE)
        returns (int64 serial)
    {
        serial = _issueCredential(to, metadata);
    }

    /// Wiping needs an unfrozen relationship, so the holder is unfrozen and refrozen around it.
    /// A failed wipe relies on the revert undoing the unfreeze, which T1.9b (script/check-rollback.sh)
    /// confirmed on testnet. The holder ends frozen even with no credential left; the next issue
    /// handles that state. Revoking does not change isHumanBacked: the flag and the NFT are independent.
    function revokeCredential(address holder, int64 serial) external onlyRole(ISSUER_ROLE) {
        address token = _requireToken();
        if (Hts.isFrozen(token, holder)) Hts.unfreeze(token, holder);
        Hts.wipeOne(token, holder, serial);
        Hts.freeze(token, holder);
        emit CredentialRevoked(holder, serial);
    }

    /// Append-only: sold and compromised agents stay listed. Check compromisedAt and isHumanBacked
    /// for current status.
    function agentsOf(address creator) external view returns (uint256[] memory) {
        return _agentsOfCreator[creator];
    }

    /// True for creator wallets, and for a wallet that a linked agent still answers to right now.
    /// The recorded wallet is only a hint, because setAgentWallet and NFT transfers happen in the
    /// Identity Registry without telling this contract. See _backsWallet for what is re-checked.
    /// A compromise report means the key is untrusted, so one report voids the wallet for every agent
    /// sharing it. A creator wallet is exempt: it has no way to register again, so a report on one
    /// agent would otherwise lock that human out for good.
    /// Meant for eth_call by the scorer and indexer: the loop is unbounded and makes two registry
    /// reads per recorded agent.
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
    /// call failed. Compares the owner with linkedOwner, not creatorOf, so a grant-linked agent
    /// stays backed while its own account holds the NFT.
    function _backsWallet(uint256 agentId, address wallet) private view returns (bool) {
        IIdentityRegistry registry = IIdentityRegistry(identityRegistry);
        try registry.getAgentWallet(agentId) returns (address current) {
            if (current != wallet) return false;
        } catch {
            return false;
        }
        try registry.ownerOf(agentId) returns (address owner) {
            return owner == linkedOwner[agentId];
        } catch {
            return false;
        }
    }

    /// Shared gate for every call that vouches for a wallet: the caller must own the NFT right now
    /// and the agent must have a wallet set. ownerOf reverts for an unknown agent, and that revert
    /// is passed through unchanged.
    function _currentWalletOfOwnedAgent(uint256 agentId) private view returns (address wallet) {
        IIdentityRegistry registry = IIdentityRegistry(identityRegistry);
        if (registry.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        wallet = registry.getAgentWallet(agentId);
        if (wallet == address(0)) revert AgentWalletNotSet(agentId);
    }

    /// Records the wallet for isHumanBacked, then delivers the credential. Storage first, so a failed
    /// HTS call reverts the record along with it.
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
    /// The holder and length checks run before isFrozen, the first HTS call, so an address with no
    /// Hedera account fails there with 15 INVALID_ACCOUNT_ID before anything is minted. address(this)
    /// is the treasury, which cannot be wiped (185), so it is refused as a holder.
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
