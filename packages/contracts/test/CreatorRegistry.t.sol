// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Test} from "forge-std/Test.sol";

import {RollbackProbe} from "../script/RollbackProbe.sol";
import {CreatorRegistry} from "../src/CreatorRegistry.sol";
import {Hts} from "../src/hedera/Hts.sol";
import {IHederaTokenService} from "../src/hedera/IHederaTokenService.sol";
import {ICreatorRegistry} from "../src/interfaces/ICreatorRegistry.sol";
import {HtsDouble} from "./doubles/HtsDouble.sol";
import {IdentityRegistryDouble} from "./doubles/IdentityRegistryDouble.sol";

abstract contract Base is Test {
    event CreatorRegistered(bytes32 indexed nullifierHash, address indexed wallet);
    event AgentLinked(uint256 indexed agentId, address indexed creator, address indexed agentWallet, int64 serial);
    event AgentCompromised(uint256 indexed agentId, address indexed creator, uint256 timestamp);
    event CredentialIssued(address indexed holder, int64 serial);
    event CredentialRevoked(address indexed holder, int64 serial);
    event AgentWalletSynced(uint256 indexed agentId, address indexed creator, address indexed agentWallet, int64 serial);

    bytes4 internal constant CREATE = IHederaTokenService.createNonFungibleToken.selector;
    bytes4 internal constant MINT = IHederaTokenService.mintToken.selector;
    bytes4 internal constant IS_FROZEN = IHederaTokenService.isFrozen.selector;
    bytes4 internal constant FREEZE = IHederaTokenService.freezeToken.selector;
    bytes4 internal constant UNFREEZE = IHederaTokenService.unfreezeToken.selector;
    bytes4 internal constant TRANSFER = IHederaTokenService.transferNFT.selector;
    bytes4 internal constant WIPE = IHederaTokenService.wipeTokenAccountNFT.selector;

    uint256 internal constant INIT_VALUE = 20e8; // 20 HBAR: contracts count tinybars
    bytes32 internal constant N1 = keccak256("nullifier 1");
    bytes32 internal constant N2 = keccak256("nullifier 2");

    address internal admin = makeAddr("admin");
    address internal verifier = makeAddr("verifier");
    address internal issuer = makeAddr("issuer");
    address internal creatorA = makeAddr("creatorA");
    address internal creatorB = makeAddr("creatorB");
    address internal walletU = makeAddr("walletU");
    address internal holder = makeAddr("holder");
    address internal agentWallet = makeAddr("agentWallet");

    HtsDouble internal hts = HtsDouble(address(0x167));
    IdentityRegistryDouble internal identity;
    CreatorRegistry internal registry;

    function setUp() public virtual {
        vm.etch(address(0x167), address(new HtsDouble()).code);
        identity = new IdentityRegistryDouble();
        registry = new CreatorRegistry(address(identity), admin, verifier, issuer);
        vm.deal(admin, 100e8);
        for (uint256 i = 0; i < 6; ++i) {
            hts.addAccount([creatorA, creatorB, walletU, holder, agentWallet, issuer][i], 0);
        }
    }

    function _init() internal {
        vm.prank(admin);
        registry.initCredentialToken{value: INIT_VALUE}();
    }

    function _register(bytes32 nullifier, address wallet) internal {
        vm.prank(verifier);
        registry.registerCreator(nullifier, wallet);
    }

    function _issue(address to, bytes memory metadata) internal returns (int64) {
        vm.prank(issuer);
        return registry.issueCredential(to, metadata);
    }

    function _revertsWith(bytes4 selector, int64 code) internal {
        vm.expectRevert(abi.encodeWithSelector(Hts.HtsCallFailed.selector, selector, code));
    }

    function _missingRole(address account, bytes32 role) internal {
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, account, role));
    }

    function _frozen(address account) internal view returns (bool frozen) {
        (, frozen) = hts.relationships(account);
    }

    function _associated(address account) internal view returns (bool exists) {
        (exists,) = hts.relationships(account);
    }
}

contract ConstructorTest is Base {
    function test_rolesAreSeparate() public view {
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(registry.hasRole(registry.VERIFIER_ROLE(), verifier));
        assertTrue(registry.hasRole(registry.ISSUER_ROLE(), issuer));

        assertFalse(registry.hasRole(registry.VERIFIER_ROLE(), admin));
        assertFalse(registry.hasRole(registry.ISSUER_ROLE(), admin));
        assertFalse(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), verifier));
        assertFalse(registry.hasRole(registry.ISSUER_ROLE(), verifier));
        assertFalse(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), issuer));
        assertFalse(registry.hasRole(registry.VERIFIER_ROLE(), issuer));
    }

    function test_identityRegistryIsStored() public view {
        assertEq(registry.identityRegistry(), address(identity));
        assertEq(registry.credentialToken(), address(0));
    }

    function test_revertsOnEachZeroAddress() public {
        address id = address(identity);
        vm.expectRevert(CreatorRegistry.ZeroAddress.selector);
        new CreatorRegistry(address(0), admin, verifier, issuer);
        vm.expectRevert(CreatorRegistry.ZeroAddress.selector);
        new CreatorRegistry(id, address(0), verifier, issuer);
        vm.expectRevert(CreatorRegistry.ZeroAddress.selector);
        new CreatorRegistry(id, admin, address(0), issuer);
        vm.expectRevert(CreatorRegistry.ZeroAddress.selector);
        new CreatorRegistry(id, admin, verifier, address(0));
    }

    function test_adminCanRotateRoles() public {
        bytes32 role = registry.VERIFIER_ROLE();
        vm.startPrank(admin);
        registry.grantRole(role, walletU);
        registry.revokeRole(role, verifier);
        vm.stopPrank();

        _missingRole(verifier, role);
        vm.prank(verifier);
        registry.registerCreator(N1, creatorA);

        vm.prank(walletU);
        registry.registerCreator(N1, creatorA);
        assertTrue(registry.isCreator(creatorA));
    }

    function test_nonAdminCannotGrantRoles() public {
        bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();
        bytes32 role = registry.VERIFIER_ROLE();
        _missingRole(verifier, adminRole);
        vm.prank(verifier);
        registry.grantRole(role, walletU);
    }
}

contract SelectorsTest is Test {
    /// Literal values from the consensus node's translators. A changed struct changes the selector,
    /// and that mistake would otherwise only show up on a real network.
    function test_systemContractSelectors() public pure {
        assertEq(
            IHederaTokenService.createNonFungibleToken.selector,
            bytes4(
                keccak256(
                    "createNonFungibleToken((string,string,address,string,bool,int64,bool,(uint256,(bool,address,bytes,bytes,address))[],(int64,address,int64)))"
                )
            )
        );
        assertEq(IHederaTokenService.createNonFungibleToken.selector, bytes4(0xea83f293));
        assertEq(IHederaTokenService.mintToken.selector, bytes4(0xe0f4059a));
        assertEq(IHederaTokenService.transferNFT.selector, bytes4(0x5cfc9011));
        assertEq(IHederaTokenService.isFrozen.selector, bytes4(0x46de0fb1));
        assertEq(IHederaTokenService.freezeToken.selector, bytes4(0x5b8f8584));
        assertEq(IHederaTokenService.unfreezeToken.selector, bytes4(0x52f91387));
        assertEq(IHederaTokenService.wipeTokenAccountNFT.selector, bytes4(0xf7f38e26));
    }
}

contract InitCredentialTokenTest is Base {
    function test_createsCollectionTheContractControls() public {
        _init();

        assertEq(registry.credentialToken(), hts.TOKEN());
        assertEq(hts.treasury(), address(registry));
        assertEq(hts.keyHolder(), address(registry));
        assertEq(hts.keyBits(), 28, "freeze, wipe and supply");
        assertEq(hts.keysInCreate(), 1);
        assertFalse(hts.freezeDefault());
        assertFalse(hts.finiteSupply());
        assertEq(hts.maxSupply(), 0);
        assertEq(hts.symbol(), "RPTD");
        assertEq(hts.name(), "Reputed Credential");

        (int64 second, address autoRenewAccount, int64 period) = hts.expiry();
        assertEq(second, 0);
        assertEq(autoRenewAccount, address(registry));
        assertEq(period, 7_776_000);
    }

    function test_forwardsValue() public {
        _init();
        assertEq(hts.valueReceived(), INIT_VALUE);
    }

    function test_revertsForNonAdmin() public {
        bytes32 role = registry.DEFAULT_ADMIN_ROLE();
        vm.deal(verifier, INIT_VALUE);
        _missingRole(verifier, role);
        vm.prank(verifier);
        registry.initCredentialToken{value: INIT_VALUE}();
    }

    function test_revertsTheSecondTime() public {
        _init();
        vm.expectRevert(CreatorRegistry.CredentialTokenAlreadyInitialized.selector);
        vm.prank(admin);
        registry.initCredentialToken{value: INIT_VALUE}();
    }

    function test_revertsWhenFeeIsTooLow() public {
        _revertsWith(CREATE, hts.INSUFFICIENT_TX_FEE());
        vm.prank(admin);
        registry.initCredentialToken{value: 1e8}();
        assertEq(registry.credentialToken(), address(0));
    }

    function test_revertsOnAnyNonSuccessCode() public {
        hts.forceCode(CREATE, 174);
        _revertsWith(CREATE, 174);
        vm.prank(admin);
        registry.initCredentialToken{value: INIT_VALUE}();
        assertEq(registry.credentialToken(), address(0));
    }

    function test_keepsTheReasonWhenSystemContractReverts() public {
        hts.forceRevert(CREATE);
        vm.expectRevert(abi.encodeWithSelector(Hts.HtsCallReverted.selector, CREATE, bytes("INVALID_TRANSACTION_BODY")));
        vm.prank(admin);
        registry.initCredentialToken{value: INIT_VALUE}();
    }
}

contract RegisterCreatorTest is Base {
    function test_T1_3_revertsForNonVerifier() public {
        bytes32 role = registry.VERIFIER_ROLE();
        _missingRole(walletU, role);
        vm.prank(walletU);
        registry.registerCreator(N1, creatorA);
    }

    function test_adminIsNotImplicitlyVerifier() public {
        bytes32 role = registry.VERIFIER_ROLE();
        _missingRole(admin, role);
        vm.prank(admin);
        registry.registerCreator(N1, creatorA);
    }

    function test_T1_4_registersAndEmits() public {
        vm.expectEmit(address(registry));
        emit CreatorRegistered(N1, creatorA);
        _register(N1, creatorA);

        assertTrue(registry.isCreator(creatorA));
        assertEq(registry.walletOfNullifier(N1), creatorA);
    }

    function test_T1_4_revertsOnRepeatedNullifier() public {
        _register(N1, creatorA);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.NullifierAlreadyRegistered.selector, N1));
        _register(N1, creatorB);
        assertFalse(registry.isCreator(creatorB));
    }

    function test_revertsOnRepeatedWallet() public {
        _register(N1, creatorA);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.WalletAlreadyRegistered.selector, creatorA));
        _register(N2, creatorA);
        assertEq(registry.walletOfNullifier(N2), address(0));
    }

    function test_revertsOnZeroWallet() public {
        vm.expectRevert(CreatorRegistry.ZeroAddress.selector);
        _register(N1, address(0));
    }
}

contract LinkAgentTest is Base {
    uint256 internal agentId;

    function setUp() public override {
        super.setUp();
        _init();
        _register(N1, creatorA);
        _register(N2, creatorB);
        agentId = identity.register(creatorA);
        identity.setAgentWallet(agentId, agentWallet);
        hts.associate(agentWallet);
    }

    function test_T3_4_linksAndIssuesFrozenCredential() public {
        vm.expectEmit(address(registry));
        emit CredentialIssued(agentWallet, 1);
        vm.expectEmit(address(registry));
        emit AgentLinked(agentId, creatorA, agentWallet, 1);
        vm.prank(creatorA);
        registry.linkAgent(agentId);

        assertEq(registry.creatorOf(agentId), creatorA);
        assertEq(hts.ownerOf(1), agentWallet);
        assertTrue(_frozen(agentWallet));
        assertTrue(registry.isHumanBacked(agentWallet));

        uint256[] memory agents = registry.agentsOf(creatorA);
        assertEq(agents.length, 1);
        assertEq(agents[0], agentId);
    }

    function test_agentIdZeroIsAValidAgent() public {
        assertEq(agentId, 0);
        vm.prank(creatorA);
        registry.linkAgent(0);
        assertEq(registry.creatorOf(0), creatorA);

        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.AlreadyLinked.selector, 0));
        vm.prank(creatorA);
        registry.linkAgent(0);
    }

    function test_metadataNamesTheAgent() public {
        uint256 second = identity.register(creatorA);
        identity.setAgentWallet(second, agentWallet);
        vm.startPrank(creatorA);
        registry.linkAgent(agentId);
        registry.linkAgent(second);
        vm.stopPrank();

        assertEq(hts.metadataOf(1), bytes("reputed:human-backed:0"));
        assertEq(hts.metadataOf(2), bytes("reputed:human-backed:1"));
    }

    function test_defaultWalletIsTheCreatorItself() public {
        uint256 id = identity.register(creatorA);
        hts.associate(creatorA);
        vm.prank(creatorA);
        registry.linkAgent(id);
        assertEq(hts.ownerOf(1), creatorA);
        assertTrue(_frozen(creatorA));
    }

    function test_T3_2_revertsForNonCreator() public {
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.NotCreator.selector, walletU));
        vm.prank(walletU);
        registry.linkAgent(agentId);
    }

    function test_T3_3_revertsForAnotherCreatorsAgent() public {
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.NotAgentOwner.selector, agentId, creatorB));
        vm.prank(creatorB);
        registry.linkAgent(agentId);
    }

    function test_revertsForUnknownAgent() public {
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistryDouble.ERC721NonexistentToken.selector, 99));
        vm.prank(creatorA);
        registry.linkAgent(99);
    }

    function test_T3_5_revertsWhenAlreadyLinked() public {
        vm.startPrank(creatorA);
        registry.linkAgent(agentId);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.AlreadyLinked.selector, agentId));
        registry.linkAgent(agentId);
        vm.stopPrank();
    }

    function test_T3_8_linkIsPermanentAndCannotMoveToANewOwner() public {
        vm.prank(creatorA);
        registry.linkAgent(agentId);
        identity.transfer(agentId, creatorB);

        assertEq(registry.creatorOf(agentId), creatorA);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.AlreadyLinked.selector, agentId));
        vm.prank(creatorB);
        registry.linkAgent(agentId);
    }

    function test_revertsWhenAgentWalletIsClear() public {
        identity.setAgentWallet(agentId, address(0));
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.AgentWalletNotSet.selector, agentId));
        vm.prank(creatorA);
        registry.linkAgent(agentId);
    }

    function test_T3_6_unassociatedWalletRevertsAndLeavesNoLink() public {
        identity.setAgentWallet(agentId, holder);

        _revertsWith(TRANSFER, hts.TOKEN_NOT_ASSOCIATED_TO_ACCOUNT());
        vm.prank(creatorA);
        registry.linkAgent(agentId);

        assertEq(registry.creatorOf(agentId), address(0));
        assertEq(registry.agentsOf(creatorA).length, 0);
        assertFalse(registry.isHumanBacked(holder));
        assertEq(hts.totalSupply(), 0);
    }

    function test_receiverSigRequiredWalletRevertsAndLeavesNoLink() public {
        hts.setReceiverSigRequired(agentWallet, true);

        _revertsWith(TRANSFER, hts.INVALID_FULL_PREFIX_SIGNATURE_FOR_PRECOMPILE());
        vm.prank(creatorA);
        registry.linkAgent(agentId);

        assertEq(registry.creatorOf(agentId), address(0));
        assertFalse(registry.isHumanBacked(agentWallet));
    }

    function test_revertsBeforeTokenExists() public {
        CreatorRegistry fresh = new CreatorRegistry(address(identity), admin, verifier, issuer);
        vm.prank(verifier);
        fresh.registerCreator(N1, creatorA);

        vm.expectRevert(CreatorRegistry.CredentialTokenNotInitialized.selector);
        vm.prank(creatorA);
        fresh.linkAgent(agentId);
    }
}

contract LinkMetadataTest is Base {
    /// Every uint256 agent ID has to fit HTS's 100-byte metadata limit.
    function test_largestAgentIdFitsMetadataLimit() public {
        _init();
        _register(N1, creatorA);
        hts.associate(creatorA);

        uint256 id = type(uint256).max;
        identity.registerAt(id, creatorA);

        vm.prank(creatorA);
        registry.linkAgent(id);
        assertEq(hts.metadataOf(1).length, 99);
    }
}

contract ReportCompromiseTest is Base {
    uint256 internal agentId;

    function setUp() public override {
        super.setUp();
        _init();
        _register(N1, creatorA);
        _register(N2, creatorB);
        agentId = identity.register(creatorA);
        hts.associate(creatorA);
        vm.prank(creatorA);
        registry.linkAgent(agentId);
    }

    function test_recordsTimeAndEmits() public {
        vm.warp(1_800_000_000);
        vm.expectEmit(address(registry));
        emit AgentCompromised(agentId, creatorA, 1_800_000_000);
        vm.prank(creatorA);
        registry.reportCompromise(agentId);
        assertEq(registry.compromisedAt(agentId), 1_800_000_000);
    }

    function test_revertsForAnyoneButTheCreator() public {
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.NotAgentCreator.selector, agentId, creatorB));
        vm.prank(creatorB);
        registry.reportCompromise(agentId);
    }

    function test_revertsForUnlinkedAgent() public {
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.NotAgentCreator.selector, 42, creatorA));
        vm.prank(creatorA);
        registry.reportCompromise(42);
    }

    function test_timeCannotBeMovedByASecondReport() public {
        vm.warp(1_800_000_000);
        vm.prank(creatorA);
        registry.reportCompromise(agentId);

        vm.warp(1_900_000_000);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.AlreadyCompromised.selector, agentId));
        vm.prank(creatorA);
        registry.reportCompromise(agentId);
        assertEq(registry.compromisedAt(agentId), 1_800_000_000);
    }

    function test_creatorCanStillReportAfterTheNftLeft() public {
        identity.transfer(agentId, creatorB);
        vm.prank(creatorA);
        registry.reportCompromise(agentId);
        assertGt(registry.compromisedAt(agentId), 0);
    }
}

contract IssueCredentialTest is Base {
    bytes internal constant URI = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    function setUp() public override {
        super.setUp();
        _init();
    }

    function test_revertsForNonIssuer() public {
        bytes32 role = registry.ISSUER_ROLE();
        _missingRole(admin, role);
        vm.prank(admin);
        registry.issueCredential(holder, URI);
    }

    function test_revertsBeforeTokenExists() public {
        CreatorRegistry fresh = new CreatorRegistry(address(identity), admin, verifier, issuer);
        vm.expectRevert(CreatorRegistry.CredentialTokenNotInitialized.selector);
        vm.prank(issuer);
        fresh.issueCredential(holder, URI);
    }

    function test_revertsOnEmptyMetadata() public {
        hts.associate(holder);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.InvalidMetadataLength.selector, 0));
        _issue(holder, "");
    }

    function test_revertsOnMetadataOverLimit() public {
        hts.associate(holder);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.InvalidMetadataLength.selector, 101));
        _issue(holder, new bytes(101));
    }

    function test_acceptsMetadataAtLimit() public {
        hts.associate(holder);
        int64 serial = _issue(holder, new bytes(100));
        assertEq(hts.metadataOf(serial).length, 100);
    }

    function testFuzz_metadataLengthRule(uint8 length) public {
        hts.associate(holder);
        if (length == 0 || length > 100) {
            vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.InvalidMetadataLength.selector, length));
        }
        _issue(holder, new bytes(length));
    }

    function test_revertsForZeroHolder() public {
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.InvalidHolder.selector, address(0)));
        _issue(address(0), URI);
    }

    function test_revertsForTheContractItself() public {
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.InvalidHolder.selector, address(registry)));
        _issue(address(registry), URI);
    }

    function test_T1_5_unassociatedHolderWithNoSlotsFails() public {
        _revertsWith(TRANSFER, hts.TOKEN_NOT_ASSOCIATED_TO_ACCOUNT());
        _issue(holder, URI);
        assertEq(hts.totalSupply(), 0, "the mint is undone");
    }

    function test_T1_6_associatedHolderReceivesFrozenCredential() public {
        hts.associate(holder);

        vm.expectEmit(address(registry));
        emit CredentialIssued(holder, 1);
        int64 serial = _issue(holder, URI);

        assertEq(serial, 1);
        assertEq(hts.ownerOf(1), holder);
        assertEq(hts.metadataOf(1), URI);
        assertTrue(_frozen(holder));
        assertEq(hts.balanceOf(address(registry)), 0);
    }

    function test_T1_7_holderCannotMoveTheCredential() public {
        hts.associate(holder);
        hts.associate(walletU);
        int64 serial = _issue(holder, URI);
        address token = registry.credentialToken();

        vm.prank(holder);
        assertEq(hts.transferNFT(token, holder, walletU, serial), hts.ACCOUNT_FROZEN_FOR_TOKEN());
        assertEq(hts.ownerOf(serial), holder);
    }

    function test_T1_8_secondCredentialToFrozenHolder() public {
        hts.associate(holder);
        _issue(holder, URI);
        assertTrue(_frozen(holder));

        int64 second = _issue(holder, URI);

        assertEq(second, 2);
        assertEq(hts.balanceOf(holder), 2);
        assertTrue(_frozen(holder));
    }

    function test_holderWithFreeSlotIsAutoAssociatedThenFrozen() public {
        hts.addAccount(holder, 1);
        assertFalse(_associated(holder));

        int64 serial = _issue(holder, URI);

        assertEq(hts.ownerOf(serial), holder);
        assertTrue(_associated(holder));
        assertTrue(_frozen(holder));
    }

    function test_holderWithUnlimitedSlotsIsAutoAssociatedThenFrozen() public {
        hts.addAccount(holder, hts.UNLIMITED_ASSOCIATIONS());
        _issue(holder, URI);
        assertTrue(_frozen(holder));

        _issue(holder, URI);
        assertEq(hts.balanceOf(holder), 2);
        assertTrue(_frozen(holder));
    }

    function test_holderWithAllSlotsUsedFails() public {
        hts.addAccount(holder, 1);
        hts.setUsedAutoAssociations(holder, 1);

        _revertsWith(TRANSFER, hts.NO_REMAINING_AUTOMATIC_ASSOCIATIONS());
        _issue(holder, URI);
        assertEq(hts.totalSupply(), 0);
    }

    /// The real code is unobserved. What matters is that a refused delivery undoes the mint.
    function test_receiverSigRequiredHolderFailsAndLeavesNoMint() public {
        hts.addAccount(holder, hts.UNLIMITED_ASSOCIATIONS());
        hts.setReceiverSigRequired(holder, true);

        _revertsWith(TRANSFER, hts.INVALID_FULL_PREFIX_SIGNATURE_FOR_PRECOMPILE());
        _issue(holder, URI);
        assertEq(hts.totalSupply(), 0);
        assertFalse(_associated(holder));
    }

    /// Unfreeze has already run when the delivery is refused, the same shape as the failed revoke.
    function test_receiverSigRequiredFrozenHolderStaysFrozen() public {
        hts.associate(holder);
        _issue(holder, URI);
        hts.setReceiverSigRequired(holder, true);

        _revertsWith(TRANSFER, hts.INVALID_FULL_PREFIX_SIGNATURE_FOR_PRECOMPILE());
        _issue(holder, URI);
        assertTrue(_frozen(holder));
        assertEq(hts.balanceOf(holder), 1);
        assertEq(hts.totalSupply(), 1);
    }

    function test_addressWithNoAccountFails() public {
        _revertsWith(IS_FROZEN, hts.INVALID_ACCOUNT_ID());
        _issue(makeAddr("no account"), URI);
    }

    function test_revertsOnEverySystemCallFailure_freshHolder() public {
        hts.associate(holder);
        bytes4[3] memory steps = [IS_FROZEN, MINT, FREEZE];
        for (uint256 i = 0; i < steps.length; ++i) {
            uint256 snapshot = vm.snapshot();
            hts.forceCode(steps[i], 21);
            _revertsWith(steps[i], 21);
            _issue(holder, URI);
            assertEq(hts.totalSupply(), 0);
            assertEq(hts.balanceOf(holder), 0);
            vm.revertTo(snapshot);
        }
    }

    function test_revertsWhenTransferFails() public {
        hts.associate(holder);
        hts.forceCode(TRANSFER, 21);
        _revertsWith(TRANSFER, 21);
        _issue(holder, URI);
        assertEq(hts.totalSupply(), 0);
    }

    /// The case that matters most: the holder is unfrozen mid-call, and any later failure must not
    /// leave it that way, or the credential it already holds becomes transferable.
    function test_failureAfterUnfreezeLeavesHolderFrozen() public {
        hts.associate(holder);
        _issue(holder, URI);

        bytes4[2] memory steps = [TRANSFER, FREEZE];
        for (uint256 i = 0; i < steps.length; ++i) {
            uint256 snapshot = vm.snapshot();
            hts.forceCode(steps[i], 21);
            _revertsWith(steps[i], 21);
            _issue(holder, URI);
            assertTrue(_frozen(holder));
            assertEq(hts.balanceOf(holder), 1);
            assertEq(hts.totalSupply(), 1);
            vm.revertTo(snapshot);
        }
    }

    function test_unfreezeFailureReverts() public {
        hts.associate(holder);
        _issue(holder, URI);
        hts.forceCode(UNFREEZE, 21);
        _revertsWith(UNFREEZE, 21);
        _issue(holder, URI);
        assertEq(hts.totalSupply(), 1);
    }

    function test_systemContractRevertIsNotSwallowed() public {
        hts.associate(holder);
        hts.forceRevert(TRANSFER);
        vm.expectRevert(abi.encodeWithSelector(Hts.HtsCallReverted.selector, TRANSFER, bytes("INVALID_TRANSACTION_BODY")));
        _issue(holder, URI);
        assertEq(hts.totalSupply(), 0);
    }
}

contract RevokeCredentialTest is Base {
    int64 internal first;
    int64 internal second;

    function setUp() public override {
        super.setUp();
        _init();
        hts.associate(holder);
        first = _issue(holder, "ipfs://one");
        second = _issue(holder, "ipfs://two");
    }

    function test_T1_9_wipesSerialAndKeepsTheRestFrozen() public {
        vm.expectEmit(address(registry));
        emit CredentialRevoked(holder, first);
        vm.prank(issuer);
        registry.revokeCredential(holder, first);

        assertEq(hts.ownerOf(first), address(0));
        assertEq(hts.ownerOf(second), holder);
        assertEq(hts.balanceOf(holder), 1);
        assertEq(hts.totalSupply(), 1);
        assertTrue(_frozen(holder));
    }

    function test_holderCanBeIssuedAgainAfterLosingEverything() public {
        vm.startPrank(issuer);
        registry.revokeCredential(holder, first);
        registry.revokeCredential(holder, second);
        vm.stopPrank();
        assertEq(hts.balanceOf(holder), 0);
        assertTrue(_frozen(holder));

        int64 third = _issue(holder, "ipfs://three");
        assertEq(hts.ownerOf(third), holder);
        assertTrue(_frozen(holder));
    }

    function test_revertsForNonIssuer() public {
        bytes32 role = registry.ISSUER_ROLE();
        _missingRole(verifier, role);
        vm.prank(verifier);
        registry.revokeCredential(holder, first);
    }

    function test_revertsBeforeTokenExists() public {
        CreatorRegistry fresh = new CreatorRegistry(address(identity), admin, verifier, issuer);
        vm.expectRevert(CreatorRegistry.CredentialTokenNotInitialized.selector);
        vm.prank(issuer);
        fresh.revokeCredential(holder, first);
    }

    function test_revertsWhenHolderDoesNotOwnTheSerial() public {
        hts.associate(walletU);
        int64 other = _issue(walletU, "ipfs://other");

        _revertsWith(WIPE, hts.ACCOUNT_DOES_NOT_OWN_WIPED_NFT());
        vm.prank(issuer);
        registry.revokeCredential(holder, other);

        assertTrue(_frozen(holder));
        assertEq(hts.ownerOf(other), walletU);
    }

    function test_revertsForUnknownSerial() public {
        _revertsWith(WIPE, hts.INVALID_NFT_ID());
        vm.prank(issuer);
        registry.revokeCredential(holder, 99);
    }

    function test_revertsForUnassociatedHolder() public {
        _revertsWith(WIPE, hts.TOKEN_NOT_ASSOCIATED_TO_ACCOUNT());
        vm.prank(issuer);
        registry.revokeCredential(walletU, first);
    }

    function test_revertsForTheTreasury() public {
        _revertsWith(WIPE, hts.CANNOT_WIPE_TOKEN_TREASURY_ACCOUNT());
        vm.prank(issuer);
        registry.revokeCredential(address(registry), first);
    }

    function test_failureAtAnyStepLeavesHolderFrozenWithCredential() public {
        bytes4[4] memory steps = [IS_FROZEN, UNFREEZE, WIPE, FREEZE];
        for (uint256 i = 0; i < steps.length; ++i) {
            uint256 snapshot = vm.snapshot();
            hts.forceCode(steps[i], 21);
            _revertsWith(steps[i], 21);
            vm.prank(issuer);
            registry.revokeCredential(holder, first);
            assertTrue(_frozen(holder));
            assertEq(hts.ownerOf(first), holder);
            vm.revertTo(snapshot);
        }
    }
}

/// Regular EVM rollback only. The same path on Hedera is T1.9b, in script/check-rollback.sh.
contract RollbackProbeTest is Base {
    event Caught(bytes reason);

    RollbackProbe internal probe;
    int64 internal serial;

    function setUp() public override {
        super.setUp();
        _init();
        hts.associate(holder);
        serial = _issue(holder, "ipfs://one");

        probe = new RollbackProbe();
        bytes32 role = registry.ISSUER_ROLE();
        vm.prank(admin);
        registry.grantRole(role, address(probe));
    }

    function test_T1_9b_caughtFailureLeavesHolderFrozenWithCredential() public {
        vm.expectEmit(address(probe));
        emit Caught(abi.encodeWithSelector(Hts.HtsCallFailed.selector, WIPE, hts.INVALID_NFT_ID()));
        probe.revokeAndCatch(registry, holder, serial + 1000);

        assertTrue(_frozen(holder));
        assertEq(hts.ownerOf(serial), holder);
        assertEq(hts.balanceOf(holder), 1);
        assertEq(hts.totalSupply(), 1);
    }

    function test_T1_9b_topLevelFailureLeavesHolderFrozenWithCredential() public {
        _revertsWith(WIPE, hts.INVALID_NFT_ID());
        vm.prank(issuer);
        registry.revokeCredential(holder, serial + 1000);

        assertTrue(_frozen(holder));
        assertEq(hts.balanceOf(holder), 1);
    }

    /// A revoke that went through would make the check meaningless, so the probe refuses to pass.
    function test_probeRevertsIfTheRevokeSucceeds() public {
        vm.expectRevert(RollbackProbe.ExpectedFailure.selector);
        probe.revokeAndCatch(registry, holder, serial);
        assertEq(hts.balanceOf(holder), 1);
    }
}

contract SyncAgentWalletTest is Base {
    uint256 internal agentId;
    address internal rotated = makeAddr("rotated");

    function setUp() public override {
        super.setUp();
        _init();
        _register(N1, creatorA);
        _register(N2, creatorB);
        hts.addAccount(rotated, 0);
        hts.associate(rotated);
        agentId = identity.register(creatorA);
        identity.setAgentWallet(agentId, agentWallet);
        hts.associate(agentWallet);
        vm.prank(creatorA);
        registry.linkAgent(agentId);
    }

    function _sync() internal {
        vm.prank(creatorA);
        registry.syncAgentWallet(agentId);
    }

    function test_rotatedWalletBecomesBackedAndGetsAFrozenCredential() public {
        identity.setAgentWallet(agentId, rotated);
        assertFalse(registry.isHumanBacked(rotated));

        vm.expectEmit(address(registry));
        emit CredentialIssued(rotated, 2);
        vm.expectEmit(address(registry));
        emit AgentWalletSynced(agentId, creatorA, rotated, 2);
        _sync();

        assertTrue(registry.isHumanBacked(rotated));
        assertFalse(registry.isHumanBacked(agentWallet), "the old wallet stays dropped");
        assertEq(hts.ownerOf(2), rotated);
        assertEq(hts.metadataOf(2), bytes("reputed:human-backed:0"));
        assertTrue(_frozen(rotated));
    }

    function test_creatorOfAndAgentListDoNotChange() public {
        identity.setAgentWallet(agentId, rotated);
        _sync();
        assertEq(registry.creatorOf(agentId), creatorA);
        assertEq(registry.agentsOf(creatorA).length, 1);
    }

    function test_rotatingOnDropsTheSyncedWallet() public {
        identity.setAgentWallet(agentId, rotated);
        _sync();
        identity.setAgentWallet(agentId, walletU);
        assertFalse(registry.isHumanBacked(rotated));
    }

    function test_syncedWalletLosesBackingWhenTheNftIsSold() public {
        identity.setAgentWallet(agentId, rotated);
        _sync();
        identity.transfer(agentId, creatorB);
        identity.setAgentWallet(agentId, rotated);
        assertFalse(registry.isHumanBacked(rotated));
    }

    function test_revertsForAnyoneButTheCreator() public {
        identity.setAgentWallet(agentId, rotated);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.NotAgentCreator.selector, agentId, creatorB));
        vm.prank(creatorB);
        registry.syncAgentWallet(agentId);
    }

    function test_revertsForUnlinkedAgent() public {
        uint256 unlinked = identity.register(creatorA);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.NotAgentCreator.selector, unlinked, creatorA));
        vm.prank(creatorA);
        registry.syncAgentWallet(unlinked);
    }

    /// The buyer controls which wallet the agent points at, so the creator must not vouch for it.
    function test_revertsAfterTheNftLeftTheCreator() public {
        identity.transfer(agentId, creatorB);
        identity.setAgentWallet(agentId, rotated);

        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.NotAgentOwner.selector, agentId, creatorA));
        _sync();
        assertFalse(registry.isHumanBacked(rotated));
    }

    function test_revertsOnACompromisedAgent() public {
        vm.prank(creatorA);
        registry.reportCompromise(agentId);
        identity.setAgentWallet(agentId, rotated);

        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.AlreadyCompromised.selector, agentId));
        _sync();
        assertFalse(registry.isHumanBacked(rotated));
    }

    function test_revertsWhenTheWalletIsClear() public {
        identity.setAgentWallet(agentId, address(0));
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.AgentWalletNotSet.selector, agentId));
        _sync();
    }

    function test_revertsWhenNothingRotated() public {
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.WalletAlreadyLinked.selector, agentId, agentWallet));
        _sync();
    }

    /// Rotating back needs no sync, and a second sync must not mint a second credential.
    function test_revertsOnAWalletAlreadySynced() public {
        identity.setAgentWallet(agentId, rotated);
        _sync();
        identity.setAgentWallet(agentId, agentWallet);
        assertTrue(registry.isHumanBacked(agentWallet));

        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.WalletAlreadyLinked.selector, agentId, agentWallet));
        _sync();
        assertEq(hts.totalSupply(), 2);
    }

    /// Same as T3.6: the wallet associates and the creator retries.
    function test_unassociatedWalletRevertsAndCanBeRetried() public {
        identity.setAgentWallet(agentId, holder);

        _revertsWith(TRANSFER, hts.TOKEN_NOT_ASSOCIATED_TO_ACCOUNT());
        _sync();
        assertFalse(registry.isHumanBacked(holder));

        hts.associate(holder);
        _sync();
        assertTrue(registry.isHumanBacked(holder));
    }
}

/// What the credential does and does not track. The issuer job in the README depends on all of this.
contract StaleCredentialTest is Base {
    uint256 internal agentId;
    int64 internal serial = 1;
    address internal rotated = makeAddr("rotated");

    function setUp() public override {
        super.setUp();
        _init();
        _register(N1, creatorA);
        _register(N2, creatorB);
        hts.addAccount(rotated, 0);
        hts.associate(rotated);
        agentId = identity.register(creatorA);
        identity.setAgentWallet(agentId, agentWallet);
        hts.associate(agentWallet);
        vm.prank(creatorA);
        registry.linkAgent(agentId);
    }

    function _revokeAndCheck() internal {
        assertEq(hts.ownerOf(serial), agentWallet, "the credential outlives the backing");
        assertFalse(registry.isHumanBacked(agentWallet), "isHumanBacked is the authority");

        vm.prank(issuer);
        registry.revokeCredential(agentWallet, serial);

        assertEq(hts.ownerOf(serial), address(0));
        assertEq(hts.balanceOf(agentWallet), 0);
        assertTrue(_frozen(agentWallet));
    }

    function test_issuerCanRevokeAfterTheAgentIsSold() public {
        identity.transfer(agentId, creatorB);
        _revokeAndCheck();
    }

    function test_issuerCanRevokeAfterRotation() public {
        identity.setAgentWallet(agentId, rotated);
        vm.prank(creatorA);
        registry.syncAgentWallet(agentId);
        _revokeAndCheck();
        assertEq(hts.balanceOf(rotated), 1, "the synced wallet keeps its own credential");
    }

    function test_issuerCanRevokeAfterACompromiseReport() public {
        vm.prank(creatorA);
        registry.reportCompromise(agentId);
        assertEq(identity.getAgentWallet(agentId), agentWallet, "the wallet slot still names the holder");
        _revokeAndCheck();
    }
}

contract IsHumanBackedTest is Base {
    uint256 internal agentId;
    address internal rotated = makeAddr("rotated");

    function setUp() public override {
        super.setUp();
        _init();
        _register(N1, creatorA);
        _register(N2, creatorB);
        agentId = identity.register(creatorA);
        identity.setAgentWallet(agentId, agentWallet);
        hts.associate(agentWallet);
        vm.prank(creatorA);
        registry.linkAgent(agentId);
    }

    function test_trueForCreatorsAndLinkedAgentWallets() public view {
        assertTrue(registry.isHumanBacked(creatorA));
        assertTrue(registry.isHumanBacked(agentWallet));
    }

    function test_falseForUnknownAndZero() public view {
        assertFalse(registry.isHumanBacked(walletU));
        assertFalse(registry.isHumanBacked(address(0)));
    }

    function test_falseBeforeLinking() public {
        uint256 id = identity.register(creatorA);
        identity.setAgentWallet(id, walletU);
        assertFalse(registry.isHumanBacked(walletU));
    }

    function test_rotatingTheWalletDropsTheOldOne() public {
        identity.setAgentWallet(agentId, rotated);
        assertFalse(registry.isHumanBacked(agentWallet));
    }

    /// Fail closed until the creator calls syncAgentWallet. See SyncAgentWalletTest.
    function test_rotatedInWalletIsNotBacked() public {
        identity.setAgentWallet(agentId, rotated);
        assertFalse(registry.isHumanBacked(rotated));
    }

    function test_rotatingBackRestoresTheWallet() public {
        identity.setAgentWallet(agentId, rotated);
        identity.setAgentWallet(agentId, agentWallet);
        assertTrue(registry.isHumanBacked(agentWallet));
    }

    function test_clearedWalletIsNotBacked() public {
        identity.setAgentWallet(agentId, address(0));
        assertFalse(registry.isHumanBacked(agentWallet));
    }

    function test_T3_8_transferringTheNftEndsBacking() public {
        identity.transfer(agentId, creatorB);
        assertEq(identity.getAgentWallet(agentId), address(0));
        assertFalse(registry.isHumanBacked(agentWallet));
    }

    /// The buyer controls the NFT now. Pointing it back at the old wallet must not restore the
    /// original creator's backing, which is exactly the stale mapping case.
    function test_newOwnerRestoringTheOldWalletStaysUnbacked() public {
        identity.transfer(agentId, walletU);
        identity.setAgentWallet(agentId, agentWallet);
        assertFalse(registry.isHumanBacked(agentWallet));
    }

    function test_nftReturningToTheCreatorRestoresBacking() public {
        identity.transfer(agentId, walletU);
        identity.transfer(agentId, creatorA);
        assertFalse(registry.isHumanBacked(agentWallet), "wallet was cleared by the transfers");

        identity.setAgentWallet(agentId, agentWallet);
        assertTrue(registry.isHumanBacked(agentWallet));
    }

    function test_compromisedAgentWalletIsNotBacked() public {
        vm.prank(creatorA);
        registry.reportCompromise(agentId);
        assertFalse(registry.isHumanBacked(agentWallet));
    }

    function test_creatorStaysBackedWhenTheirAgentIsCompromised() public {
        vm.prank(creatorA);
        registry.reportCompromise(agentId);
        assertTrue(registry.isHumanBacked(creatorA));
    }

    /// The plan's default flow, where the agent wallet is the creator's address. The report gives no
    /// wallet-level protection here, because a creator wallet has no way to register again.
    function test_defaultWalletAgentReportLeavesTheCreatorBacked() public {
        uint256 second = identity.register(creatorA);
        hts.associate(creatorA);
        vm.startPrank(creatorA);
        registry.linkAgent(second);
        registry.reportCompromise(second);
        vm.stopPrank();
        assertEq(identity.getAgentWallet(second), creatorA);
        assertTrue(registry.isHumanBacked(creatorA));
    }

    /// A report says the key is untrusted, and the key is the same for every agent on the wallet.
    function test_reportOnOneAgentVoidsASharedWallet() public {
        uint256 second = identity.register(creatorA);
        identity.setAgentWallet(second, agentWallet);
        vm.prank(creatorA);
        registry.linkAgent(second);
        assertTrue(registry.isHumanBacked(agentWallet));

        vm.prank(creatorA);
        registry.reportCompromise(agentId);
        assertFalse(registry.isHumanBacked(agentWallet));
    }

    function test_reportVoidsASharedWalletWhicheverAgentIsReported() public {
        uint256 second = identity.register(creatorA);
        identity.setAgentWallet(second, agentWallet);
        vm.startPrank(creatorA);
        registry.linkAgent(second);
        registry.reportCompromise(second);
        vm.stopPrank();
        assertFalse(registry.isHumanBacked(agentWallet));
    }

    /// Fails closed: the report cannot say which of the agent's wallets it means.
    function test_reportVoidsEveryWalletTheAgentWasLinkedTo() public {
        hts.addAccount(rotated, 0);
        hts.associate(rotated);
        uint256 second = identity.register(creatorA);
        identity.setAgentWallet(second, agentWallet);
        identity.setAgentWallet(agentId, rotated);
        vm.startPrank(creatorA);
        registry.linkAgent(second);
        registry.syncAgentWallet(agentId);
        assertTrue(registry.isHumanBacked(agentWallet), "second agent still answers to it");
        assertTrue(registry.isHumanBacked(rotated));

        registry.reportCompromise(agentId);
        vm.stopPrank();
        assertFalse(registry.isHumanBacked(rotated));
        assertFalse(registry.isHumanBacked(agentWallet));
    }

    function test_creatorWalletStaysBackedAfterSellingAgent() public {
        identity.transfer(agentId, creatorB);
        assertTrue(registry.isHumanBacked(creatorA));
    }

    function test_walletSharedByTwoAgentsNeedsOnlyOneValidLink() public {
        uint256 second = identity.register(creatorA);
        identity.setAgentWallet(second, agentWallet);
        vm.prank(creatorA);
        registry.linkAgent(second);

        identity.transfer(agentId, creatorB);
        assertTrue(registry.isHumanBacked(agentWallet));

        identity.transfer(second, creatorB);
        assertFalse(registry.isHumanBacked(agentWallet));
    }

    function test_failsClosedWithoutRevertingWhenIdentityRegistryFails() public {
        identity.setBroken(true);
        assertFalse(registry.isHumanBacked(agentWallet));
        assertTrue(registry.isHumanBacked(creatorA));
    }

    function test_revokingACredentialDoesNotChangeBacking() public {
        vm.prank(issuer);
        registry.revokeCredential(agentWallet, 1);
        assertTrue(registry.isHumanBacked(agentWallet));
    }
}

contract InterfaceTest is Base {
    function test_contractImplementsTheFixedInterface() public view {
        ICreatorRegistry fixedInterface = ICreatorRegistry(address(registry));
        assertEq(fixedInterface.identityRegistry(), address(identity));
        assertEq(fixedInterface.credentialToken(), address(0));
        assertEq(fixedInterface.creatorOf(1), address(0));
        assertEq(fixedInterface.compromisedAt(1), 0);
        assertEq(fixedInterface.agentsOf(creatorA).length, 0);
        assertFalse(fixedInterface.isCreator(creatorA));
        assertEq(fixedInterface.walletOfNullifier(N1), address(0));
    }
}
