// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// Subset of the Hedera Token Service system contract at 0x167.
/// Structs and signatures are copied unchanged from
/// the npm package hiero-ledger/hiero-contracts 0.2.0, token-service/IHederaTokenService.sol, and match the
/// V3 createNonFungibleToken and V2 mintToken methods in the consensus node's translators.
/// A wrong struct layout only fails on a real network, so CreatorRegistry.t.sol pins every selector.
interface IHederaTokenService {
    struct Expiry {
        int64 second;
        address autoRenewAccount;
        int64 autoRenewPeriod;
    }

    struct KeyValue {
        bool inheritAccountKey;
        address contractId;
        bytes ed25519;
        bytes ECDSA_secp256k1;
        address delegatableContractId;
    }

    /// keyType is a bit field: 0 admin, 1 kyc, 2 freeze, 3 wipe, 4 supply, 5 fee schedule, 6 pause.
    struct TokenKey {
        uint256 keyType;
        KeyValue key;
    }

    struct HederaToken {
        string name;
        string symbol;
        address treasury;
        string memo;
        bool tokenSupplyType; // false is INFINITE
        int64 maxSupply;
        bool freezeDefault;
        TokenKey[] tokenKeys;
        Expiry expiry;
    }

    function createNonFungibleToken(HederaToken memory token)
        external
        payable
        returns (int64 responseCode, address tokenAddress);

    function mintToken(address token, int64 amount, bytes[] memory metadata)
        external
        returns (int64 responseCode, int64 newTotalSupply, int64[] memory serialNumbers);

    function transferNFT(address token, address sender, address recipient, int64 serialNumber)
        external
        returns (int64 responseCode);

    function isFrozen(address token, address account) external returns (int64 responseCode, bool frozen);

    function freezeToken(address token, address account) external returns (int64 responseCode);

    function unfreezeToken(address token, address account) external returns (int64 responseCode);

    function wipeTokenAccountNFT(address token, address account, int64[] memory serialNumbers)
        external
        returns (int64 responseCode);
}
