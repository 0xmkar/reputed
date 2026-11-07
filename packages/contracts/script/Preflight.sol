// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {CreatorRegistry} from "../src/CreatorRegistry.sol";
import {HederaResponseCodes} from "../src/hedera/HederaResponseCodes.sol";
import {Hts} from "../src/hedera/Hts.sol";
import {IHederaTokenService as H} from "../src/hedera/IHederaTokenService.sol";

interface ISystemReads {
    function associateToken(address account, address token) external returns (int64);
    function getTokenExpiryInfo(address token) external returns (int64, H.Expiry memory);
    function getTokenDefaultFreezeStatus(address token) external returns (int64, bool);
    function getTokenKey(address token, uint256 keyType) external returns (int64, H.KeyValue memory);
}

interface INftReads {
    function balanceOf(address owner) external view returns (uint256);
}

interface IIdentityWrites {
    function register() external returns (uint256);
    function setAgentWallet(uint256 agentId, address wallet, uint256 deadline, bytes calldata signature) external;
    function transferFrom(address from, address to, uint256 agentId) external;
    function getAgentWallet(uint256 agentId) external view returns (address);
}

/// Stands in for a wallet. The simulator checks no signatures, so this needs no key.
contract Bot {
    function exec(address to, bytes calldata data) external returns (bool ok, bytes memory result) {
        (ok, result) = to.call(data);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// ERC-1271 answer that accepts any signature, for setAgentWallet calls that name a Bot as the wallet.
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}

/// A plain nested revert with no HTS call, to show what the simulator does with one.
contract Cell {
    uint256 public value;

    function setThenRevert() external {
        value = 1;
        revert();
    }
}

/// Read-only check of CreatorRegistry against Hedera's real HTS logic. preflight.mjs sends this as
/// creation code in an eth_call, so the Mirror Node simulates it on live testnet state and nothing
/// is written. All the work is in the constructor, which returns its report instead of runtime code.
/// One scenario per call, because a transaction may only produce a limited number of child records.
contract Preflight {
    struct Accounts {
        address identity;
        address unlimitedSlots;
        address limitedSlots;
        address noSlots;
        address missing;
    }

    address private constant HTS = address(0x167);
    int64 private constant INVALID_ACCOUNT_ID = 15;
    int64 private constant ACCOUNT_FROZEN_FOR_TOKEN = 165;
    int64 private constant TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184;
    int64 private constant CANNOT_WIPE_TOKEN_TREASURY_ACCOUNT = 185;
    int64 private constant INVALID_NFT_ID = 226;
    int64 private constant METADATA_TOO_LONG = 227;
    int64 private constant ACCOUNT_DOES_NOT_OWN_WIPED_NFT = 253;
    int64 private constant KEY_NOT_PROVIDED = 44;

    bytes private _report;
    CreatorRegistry private _registry;
    address private _token;

    constructor(uint256 scenario, Accounts memory accounts, uint256 initValue) payable {
        // Scenario 6 creates its own token, so it skips the registry deploy.
        if (scenario == 6) {
            _rawRules(accounts, initValue);
        } else {
            _deploy(accounts.identity, initValue);
            if (scenario == 1) _tokenShape(initValue);
            if (scenario == 2) _associatedHolder();
            if (scenario == 3) _failures(accounts);
            if (scenario == 4) _autoAssociation(accounts);
            if (scenario == 5) _revocation(accounts);
            if (scenario == 7) _realIdentityRegistry(accounts.identity);
            if (scenario == 8) _walletRotation(accounts.identity);
            if (scenario == 9) _simulatorLimits();
        }
        bytes memory report = _report;
        assembly {
            return(add(report, 32), mload(report))
        }
    }

    /// This contract takes all three roles, so the scenarios can register and issue directly.
    function _deploy(address identity, uint256 initValue) private {
        _registry = new CreatorRegistry(identity, address(this), address(this), address(this));
        _registry.initCredentialToken{value: initValue}();
        _token = _registry.credentialToken();
        _check("collection created", _token != address(0));
    }

    function _tokenShape(uint256 initValue) private {
        address self = address(_registry);
        uint256 kept = self.balance;
        _check("surplus value stays in the contract", kept > 0 && kept < initValue);
        _info("creation fee in tinybars", initValue - kept);

        (, H.Expiry memory expiry) = ISystemReads(HTS).getTokenExpiryInfo(_token);
        _check("auto-renew period is 90 days", expiry.autoRenewPeriod == 7_776_000);
        _check("expiry is set by the network", expiry.second > int64(uint64(block.timestamp)));
        _check("auto-renew account is set", expiry.autoRenewAccount != address(0));

        (, bool freezeDefault) = ISystemReads(HTS).getTokenDefaultFreezeStatus(_token);
        _check("freeze default is false", !freezeDefault);

        address freezeKey = _contractKey(4);
        _check("freeze key is the contract", freezeKey == expiry.autoRenewAccount);
        _check("wipe key is the contract", _contractKey(8) == freezeKey);
        _check("supply key is the contract", _contractKey(16) == freezeKey);
        _check("no admin key", _keyCode(1) == KEY_NOT_PROVIDED);
        _check("no kyc key", _keyCode(2) == KEY_NOT_PROVIDED);
    }

    function _associatedHolder() private {
        Bot holder = new Bot();
        Bot other = new Bot();
        _associate(holder, _token);
        _associate(other, _token);

        _measure("issue to associated holder", _issueCall(address(holder), "ipfs://one"));
        _check("T1.6 holder owns the credential", _balance(address(holder)) == 1);
        _check("T1.6 holder is frozen", _isFrozen(_token, address(holder)));

        (bool ok, bytes memory result) =
            holder.exec(HTS, abi.encodeCall(H.transferNFT, (_token, address(holder), address(other), int64(1))));
        _check("T1.7 holder transfer returns 165", ok && _code(result) == ACCOUNT_FROZEN_FOR_TOKEN);

        _measure("issue to frozen holder", _issueCall(address(holder), "ipfs://two"));
        _check("T1.8 holder has two credentials", _balance(address(holder)) == 2);
        _check("T1.8 holder is frozen again", _isFrozen(_token, address(holder)));
    }

    function _failures(Accounts memory accounts) private {
        (bool ok, bytes memory result) = address(_registry).call(_issueCall(accounts.noSlots, "ipfs://x"));
        _check(
            "T1.5 no slots fails with 184",
            !ok && _isHtsFailure(result, H.transferNFT.selector, TOKEN_NOT_ASSOCIATED_TO_ACCOUNT)
        );

        (ok, result) = address(_registry).call(_issueCall(accounts.missing, "ipfs://x"));
        _check("no account fails with 15", !ok && _isHtsFailure(result, H.isFrozen.selector, INVALID_ACCOUNT_ID));
    }

    function _autoAssociation(Accounts memory accounts) private {
        _measure("issue with auto-association, unlimited slots", _issueCall(accounts.unlimitedSlots, "ipfs://a"));
        _check("holder is frozen after auto-association", _isFrozen(_token, accounts.unlimitedSlots));

        _measure("issue with auto-association, limited slots", _issueCall(accounts.limitedSlots, "ipfs://b"));
        _check("limited holder is frozen", _isFrozen(_token, accounts.limitedSlots));
    }

    function _revocation(Accounts memory accounts) private {
        Bot holder = new Bot();
        _associate(holder, _token);
        _measure("issue", _issueCall(address(holder), "ipfs://one"));
        _measure("issue to second holder", _issueCall(accounts.unlimitedSlots, "ipfs://two"));

        _measure("T1.9 revoke", abi.encodeCall(_registry.revokeCredential, (address(holder), int64(1))));
        _check("T1.9 serial is gone", _balance(address(holder)) == 0);
        _check("holder is refrozen", _isFrozen(_token, address(holder)));

        // The simulator keeps the effects of these failed calls, so nothing after them may read holder state.
        _expectWipeFailure(address(holder), 2, ACCOUNT_DOES_NOT_OWN_WIPED_NFT, "unowned serial fails with 253");
        _expectWipeFailure(address(_registry), 2, CANNOT_WIPE_TOKEN_TREASURY_ACCOUNT, "treasury fails with 185");
        _expectWipeFailure(accounts.noSlots, 2, TOKEN_NOT_ASSOCIATED_TO_ACCOUNT, "unassociated fails with 184");
    }

    function _expectWipeFailure(address holder, int64 serial, int64 code, string memory label) private {
        (bool ok, bytes memory result) =
            address(_registry).call(abi.encodeCall(_registry.revokeCredential, (holder, serial)));
        _check(label, !ok && _isHtsFailure(result, H.wipeTokenAccountNFT.selector, code));
    }

    /// The rules CreatorRegistry and test/doubles/HtsDouble.sol are built on, on a token this
    /// contract holds the keys to.
    function _rawRules(Accounts memory accounts, uint256 initValue) private {
        address token = _createOwnToken(initValue);
        Bot holder = new Bot();
        address h = address(holder);

        _checkCode("freeze with no association", _hts(abi.encodeCall(H.freezeToken, (token, accounts.noSlots))), 184);
        _checkCode("unfreeze with no association", _hts(abi.encodeCall(H.unfreezeToken, (token, accounts.noSlots))), 184);
        _check("isFrozen with no association is false", !_isFrozen(token, accounts.noSlots));
        _checkCode("isFrozen with no account", _hts(abi.encodeCall(H.isFrozen, (token, accounts.missing))), 15);

        _associate(holder, token);
        _checkCode("unfreeze when not frozen", _hts(abi.encodeCall(H.unfreezeToken, (token, h))), 22);
        _checkCode("freeze", _hts(abi.encodeCall(H.freezeToken, (token, h))), 22);
        _checkCode("freeze when frozen", _hts(abi.encodeCall(H.freezeToken, (token, h))), ACCOUNT_FROZEN_FOR_TOKEN);
        _checkCode("unfreeze", _hts(abi.encodeCall(H.unfreezeToken, (token, h))), 22);

        bytes[] memory metadata = new bytes[](1);
        metadata[0] = new bytes(100);
        _checkCode("mint 100 bytes", _hts(abi.encodeCall(H.mintToken, (token, int64(0), metadata))), 22);
        metadata[0] = new bytes(101);
        _checkCode("mint 101 bytes", _hts(abi.encodeCall(H.mintToken, (token, int64(0), metadata))), METADATA_TOO_LONG);

        _checkCode("transfer", _hts(abi.encodeCall(H.transferNFT, (token, address(this), h, int64(1)))), 22);
        _checkCode("freeze holder", _hts(abi.encodeCall(H.freezeToken, (token, h))), 22);

        int64[] memory serials = new int64[](1);
        serials[0] = 1;
        _checkCode(
            "wipe when frozen",
            _hts(abi.encodeCall(H.wipeTokenAccountNFT, (token, h, serials))),
            ACCOUNT_FROZEN_FOR_TOKEN
        );
        _checkCode("transfer of unknown serial", _hts(abi.encodeCall(H.transferNFT, (token, address(this), h, int64(99)))), INVALID_NFT_ID);
    }

    function _createOwnToken(uint256 initValue) private returns (address token) {
        H.TokenKey[] memory keys = new H.TokenKey[](1);
        // 28 = freeze (4) | wipe (8) | supply (16), the same keys CreatorRegistry sets.
        keys[0] = H.TokenKey(28, H.KeyValue(false, address(this), "", "", address(0)));
        H.HederaToken memory spec =
            H.HederaToken("Preflight", "PF", address(this), "", false, 0, false, keys, H.Expiry(0, address(this), 7_776_000));
        (bool ok, bytes memory result) = HTS.call{value: initValue}(abi.encodeCall(H.createNonFungibleToken, (spec)));
        _check("own token created", ok && _code(result) == HederaResponseCodes.SUCCESS);
        (, token) = abi.decode(result, (int64, address));
    }

    /// Runs the real registry end to end, including T3.8. The bots stand in for wallets.
    function _realIdentityRegistry(address identity) private {
        Bot creator = new Bot();
        Bot wallet = new Bot();
        Bot buyer = new Bot();
        _associate(wallet, _token);
        _registry.registerCreator(keccak256("preflight"), address(creator));

        (bool ok, bytes memory result) = creator.exec(identity, abi.encodeWithSignature("register()"));
        _check("identity register", ok);
        uint256 agentId = abi.decode(result, (uint256));
        _info("simulated agent id", agentId);

        (ok,) = creator.exec(
            identity,
            abi.encodeCall(IIdentityWrites.setAgentWallet, (agentId, address(wallet), block.timestamp + 60, ""))
        );
        _check("setAgentWallet", ok);

        uint256 before = gasleft();
        (ok,) = creator.exec(address(_registry), abi.encodeCall(_registry.linkAgent, (agentId)));
        _info("gas: linkAgent, wallet already associated", before - gasleft());
        _check("linkAgent against the real registry", ok);
        _check("creatorOf", _registry.creatorOf(agentId) == address(creator));
        _check("wallet holds the credential", _balance(address(wallet)) == 1);
        _check("wallet is human-backed", _registry.isHumanBacked(address(wallet)));

        (ok,) = creator.exec(
            identity, abi.encodeCall(IIdentityWrites.transferFrom, (address(creator), address(buyer), agentId))
        );
        _check("NFT transfer", ok);
        _check("T3.8 transfer clears the wallet", IIdentityWrites(identity).getAgentWallet(agentId) == address(0));
        _check("T3.8 creatorOf is unchanged", _registry.creatorOf(agentId) == address(creator));
        _check("old wallet is no longer human-backed", !_registry.isHumanBacked(address(wallet)));
        _check("the creator still is", _registry.isHumanBacked(address(creator)));
    }

    /// Finding from review: a wallet rotated in after linking had no way to become human-backed.
    function _walletRotation(address identity) private {
        Bot creator = new Bot();
        Bot first = new Bot();
        Bot second = new Bot();
        _associate(first, _token);
        _associate(second, _token);
        _registry.registerCreator(keccak256("preflight"), address(creator));

        (, bytes memory result) = creator.exec(identity, abi.encodeWithSignature("register()"));
        uint256 agentId = abi.decode(result, (uint256));
        _setWallet(creator, identity, agentId, first);
        (bool ok,) = creator.exec(address(_registry), abi.encodeCall(_registry.linkAgent, (agentId)));
        _check("linkAgent", ok);

        _setWallet(creator, identity, agentId, second);
        _check("old wallet drops on rotation", !_registry.isHumanBacked(address(first)));
        _check("new wallet is not backed before sync", !_registry.isHumanBacked(address(second)));

        uint256 before = gasleft();
        (ok,) = creator.exec(address(_registry), abi.encodeCall(_registry.syncAgentWallet, (agentId)));
        _info("gas: syncAgentWallet, wallet already associated", before - gasleft());
        _check("syncAgentWallet against the real registry", ok);
        _check("new wallet is human-backed", _registry.isHumanBacked(address(second)));
        _check("old wallet stays unbacked", !_registry.isHumanBacked(address(first)));
        _check("new wallet holds a credential", _balance(address(second)) == 1);
        _check("new wallet is frozen", _isFrozen(_token, address(second)));
    }

    function _setWallet(Bot creator, address identity, uint256 agentId, Bot wallet) private {
        (bool ok,) = creator.exec(
            identity,
            abi.encodeCall(IIdentityWrites.setAgentWallet, (agentId, address(wallet), block.timestamp + 60, ""))
        );
        _check("setAgentWallet", ok);
    }

    /// INFO only, because these lines describe the simulator and not the contract. They are why the
    /// preflight cannot stand in for the funded checks. See "Evidence" in the README.
    function _simulatorLimits() private {
        Cell cell = new Cell();
        (bool ok,) = address(cell).call(abi.encodeCall(Cell.setThenRevert, ()));
        _check("nested call reverted", !ok);
        _info("plain storage write surviving a nested revert (1 = kept)", cell.value());

        Bot holder = new Bot();
        _associate(holder, _token);
        _measure("issue", _issueCall(address(holder), "ipfs://one"));
        (ok,) = address(_registry).call(abi.encodeCall(_registry.revokeCredential, (address(holder), int64(99))));
        _check("revoke of a wrong serial reverted", !ok);
        _info("holder frozen after that revert (0 = unfreeze was kept)", _isFrozen(_token, address(holder)) ? 1 : 0);

        Bot stranger = new Bot();
        (, bytes memory result) = stranger.exec(HTS, abi.encodeCall(H.freezeToken, (_token, address(holder))));
        _info("freeze by a contract without the freeze key, response code (22 = allowed)", uint256(uint64(_code(result))));
    }

    function _issueCall(address to, bytes memory metadata) private view returns (bytes memory) {
        return abi.encodeCall(_registry.issueCredential, (to, metadata));
    }

    /// The gas figures are what the README's limits table lists as simulated gas.
    function _measure(string memory label, bytes memory data) private {
        uint256 before = gasleft();
        (bool ok,) = address(_registry).call(data);
        _info(string.concat("gas: ", label), before - gasleft());
        _check(label, ok);
    }

    function _associate(Bot bot, address token) private {
        (bool ok, bytes memory result) =
            bot.exec(HTS, abi.encodeCall(ISystemReads.associateToken, (address(bot), token)));
        _check("holder associated", ok && _code(result) == HederaResponseCodes.SUCCESS);
    }

    /// -1 stands for a revert; no response code is negative.
    function _hts(bytes memory data) private returns (int64) {
        (bool ok, bytes memory result) = HTS.call(data);
        return ok ? _code(result) : int64(-1);
    }

    function _isFrozen(address token, address account) private returns (bool frozen) {
        (, bytes memory result) = HTS.call(abi.encodeCall(H.isFrozen, (token, account)));
        (, frozen) = abi.decode(result, (int64, bool));
    }

    function _keyCode(uint256 keyType) private returns (int64) {
        (bool ok, bytes memory result) = HTS.call(abi.encodeCall(ISystemReads.getTokenKey, (_token, keyType)));
        return ok ? _code(result) : int64(-1);
    }

    function _contractKey(uint256 keyType) private returns (address) {
        (, H.KeyValue memory key) = ISystemReads(HTS).getTokenKey(_token, keyType);
        return key.contractId;
    }

    function _balance(address account) private view returns (uint256) {
        return INftReads(_token).balanceOf(account);
    }

    function _code(bytes memory result) private pure returns (int64) {
        return abi.decode(result, (int64));
    }

    /// Exact match on the encoded error, so a failure at another step or with another code reads as FAIL.
    function _isHtsFailure(bytes memory result, bytes4 selector, int64 code) private pure returns (bool) {
        return keccak256(result) == keccak256(abi.encodeWithSelector(Hts.HtsCallFailed.selector, selector, code));
    }

    function _checkCode(string memory label, int64 got, int64 want) private {
        _check(string.concat(label, " returns ", _decimal(uint256(uint64(want)))), got == want);
    }

    function _check(string memory label, bool pass) private {
        _report = bytes.concat(_report, pass ? bytes("PASS ") : bytes("FAIL "), bytes(label), "\n");
    }

    function _info(string memory label, uint256 value) private {
        _report = bytes.concat(_report, "INFO ", bytes(label), ": ", bytes(_decimal(value)), "\n");
    }

    function _decimal(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 rest = value; rest != 0; rest /= 10) ++digits;
        bytes memory text = new bytes(digits);
        for (; value != 0; value /= 10) text[--digits] = bytes1(uint8(48 + value % 10));
        return string(text);
    }
}
