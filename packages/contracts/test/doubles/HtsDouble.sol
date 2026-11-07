// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IHederaTokenService} from "../../src/hedera/IHederaTokenService.sol";

/// Test double for the 0x167 system contract, for one NFT collection. Tests place it with vm.etch.
/// The rules come from the consensus node handlers and were observed through Mirror Node simulation
/// on testnet (script/preflight.mjs), except the signature rules, which come from source alone because
/// the simulator enforces none. What it does not model: surplus value staying with the caller, because
/// the real system contract never takes custody of msg.value, and gas. So nothing in this suite can
/// catch a gas limit that is too low: linkAgent passes here at 1,000,000 and needs more on Hedera.
/// The 1,500,000 limit in the README is only enforced by whoever integrates the call.
contract HtsDouble {
    int64 public constant INSUFFICIENT_TX_FEE = 9;
    int64 public constant INVALID_ACCOUNT_ID = 15;
    int64 public constant SUCCESS = 22;
    int64 public constant AUTORENEW_DURATION_NOT_IN_RANGE = 81;
    int64 public constant ACCOUNT_FROZEN_FOR_TOKEN = 165;
    int64 public constant INVALID_TOKEN_ID = 167;
    int64 public constant TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184;
    int64 public constant CANNOT_WIPE_TOKEN_TREASURY_ACCOUNT = 185;
    int64 public constant INVALID_NFT_ID = 226;
    int64 public constant METADATA_TOO_LONG = 227;
    int64 public constant SENDER_DOES_NOT_OWN_NFT_SERIAL_NO = 237;
    int64 public constant ACCOUNT_DOES_NOT_OWN_WIPED_NFT = 253;
    int64 public constant NO_REMAINING_AUTOMATIC_ASSOCIATIONS = 262;
    int64 public constant INVALID_FULL_PREFIX_SIGNATURE_FOR_PRECOMPILE = 326;

    int64 public constant UNLIMITED_ASSOCIATIONS = -1;
    uint256 public constant CREATE_FEE = 1_740_000_000; // tinybars, measured on testnet
    int64 private constant MIN_AUTO_RENEW = 2_592_000;
    int64 private constant MAX_AUTO_RENEW = 8_000_001;
    uint256 private constant REQUIRED_KEYS = 28; // freeze, wipe and supply
    address public constant TOKEN = address(0xAD07BF);

    struct Account {
        bool exists;
        int64 maxAutoAssociations;
        int64 usedAutoAssociations;
        bool receiverSigRequired;
    }

    struct Relationship {
        bool exists;
        bool frozen;
    }

    struct Nft {
        address owner;
        bytes metadata;
    }

    mapping(address => Account) public accounts;
    mapping(address => Relationship) public relationships;
    mapping(int64 => Nft) private _nfts;
    mapping(address => int64) public balanceOf;

    bool public created;
    address public treasury;
    address public keyHolder;
    bool public freezeDefault;
    string public name;
    string public symbol;
    string public memo;
    bool public finiteSupply;
    int64 public maxSupply;
    IHederaTokenService.Expiry public expiry;
    uint256 public keyBits;
    uint256 public keysInCreate;
    uint256 public valueReceived;
    int64 public totalSupply;
    int64 public lastSerial;

    mapping(bytes4 => int64) private _forcedCode;
    mapping(bytes4 => bool) private _forcedRevert;

    // Test controls.

    function addAccount(address account, int64 maxAutoAssociations) external {
        accounts[account] = Account(true, maxAutoAssociations, 0, false);
    }

    function setReceiverSigRequired(address account, bool required) external {
        accounts[account].receiverSigRequired = required;
    }

    function setUsedAutoAssociations(address account, int64 used) external {
        accounts[account].usedAutoAssociations = used;
    }

    /// Stands in for the holder's own TokenAssociate transaction.
    function associate(address account) external {
        relationships[account] = Relationship(true, created && freezeDefault);
    }

    function forceCode(bytes4 selector, int64 code) external {
        _forcedCode[selector] = code;
    }

    function forceRevert(bytes4 selector) external {
        _forcedRevert[selector] = true;
    }

    function ownerOf(int64 serial) external view returns (address) {
        return _nfts[serial].owner;
    }

    function metadataOf(int64 serial) external view returns (bytes memory) {
        return _nfts[serial].metadata;
    }

    // System contract surface.

    function createNonFungibleToken(IHederaTokenService.HederaToken memory token)
        external
        payable
        returns (int64 responseCode, address tokenAddress)
    {
        _maybeRevert();
        if (msg.value < CREATE_FEE) return (INSUFFICIENT_TX_FEE, address(0));
        int64 forced = _forcedCode[msg.sig];
        if (forced != 0) return (forced, address(0));

        if (token.treasury != msg.sender || token.expiry.autoRenewAccount != msg.sender) {
            return (INVALID_FULL_PREFIX_SIGNATURE_FOR_PRECOMPILE, address(0));
        }
        if (token.expiry.autoRenewPeriod < MIN_AUTO_RENEW || token.expiry.autoRenewPeriod > MAX_AUTO_RENEW) {
            return (AUTORENEW_DURATION_NOT_IN_RANGE, address(0));
        }

        keysInCreate = token.tokenKeys.length;
        for (uint256 i = 0; i < token.tokenKeys.length; ++i) {
            keyBits |= token.tokenKeys[i].keyType;
            keyHolder = token.tokenKeys[i].key.contractId;
        }
        require(keyBits == REQUIRED_KEYS, "double: expected freeze, wipe and supply keys only");

        created = true;
        treasury = token.treasury;
        freezeDefault = token.freezeDefault;
        name = token.name;
        symbol = token.symbol;
        memo = token.memo;
        finiteSupply = token.tokenSupplyType;
        maxSupply = token.maxSupply;
        expiry = token.expiry;
        valueReceived = msg.value;
        accounts[token.treasury].exists = true;
        relationships[token.treasury] = Relationship(true, false);
        return (SUCCESS, TOKEN);
    }

    function mintToken(address token, int64, bytes[] memory metadata)
        external
        returns (int64 responseCode, int64 newTotalSupply, int64[] memory serialNumbers)
    {
        serialNumbers = new int64[](0);
        _maybeRevert();
        int64 precheck = _precheck(token);
        if (precheck != SUCCESS) return (precheck, 0, serialNumbers);

        serialNumbers = new int64[](metadata.length);
        for (uint256 i = 0; i < metadata.length; ++i) {
            if (metadata[i].length > 100) return (METADATA_TOO_LONG, 0, new int64[](0));
            int64 serial = ++lastSerial;
            _nfts[serial] = Nft(treasury, metadata[i]);
            serialNumbers[i] = serial;
            ++balanceOf[treasury];
            ++totalSupply;
        }
        return (SUCCESS, totalSupply, serialNumbers);
    }

    function isFrozen(address token, address account) external view returns (int64 responseCode, bool frozen) {
        _maybeRevert();
        int64 forced = _forcedCode[msg.sig];
        if (forced != 0) return (forced, false);
        if (token != TOKEN || !created) return (INVALID_TOKEN_ID, false);
        if (!accounts[account].exists) return (INVALID_ACCOUNT_ID, false);
        return (SUCCESS, relationships[account].frozen);
    }

    /// Fails on a relationship that is already frozen, unlike unfreezeToken.
    function freezeToken(address token, address account) external returns (int64 responseCode) {
        _maybeRevert();
        responseCode = _precheck(token);
        if (responseCode != SUCCESS) return responseCode;
        if (!accounts[account].exists) return INVALID_ACCOUNT_ID;
        Relationship storage rel = relationships[account];
        if (!rel.exists) return TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
        if (rel.frozen) return ACCOUNT_FROZEN_FOR_TOKEN;
        rel.frozen = true;
    }

    function unfreezeToken(address token, address account) external returns (int64 responseCode) {
        _maybeRevert();
        responseCode = _precheck(token);
        if (responseCode != SUCCESS) return responseCode;
        if (!accounts[account].exists) return INVALID_ACCOUNT_ID;
        Relationship storage rel = relationships[account];
        if (!rel.exists) return TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
        rel.frozen = false;
    }

    function transferNFT(address token, address sender, address recipient, int64 serial)
        external
        returns (int64 responseCode)
    {
        _maybeRevert();
        int64 forced = _forcedCode[msg.sig];
        if (forced != 0) return forced;
        if (token != TOKEN || !created) return INVALID_TOKEN_ID;
        if (msg.sender != sender) return INVALID_FULL_PREFIX_SIGNATURE_FOR_PRECOMPILE;
        if (!relationships[sender].exists) return TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
        if (_nfts[serial].owner == address(0)) return INVALID_NFT_ID;

        responseCode = _prepareRecipient(recipient);
        if (responseCode != SUCCESS) return responseCode;

        if (_nfts[serial].owner != sender) return SENDER_DOES_NOT_OWN_NFT_SERIAL_NO;
        if (relationships[sender].frozen) return ACCOUNT_FROZEN_FOR_TOKEN;

        _nfts[serial].owner = recipient;
        --balanceOf[sender];
        ++balanceOf[recipient];
    }

    function wipeTokenAccountNFT(address token, address account, int64[] memory serialNumbers)
        external
        returns (int64 responseCode)
    {
        _maybeRevert();
        responseCode = _precheck(token);
        if (responseCode != SUCCESS) return responseCode;
        if (!accounts[account].exists) return INVALID_ACCOUNT_ID;
        Relationship storage rel = relationships[account];
        if (!rel.exists) return TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
        if (rel.frozen) return ACCOUNT_FROZEN_FOR_TOKEN;
        if (account == treasury) return CANNOT_WIPE_TOKEN_TREASURY_ACCOUNT;

        for (uint256 i = 0; i < serialNumbers.length; ++i) {
            int64 serial = serialNumbers[i];
            if (_nfts[serial].owner == address(0)) return INVALID_NFT_ID;
            if (_nfts[serial].owner != account) return ACCOUNT_DOES_NOT_OWN_WIPED_NFT;
            delete _nfts[serial];
            --balanceOf[account];
            --totalSupply;
        }
    }

    function _prepareRecipient(address recipient) private returns (int64) {
        Account storage account = accounts[recipient];
        if (!account.exists) return INVALID_ACCOUNT_ID;
        // Never observed: the code is a best reading of the source, and only "it fails" is relied on.
        // Signatures are checked before the transfer runs, so this comes ahead of the association rules.
        if (account.receiverSigRequired) return INVALID_FULL_PREFIX_SIGNATURE_FOR_PRECOMPILE;

        Relationship storage rel = relationships[recipient];
        if (rel.exists) return rel.frozen ? ACCOUNT_FROZEN_FOR_TOKEN : SUCCESS;

        if (account.maxAutoAssociations == 0) return TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
        bool unlimited = account.maxAutoAssociations == UNLIMITED_ASSOCIATIONS;
        if (!unlimited && account.usedAutoAssociations >= account.maxAutoAssociations) {
            return NO_REMAINING_AUTOMATIC_ASSOCIATIONS;
        }
        if (freezeDefault) return ACCOUNT_FROZEN_FOR_TOKEN;

        ++account.usedAutoAssociations;
        rel.exists = true;
        return SUCCESS;
    }

    /// Shared checks for calls that need the token's contract key.
    function _precheck(address token) private view returns (int64) {
        int64 forced = _forcedCode[msg.sig];
        if (forced != 0) return forced;
        if (token != TOKEN || !created) return INVALID_TOKEN_ID;
        if (msg.sender != keyHolder) return INVALID_FULL_PREFIX_SIGNATURE_FOR_PRECOMPILE;
        return SUCCESS;
    }

    function _maybeRevert() private view {
        if (_forcedRevert[msg.sig]) {
            bytes memory reason = "INVALID_TRANSACTION_BODY";
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }
}
