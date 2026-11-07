// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {HederaResponseCodes} from "./HederaResponseCodes.sol";
import {IHederaTokenService} from "./IHederaTokenService.sol";

/// Calls to the 0x167 system contract. Each one reverts unless the response code is SUCCESS.
/// These are low-level calls because Solidity's extcodesize check does not hold for system
/// contracts, which is also why the official wrappers call this way.
library Hts {
    address internal constant SYSTEM_CONTRACT = address(0x167);

    /// 0x167 answered with a code other than SUCCESS (22). Codes are in HederaResponseCodes.sol
    /// upstream, for example 184 TOKEN_NOT_ASSOCIATED_TO_ACCOUNT.
    error HtsCallFailed(bytes4 selector, int64 responseCode);

    /// 0x167 reverted instead of returning a code. On Hedera, reason is the ASCII status name.
    error HtsCallReverted(bytes4 selector, bytes reason);

    /// Forwards value as the creation fee. The network takes only the fee; the rest stays with the caller.
    function createNft(IHederaTokenService.HederaToken memory token, uint256 value)
        internal
        returns (address tokenAddress)
    {
        bytes memory result = _call(value, abi.encodeCall(IHederaTokenService.createNonFungibleToken, (token)));
        (, tokenAddress) = abi.decode(result, (int64, address));
    }

    /// Amount 0 with one metadata entry is the NFT form of mintToken. Mints to the treasury.
    function mintOne(address token, bytes memory metadata) internal returns (int64 serial) {
        bytes[] memory batch = new bytes[](1);
        batch[0] = metadata;
        bytes memory result = _call(0, abi.encodeCall(IHederaTokenService.mintToken, (token, int64(0), batch)));
        (,, int64[] memory serials) = abi.decode(result, (int64, int64, int64[]));
        serial = serials[0];
    }

    /// Auto-associates a receiver with a free slot; otherwise 184 (no slots) or 262 (slots used up).
    function transferNft(address token, address from, address to, int64 serial) internal {
        _call(0, abi.encodeCall(IHederaTokenService.transferNFT, (token, from, to, serial)));
    }

    /// False for a live account that has no relationship with the token.
    function isFrozen(address token, address account) internal returns (bool frozen) {
        bytes memory result = _call(0, abi.encodeCall(IHederaTokenService.isFrozen, (token, account)));
        (, frozen) = abi.decode(result, (int64, bool));
    }

    /// 184 on an account with no association, 165 when it is already frozen.
    function freeze(address token, address account) internal {
        _call(0, abi.encodeCall(IHederaTokenService.freezeToken, (token, account)));
    }

    /// 184 on an account with no association. Succeeds on an associated account that is not frozen.
    function unfreeze(address token, address account) internal {
        _call(0, abi.encodeCall(IHederaTokenService.unfreezeToken, (token, account)));
    }

    /// Needs an unfrozen relationship (165 otherwise), a serial the account owns (253) and an account
    /// that is not the treasury (185).
    function wipeOne(address token, address account, int64 serial) internal {
        int64[] memory serials = new int64[](1);
        serials[0] = serial;
        _call(0, abi.encodeCall(IHederaTokenService.wipeTokenAccountNFT, (token, account, serials)));
    }

    /// Two failure shapes, kept apart so callers can tell them from each other: the system contract
    /// reverting (HtsCallReverted, raw reason) and it returning a non-SUCCESS code (HtsCallFailed).
    /// Both carry the selector, so a revert from a multi-step issue says which step failed. Every HTS
    /// function returns the response code as its first word, so decoding int64 first works for all.
    function _call(uint256 value, bytes memory callData) private returns (bytes memory result) {
        bool ok;
        (ok, result) = SYSTEM_CONTRACT.call{value: value}(callData);
        if (!ok) revert HtsCallReverted(bytes4(callData), result);
        int64 responseCode = abi.decode(result, (int64));
        if (responseCode != HederaResponseCodes.SUCCESS) revert HtsCallFailed(bytes4(callData), responseCode);
    }
}
