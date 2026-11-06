// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

import {CreatorRegistry} from "../src/CreatorRegistry.sol";
import {Base} from "./CreatorRegistry.t.sol";

/// Grants let a creator's API key link agents that the agents' own accounts own. See CreatorRegistry.
contract LinkWithGrantTest is Base {
    event GrantAuthorized(address indexed creator, address indexed grantKey, uint64 expiresAt, uint32 maxAgents);
    event GrantRevoked(address indexed creator, address indexed grantKey);
    event AgentLinkedByGrant(uint256 indexed agentId, address indexed creator, address indexed grantKey, address owner);

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    address internal grantKey;
    uint256 internal grantPk;
    address internal agentOwner = makeAddr("agentOwner");
    uint256 internal agentId;
    uint64 internal expiresAt;

    function setUp() public override {
        super.setUp();
        _init();
        _register(N1, creatorA);
        _register(N2, creatorB);
        (grantKey, grantPk) = makeAddrAndKey("grant key");
        expiresAt = uint64(block.timestamp + 90 days);
        hts.addAccount(agentOwner, 0);
        hts.associate(agentOwner);
        agentId = identity.register(agentOwner);
    }

    function _authorize(uint32 maxAgents) internal {
        vm.prank(creatorA);
        registry.authorizeGrant(grantKey, expiresAt, maxAgents);
    }

    function _digest(uint256 id, address owner, uint256 deadline) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("ReputedCreatorRegistry"), keccak256("2"), block.chainid, address(registry))
        );
        bytes32 structHash = keccak256(abi.encode(registry.LINK_GRANT_TYPEHASH(), id, owner, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _sign(uint256 pk, uint256 id, address owner, uint256 deadline) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(id, owner, deadline));
        return abi.encodePacked(r, s, v);
    }

    function _link(uint256 id, address owner) internal {
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sign(grantPk, id, owner, deadline);
        vm.prank(owner);
        registry.linkAgentWithGrant(id, grantKey, deadline, sig);
    }

    // authorizeGrant and revokeGrant

    function test_authorizeStoresTheGrantAndEmits() public {
        vm.expectEmit(address(registry));
        emit GrantAuthorized(creatorA, grantKey, expiresAt, 3);
        _authorize(3);

        (address creator, uint64 expiry, uint32 maxAgents, uint32 used, bool revoked) = registry.grants(grantKey);
        assertEq(creator, creatorA);
        assertEq(expiry, expiresAt);
        assertEq(maxAgents, 3);
        assertEq(used, 0);
        assertFalse(revoked);
    }

    function test_authorizeRevertsForNonCreator() public {
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.NotCreator.selector, agentOwner));
        vm.prank(agentOwner);
        registry.authorizeGrant(grantKey, expiresAt, 1);
    }

    function test_authorizeRejectsBadInput() public {
        vm.startPrank(creatorA);
        vm.expectRevert(CreatorRegistry.InvalidGrant.selector);
        registry.authorizeGrant(address(0), expiresAt, 1);
        vm.expectRevert(CreatorRegistry.InvalidGrant.selector);
        registry.authorizeGrant(grantKey, expiresAt, 0);
        vm.expectRevert(CreatorRegistry.InvalidGrant.selector);
        registry.authorizeGrant(grantKey, uint64(block.timestamp), 1);
        vm.stopPrank();
    }

    function test_aKeyBelongsToOneCreatorForGood() public {
        _authorize(1);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.GrantKeyTaken.selector, grantKey));
        vm.prank(creatorB);
        registry.authorizeGrant(grantKey, expiresAt, 1);

        vm.prank(creatorA);
        registry.revokeGrant(grantKey);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.GrantKeyTaken.selector, grantKey));
        vm.prank(creatorB);
        registry.authorizeGrant(grantKey, expiresAt, 1);
    }

    function test_onlyTheGrantsCreatorCanRevoke() public {
        _authorize(1);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.GrantNotFound.selector, grantKey));
        vm.prank(creatorB);
        registry.revokeGrant(grantKey);

        vm.expectEmit(address(registry));
        emit GrantRevoked(creatorA, grantKey);
        vm.prank(creatorA);
        registry.revokeGrant(grantKey);
        (,,,, bool revoked) = registry.grants(grantKey);
        assertTrue(revoked);
    }

    // linkAgentWithGrant

    function test_linksAnAgentTheCreatorDoesNotOwn() public {
        _authorize(2);

        vm.expectEmit(address(registry));
        emit AgentLinked(agentId, creatorA, agentOwner, 1);
        vm.expectEmit(address(registry));
        emit AgentLinkedByGrant(agentId, creatorA, grantKey, agentOwner);
        _link(agentId, agentOwner);

        assertEq(registry.creatorOf(agentId), creatorA);
        assertEq(registry.linkedOwner(agentId), agentOwner);
        assertEq(hts.ownerOf(1), agentOwner);
        assertTrue(_frozen(agentOwner));
        assertTrue(registry.isHumanBacked(agentOwner));
        assertFalse(registry.isHumanBacked(makeAddr("nobody")));

        uint256[] memory agents = registry.agentsOf(creatorA);
        assertEq(agents.length, 1);
        assertEq(agents[0], agentId);
        (,,, uint32 used,) = registry.grants(grantKey);
        assertEq(used, 1);
    }

    function test_wrongSignerIsRefused() public {
        _authorize(1);
        (, uint256 otherPk) = makeAddrAndKey("someone else");
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sign(otherPk, agentId, agentOwner, deadline);
        vm.expectRevert(CreatorRegistry.BadGrantSignature.selector);
        vm.prank(agentOwner);
        registry.linkAgentWithGrant(agentId, grantKey, deadline, sig);
    }

    function test_garbageSignatureIsRefused() public {
        _authorize(1);
        vm.expectRevert(CreatorRegistry.BadGrantSignature.selector);
        vm.prank(agentOwner);
        registry.linkAgentWithGrant(agentId, grantKey, block.timestamp + 1, hex"1234");
    }

    function test_signatureNamesOneAgentAndOneOwner() public {
        _authorize(2);
        uint256 other = identity.register(agentOwner);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sign(grantPk, agentId, agentOwner, deadline);

        // Same signature, other agent.
        vm.expectRevert(CreatorRegistry.BadGrantSignature.selector);
        vm.prank(agentOwner);
        registry.linkAgentWithGrant(other, grantKey, deadline, sig);

        // Same signature, other caller: the caller is part of what was signed.
        address thief = makeAddr("thief");
        vm.expectRevert(CreatorRegistry.BadGrantSignature.selector);
        vm.prank(thief);
        registry.linkAgentWithGrant(agentId, grantKey, deadline, sig);
    }

    function test_callerMustOwnTheAgent() public {
        _authorize(1);
        address stranger = makeAddr("stranger");
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sign(grantPk, agentId, stranger, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.NotAgentOwner.selector, agentId, stranger));
        vm.prank(stranger);
        registry.linkAgentWithGrant(agentId, grantKey, deadline, sig);
    }

    function test_deadlinePassed() public {
        _authorize(1);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sign(grantPk, agentId, agentOwner, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.GrantDeadlinePassed.selector, deadline));
        vm.prank(agentOwner);
        registry.linkAgentWithGrant(agentId, grantKey, deadline, sig);
    }

    function test_expiredGrant() public {
        _authorize(1);
        uint256 deadline = block.timestamp + 100 days;
        bytes memory sig = _sign(grantPk, agentId, agentOwner, deadline);
        vm.warp(uint256(expiresAt) + 1);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.GrantExpired.selector, grantKey));
        vm.prank(agentOwner);
        registry.linkAgentWithGrant(agentId, grantKey, deadline, sig);
    }

    function test_revokedGrant() public {
        _authorize(1);
        vm.prank(creatorA);
        registry.revokeGrant(grantKey);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sign(grantPk, agentId, agentOwner, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.GrantIsRevoked.selector, grantKey));
        vm.prank(agentOwner);
        registry.linkAgentWithGrant(agentId, grantKey, deadline, sig);
    }

    function test_unknownGrant() public {
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sign(grantPk, agentId, agentOwner, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.GrantNotFound.selector, grantKey));
        vm.prank(agentOwner);
        registry.linkAgentWithGrant(agentId, grantKey, deadline, sig);
    }

    function test_exhaustedGrant() public {
        _authorize(1);
        _link(agentId, agentOwner);

        address second = makeAddr("second owner");
        hts.addAccount(second, 0);
        uint256 secondAgent = identity.register(second);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sign(grantPk, secondAgent, second, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.GrantExhausted.selector, grantKey));
        vm.prank(second);
        registry.linkAgentWithGrant(secondAgent, grantKey, deadline, sig);
    }

    function test_cannotLinkTwice() public {
        _authorize(2);
        _link(agentId, agentOwner);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sign(grantPk, agentId, agentOwner, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.AlreadyLinked.selector, agentId));
        vm.prank(agentOwner);
        registry.linkAgentWithGrant(agentId, grantKey, deadline, sig);
    }

    function test_cannotLinkAnAgentTheCreatorAlreadyLinked() public {
        _authorize(2);
        uint256 own = identity.register(creatorA);
        hts.associate(creatorA);
        vm.prank(creatorA);
        registry.linkAgent(own);
        // The classic link also records its owner.
        assertEq(registry.linkedOwner(own), creatorA);

        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sign(grantPk, own, creatorA, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.AlreadyLinked.selector, own));
        vm.prank(creatorA);
        registry.linkAgentWithGrant(own, grantKey, deadline, sig);
    }

    function test_agentWithoutAWalletIsRefused() public {
        _authorize(1);
        identity.setAgentWallet(agentId, address(0));
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sign(grantPk, agentId, agentOwner, deadline);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.AgentWalletNotSet.selector, agentId));
        vm.prank(agentOwner);
        registry.linkAgentWithGrant(agentId, grantKey, deadline, sig);
    }

    function test_unassociatedWalletRevertsAndLeavesNoLink() public {
        _authorize(1);
        address bare = makeAddr("bare owner");
        hts.addAccount(bare, 0);
        uint256 bareAgent = identity.register(bare);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = _sign(grantPk, bareAgent, bare, deadline);
        vm.prank(bare);
        vm.expectRevert();
        registry.linkAgentWithGrant(bareAgent, grantKey, deadline, sig);
        assertEq(registry.creatorOf(bareAgent), address(0));
        (,,, uint32 used,) = registry.grants(grantKey);
        assertEq(used, 0);
    }

    // What the link means afterwards

    function test_humanBackedEndsWhenTheNftLeavesTheOwner() public {
        _authorize(1);
        _link(agentId, agentOwner);
        assertTrue(registry.isHumanBacked(agentOwner));

        identity.transfer(agentId, makeAddr("buyer"));
        assertFalse(registry.isHumanBacked(agentOwner));

        // Back to the owner that was linked, and the wallet set again.
        identity.registerAt(agentId, agentOwner);
        assertTrue(registry.isHumanBacked(agentOwner));
    }

    function test_creatorCanReportAnAgentItDoesNotOwn() public {
        _authorize(1);
        _link(agentId, agentOwner);

        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.NotAgentCreator.selector, agentId, creatorB));
        vm.prank(creatorB);
        registry.reportCompromise(agentId);

        vm.prank(creatorA);
        registry.reportCompromise(agentId);
        assertFalse(registry.isHumanBacked(agentOwner));
    }

    function test_revokingAKeyKeepsAgentsItAlreadyLinked() public {
        _authorize(2);
        _link(agentId, agentOwner);
        vm.prank(creatorA);
        registry.revokeGrant(grantKey);
        assertTrue(registry.isHumanBacked(agentOwner));
    }

    function test_syncAgentWalletNeedsTheCreatorToOwnTheNft() public {
        _authorize(1);
        _link(agentId, agentOwner);
        identity.setAgentWallet(agentId, agentWallet);
        hts.associate(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(CreatorRegistry.NotAgentOwner.selector, agentId, creatorA));
        vm.prank(creatorA);
        registry.syncAgentWallet(agentId);
    }
}

/// The same inputs as packages/shared/test/grant.test.ts. If either side changes how LinkGrant is
/// encoded, one of the two tests stops matching its constant and fails.
contract LinkGrantVectorTest is Base {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    address internal constant REGISTRY = 0x1111111111111111111111111111111111111111;
    address internal constant OWNER = 0x2222222222222222222222222222222222222222;
    address internal constant GRANT_KEY = 0xfF5eA34E2eABc2EDC7D271aD969024cF5A7bEe1B;
    bytes32 internal constant DIGEST = 0x0d68a322e28c4d2ce2d2f40f3db915f14ec553846d5817dc880f43d8dff3b3e0;
    bytes internal constant SIGNATURE =
        hex"9f62d720559fbe52333d63c710ebed028756d8d480d53556c97daa15ae33273d3e1a1589cded42ea2a8ff98de1abaa1b0c066b8108c6c80a69b041a81a60426b1b";

    function test_typedDataDigestMatchesTheTypeScriptHelper() public view {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("ReputedCreatorRegistry"), keccak256("2"), uint256(296), REGISTRY)
        );
        bytes32 structHash = keccak256(abi.encode(registry.LINK_GRANT_TYPEHASH(), uint256(7), OWNER, uint256(1800000000)));
        assertEq(keccak256(abi.encodePacked("\x19\x01", domain, structHash)), DIGEST);
    }

    function test_theTypeScriptSignatureRecoversToTheGrantAddress() public pure {
        bytes memory sig = SIGNATURE;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        assertEq(ecrecover(DIGEST, v, r, s), GRANT_KEY);
    }
}
