// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Hub} from "../src/Hub.sol";
import {MainBridge} from "../src/MainBridge.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {IMainBridge} from "../src/interfaces/IMainBridge.sol";

contract HubTest is Test {
    uint256 constant DOMAIN = 7777;
    bytes constant ENC_KEY = hex"04aabbccddeeff";

    TestUSDC usdc;
    MainBridge bridge;
    Hub hub;

    uint256 pkA = 0xA11CE;
    uint256 pkB = 0xB0B;
    uint256 pkC = 0xCA401;
    uint256 pkOutsider = 0xDEAD;

    address[4] payees;
    uint256[4] amounts = [uint256(100e6), 250e6, 75e6, 40e6];
    bytes32[4] salts;
    bytes32[4] leaves;
    bytes32 root;
    bytes32 n0;
    bytes32 n1;

    event Submitted(address indexed courier, uint256 gasLimit, bytes ciphertext);
    event ResultPosted(
        uint64 indexed domainBlock, uint64 monadBlock, bytes32 stateRoot, bytes32 msgRoot
    );
    event Claimed(
        uint64 indexed domainBlock,
        address indexed payee,
        address token,
        uint256 amount,
        uint256 nonce
    );

    function setUp() public {
        usdc = new TestUSDC();
        bridge = new MainBridge();

        address[] memory ops = new address[](3);
        ops[0] = vm.addr(pkA);
        ops[1] = vm.addr(pkB);
        ops[2] = vm.addr(pkC);
        hub = new Hub(IMainBridge(address(bridge)), DOMAIN, ops, 2, ENC_KEY);

        bridge.setHub(address(hub));
        bridge.setTokenAllowed(address(usdc), true);
        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(bridge), type(uint256).max);
        bridge.deposit(address(usdc), 1_000e6, makeAddr("treasuryInDomain"));

        for (uint256 i = 0; i < 4; i++) {
            payees[i] = makeAddr(string.concat("payee", vm.toString(i)));
            salts[i] = keccak256(abi.encode("salt", i));
            leaves[i] = hub.withdrawalLeaf(payees[i], address(usdc), amounts[i], i, salts[i]);
        }
        n0 = _pair(leaves[0], leaves[1]);
        n1 = _pair(leaves[2], leaves[3]);
        root = _pair(n0, n1);

        vm.roll(100);
    }

    // ------------------------------------------------------------ helpers

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Sign `digest` with each key, ordered by ascending signer address.
    function _sigs(uint256[] memory pks, bytes32 digest) internal pure returns (bytes[] memory out) {
        uint256 n = pks.length;
        for (uint256 i = 0; i < n; i++) {
            for (uint256 j = i + 1; j < n; j++) {
                if (vm.addr(pks[j]) < vm.addr(pks[i])) (pks[i], pks[j]) = (pks[j], pks[i]);
            }
        }
        out = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], digest);
            out[i] = abi.encodePacked(r, s, v);
        }
    }

    function _two() internal view returns (uint256[] memory pks) {
        pks = new uint256[](2);
        pks[0] = pkA;
        pks[1] = pkB;
    }

    function _post(uint64 domainBlock, bytes32 stateRoot, bytes32 msgRoot) internal {
        uint64 monadBlock = uint64(block.number);
        bytes32 digest = hub.resultDigest(domainBlock, monadBlock, stateRoot, msgRoot);
        hub.postResult(domainBlock, monadBlock, stateRoot, msgRoot, _sigs(_two(), digest));
    }

    function _proof0() internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = leaves[1];
        p[1] = n1;
    }

    function _proof2() internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = leaves[3];
        p[1] = n0;
    }

    // ------------------------------------------------------------ constructor

    function test_constructor_storesConfig() public view {
        assertEq(hub.threshold(), 2);
        assertEq(hub.domainChainId(), DOMAIN);
        assertEq(hub.operators().length, 3);
        assertTrue(hub.isOperator(vm.addr(pkA)));
        assertFalse(hub.isOperator(vm.addr(pkOutsider)));
        assertEq(hub.operatorEncryptionKey(), ENC_KEY);
    }

    function test_constructor_rejectsBadConfig() public {
        address[] memory ops = new address[](2);
        ops[0] = vm.addr(pkA);
        ops[1] = vm.addr(pkB);
        IMainBridge b = IMainBridge(address(bridge));

        vm.expectRevert(Hub.BadConfig.selector);
        new Hub(b, DOMAIN, ops, 0, ENC_KEY); // zero threshold
        vm.expectRevert(Hub.BadConfig.selector);
        new Hub(b, DOMAIN, ops, 3, ENC_KEY); // threshold > operators
        vm.expectRevert(Hub.BadConfig.selector);
        new Hub(b, DOMAIN, ops, 2, ""); // empty key
        vm.expectRevert(Hub.BadConfig.selector);
        new Hub(IMainBridge(address(0)), DOMAIN, ops, 2, ENC_KEY);

        ops[1] = ops[0];
        vm.expectRevert(Hub.BadConfig.selector);
        new Hub(b, DOMAIN, ops, 2, ENC_KEY); // duplicate operator
        ops[1] = address(0);
        vm.expectRevert(Hub.BadConfig.selector);
        new Hub(b, DOMAIN, ops, 2, ENC_KEY); // zero operator
    }

    // ------------------------------------------------------------ submit

    function test_submit_emitsCiphertext() public {
        bytes memory ct = hex"04a1c9e7";
        vm.expectEmit(true, false, false, true);
        emit Submitted(address(this), 60_000, ct);
        hub.submit(ct, 60_000);
    }

    function test_submit_validatesInputs() public {
        vm.expectRevert(Hub.EmptyCiphertext.selector);
        hub.submit("", 60_000);

        vm.expectRevert(Hub.CiphertextTooLarge.selector);
        hub.submit(new bytes(65_537), 60_000);

        vm.expectRevert(Hub.BadGasLimit.selector);
        hub.submit(hex"01", 0);
        vm.expectRevert(Hub.BadGasLimit.selector);
        hub.submit(hex"01", 30_000_001);
    }

    function test_submit_writesNoStorage() public {
        vm.record();
        hub.submit(hex"0102", 60_000);
        (, bytes32[] memory writes) = vm.accesses(address(hub));
        assertEq(writes.length, 0, "submit must not write storage");
    }

    // ------------------------------------------------------------ postResult

    function test_postResult_acceptsTwoOfThree() public {
        bytes32 stateRoot = keccak256("state1");
        vm.expectEmit(true, false, false, true);
        emit ResultPosted(1, uint64(block.number), stateRoot, root);
        _post(1, stateRoot, root);

        assertEq(hub.lastDomainBlock(), 1);
        assertEq(hub.lastMonadBlock(), uint64(block.number));
        (bytes32 s, bytes32 m, uint64 mb) = hub.results(1);
        assertEq(s, stateRoot);
        assertEq(m, root);
        assertEq(mb, uint64(block.number));
    }

    function test_postResult_acceptsAllThree() public {
        uint256[] memory pks = new uint256[](3);
        pks[0] = pkA;
        pks[1] = pkB;
        pks[2] = pkC;
        bytes32 digest = hub.resultDigest(1, uint64(block.number), bytes32(uint256(1)), root);
        hub.postResult(1, uint64(block.number), bytes32(uint256(1)), root, _sigs(pks, digest));
        assertEq(hub.lastDomainBlock(), 1);
    }

    function test_postResult_mustBeInOrder() public {
        bytes32 digest = hub.resultDigest(2, uint64(block.number), bytes32(0), root);
        bytes[] memory sigs = _sigs(_two(), digest);
        vm.expectRevert(Hub.OutOfOrder.selector);
        hub.postResult(2, uint64(block.number), bytes32(0), root, sigs); // skipped block 1

        _post(1, bytes32(uint256(1)), root);

        // cannot repost block 1 (build the signatures first: expectRevert hits the NEXT call)
        uint64 monadBlock = uint64(block.number);
        digest = hub.resultDigest(1, monadBlock, bytes32(uint256(1)), root);
        sigs = _sigs(_two(), digest);
        vm.expectRevert(Hub.OutOfOrder.selector);
        hub.postResult(1, monadBlock, bytes32(uint256(1)), root, sigs);
    }

    function test_postResult_needsThreshold() public {
        uint256[] memory pks = new uint256[](1);
        pks[0] = pkA;
        bytes32 digest = hub.resultDigest(1, uint64(block.number), bytes32(0), root);
        bytes[] memory sigs = _sigs(pks, digest);
        vm.expectRevert(Hub.NotEnoughSignatures.selector);
        hub.postResult(1, uint64(block.number), bytes32(0), root, sigs);
    }

    function test_postResult_rejectsDuplicateSigner() public {
        uint256[] memory pks = new uint256[](2);
        pks[0] = pkA;
        pks[1] = pkA;
        bytes32 digest = hub.resultDigest(1, uint64(block.number), bytes32(0), root);
        bytes[] memory sigs = _sigs(pks, digest);
        vm.expectRevert(Hub.SignersNotAscending.selector);
        hub.postResult(1, uint64(block.number), bytes32(0), root, sigs);
    }

    function test_postResult_rejectsUnsortedSigners() public {
        bytes32 digest = hub.resultDigest(1, uint64(block.number), bytes32(0), root);
        bytes[] memory sorted = _sigs(_two(), digest);
        bytes[] memory reversed = new bytes[](2);
        reversed[0] = sorted[1];
        reversed[1] = sorted[0];
        vm.expectRevert(Hub.SignersNotAscending.selector);
        hub.postResult(1, uint64(block.number), bytes32(0), root, reversed);
    }

    function test_postResult_rejectsNonOperator() public {
        uint256[] memory pks = new uint256[](2);
        pks[0] = pkA;
        pks[1] = pkOutsider;
        bytes32 digest = hub.resultDigest(1, uint64(block.number), bytes32(0), root);
        bytes[] memory sigs = _sigs(pks, digest);
        vm.expectRevert(Hub.NotOperator.selector);
        hub.postResult(1, uint64(block.number), bytes32(0), root, sigs);
    }

    function test_postResult_signaturesBindTheRoots() public {
        // signed for `root`, submitted with a different message root -> signers recover to garbage
        bytes32 digest = hub.resultDigest(1, uint64(block.number), bytes32(0), root);
        bytes[] memory sigs = _sigs(_two(), digest);
        vm.expectRevert(Hub.NotOperator.selector);
        hub.postResult(1, uint64(block.number), bytes32(0), keccak256("forged"), sigs);
    }

    function test_postResult_monadBlockRules() public {
        bytes32 digest = hub.resultDigest(1, uint64(block.number) + 1, bytes32(0), root);
        bytes[] memory sigs = _sigs(_two(), digest);
        vm.expectRevert(Hub.BadMonadBlock.selector); // in the future
        hub.postResult(1, uint64(block.number) + 1, bytes32(0), root, sigs);

        _post(1, bytes32(uint256(1)), root);
        // next domain block must reference a strictly later Monad block
        digest = hub.resultDigest(2, uint64(block.number), bytes32(0), root);
        sigs = _sigs(_two(), digest);
        vm.expectRevert(Hub.BadMonadBlock.selector);
        hub.postResult(2, uint64(block.number), bytes32(0), root, sigs);
    }

    function test_postResult_signaturesAreChainAndDomainBound() public {
        // a digest computed for another hub address must not validate here
        bytes32 foreign = keccak256(abi.encode(address(0xBEEF), block.chainid, DOMAIN, uint64(1), uint64(block.number), bytes32(0), root));
        bytes32 foreignDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", foreign));
        bytes[] memory sigs = _sigs(_two(), foreignDigest);
        vm.expectRevert(Hub.NotOperator.selector);
        hub.postResult(1, uint64(block.number), bytes32(0), root, sigs);
    }

    // ------------------------------------------------------------ claim

    function test_claim_releasesToPayee() public {
        _post(1, bytes32(uint256(1)), root);

        address relayer = makeAddr("relayer");
        vm.expectEmit(true, true, false, true);
        emit Claimed(1, payees[0], address(usdc), amounts[0], 0);
        vm.prank(relayer);
        hub.claim(1, payees[0], address(usdc), amounts[0], 0, salts[0], _proof0());

        assertEq(usdc.balanceOf(payees[0]), amounts[0]); // funds go to the payee, not the caller
        assertEq(usdc.balanceOf(relayer), 0);
        assertEq(usdc.balanceOf(address(bridge)), 1_000e6 - amounts[0]);
        assertTrue(hub.claimed(leaves[0]));
    }

    function test_claim_otherBranchOfTree() public {
        _post(1, bytes32(uint256(1)), root);
        hub.claim(1, payees[2], address(usdc), amounts[2], 2, salts[2], _proof2());
        assertEq(usdc.balanceOf(payees[2]), amounts[2]);
    }

    function test_claim_cannotBeReplayed() public {
        _post(1, bytes32(uint256(1)), root);
        hub.claim(1, payees[0], address(usdc), amounts[0], 0, salts[0], _proof0());
        vm.expectRevert(Hub.AlreadyClaimed.selector);
        hub.claim(1, payees[0], address(usdc), amounts[0], 0, salts[0], _proof0());
        assertEq(usdc.balanceOf(payees[0]), amounts[0]);
    }

    function test_claim_rejectsTamperedFields() public {
        _post(1, bytes32(uint256(1)), root);
        bytes32[] memory p = _proof0();

        vm.expectRevert(Hub.InvalidProof.selector);
        hub.claim(1, payees[0], address(usdc), amounts[0] + 1, 0, salts[0], p); // bigger amount
        vm.expectRevert(Hub.InvalidProof.selector);
        hub.claim(1, makeAddr("thief"), address(usdc), amounts[0], 0, salts[0], p); // other recipient
        vm.expectRevert(Hub.InvalidProof.selector);
        hub.claim(1, payees[0], address(usdc), amounts[0], 0, keccak256("wrong"), p); // wrong salt
        vm.expectRevert(Hub.InvalidProof.selector);
        hub.claim(1, payees[0], address(usdc), amounts[0], 1, salts[0], p); // wrong nonce
    }

    function test_claim_rejectsProofForAnotherLeaf() public {
        _post(1, bytes32(uint256(1)), root);
        vm.expectRevert(Hub.InvalidProof.selector);
        hub.claim(1, payees[1], address(usdc), amounts[1], 1, salts[1], _proof0()); // proof of leaf 0
    }

    function test_claim_requiresPostedBlock() public {
        vm.expectRevert(Hub.NotPosted.selector);
        hub.claim(1, payees[0], address(usdc), amounts[0], 0, salts[0], _proof0());
    }

    function test_claim_cannotExceedEscrow() public {
        // a root that promises more than the bridge holds must revert at the bridge, not underflow silently
        bytes32 big = hub.withdrawalLeaf(payees[0], address(usdc), 5_000e6, 9, salts[0]);
        bytes32 bigRoot = big; // single-leaf tree: root == leaf, empty proof
        _post(1, bytes32(uint256(1)), bigRoot);
        vm.expectRevert();
        hub.claim(1, payees[0], address(usdc), 5_000e6, 9, salts[0], new bytes32[](0));
    }
}
