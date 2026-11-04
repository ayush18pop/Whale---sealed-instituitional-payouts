// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Hub} from "../src/Hub.sol";
import {MainBridge} from "../src/MainBridge.sol";
import {MockSwap} from "../src/MockSwap.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {TestUSDT} from "../src/TestUSDT.sol";
import {ISwapAdapter} from "../src/interfaces/ISwapAdapter.sol";
import {IMainBridge} from "../src/interfaces/IMainBridge.sol";
import {DomainToken} from "../src/domain/DomainToken.sol";

/// @dev Claims a huge output but delivers nothing. The bridge must trust balances, not return values.
contract LyingAdapter is ISwapAdapter {
    function swapExactIn(address, address, uint256, uint256, address) external pure returns (uint256) {
        return type(uint256).max;
    }
}

contract SwapTest is Test {
    uint256 constant DOMAIN = 7777;
    uint256 constant FEE = 50_000; // 0.05 tUSDT, flat
    uint256 constant AMOUNT_IN = 100e6;
    uint256 constant MIN_OUT = 99e6; // net to the payee, after the relayer fee
    uint256 constant MAX_FEE = 100_000;

    TestUSDC usdc;
    TestUSDT usdt;
    MainBridge bridge;
    MockSwap swap;
    Hub hub;

    uint256 pkA = 0xA11CE;
    uint256 pkB = 0xB0B;

    address payee = makeAddr("payee");
    address otherPayee = makeAddr("otherPayee");
    address relayer = makeAddr("relayer");
    address stranger = makeAddr("stranger");

    Hub.SwapWithdrawal terms;
    bytes32 salt = keccak256("swap-salt");
    bytes32 plainSalt = keccak256("plain-salt");
    bytes32 leafSwap;
    bytes32 leafPlain;
    bytes32 root;

    event ClaimedSwap(
        uint64 indexed domainBlock,
        address indexed payee,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 nonce
    );

    function setUp() public {
        usdc = new TestUSDC();
        usdt = new TestUSDT();
        bridge = new MainBridge();

        address[] memory ops = new address[](2);
        ops[0] = vm.addr(pkA);
        ops[1] = vm.addr(pkB);
        hub = new Hub(IMainBridge(address(bridge)), DOMAIN, ops, 2, hex"04aabb");

        swap = new MockSwap(address(bridge));
        swap.setRate(address(usdc), address(usdt), 1e18); // 1:1, minus the 0.05% pool fee
        usdt.mint(address(swap), 1_000_000e6); // pool liquidity

        bridge.setHub(address(hub));
        bridge.setTokenAllowed(address(usdc), true);
        bridge.setTokenAllowed(address(usdt), true);
        bridge.setSwapAdapter(address(swap));
        bridge.setRelayerFee(FEE);

        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(bridge), type(uint256).max);
        bridge.deposit(address(usdc), 1_000e6, makeAddr("treasuryInDomain"));

        terms = Hub.SwapWithdrawal({
            payee: payee,
            tokenIn: address(usdc),
            tokenOut: address(usdt),
            amountIn: AMOUNT_IN,
            minOut: MIN_OUT,
            maxFee: MAX_FEE,
            nonce: 0
        });
        leafSwap = hub.swapWithdrawalLeaf(terms, salt);
        leafPlain = hub.withdrawalLeaf(otherPayee, address(usdc), 40e6, 0, plainSalt);
        root = _pair(leafSwap, leafPlain);

        vm.roll(100);
        _post(1, root);
    }

    // ------------------------------------------------------------ helpers

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _sigs(bytes32 digest) internal view returns (bytes[] memory out) {
        uint256 lo = vm.addr(pkA) < vm.addr(pkB) ? pkA : pkB;
        uint256 hi = lo == pkA ? pkB : pkA;
        out = new bytes[](2);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lo, digest);
        out[0] = abi.encodePacked(r, s, v);
        (v, r, s) = vm.sign(hi, digest);
        out[1] = abi.encodePacked(r, s, v);
    }

    function _post(uint64 domainBlock, bytes32 msgRoot) internal {
        bytes32 digest = hub.resultDigest(domainBlock, uint64(block.number), bytes32(uint256(1)), msgRoot);
        hub.postResult(domainBlock, uint64(block.number), bytes32(uint256(1)), msgRoot, _sigs(digest));
    }

    function _proofSwap() internal view returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = leafPlain;
    }

    function _proofPlain() internal view returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = leafSwap;
    }

    // ------------------------------------------------------------ FR12: swap pays the payee

    function test_claimSwap_paysNetAmountAndRelayerFee() public {
        vm.expectEmit(true, true, false, true);
        emit ClaimedSwap(1, payee, address(usdc), address(usdt), AMOUNT_IN, 0);
        vm.prank(relayer);
        hub.claimSwap(1, terms, salt, _proofSwap());

        uint256 poolOut = 100e6 - (100e6 * 5) / 10_000; // 99.95 tUSDT after the 0.05% pool fee
        assertEq(usdt.balanceOf(payee), poolOut - FEE, "payee gets output minus relayer fee");
        assertEq(usdt.balanceOf(relayer), FEE, "relayer earns the flat fee");
        assertGe(usdt.balanceOf(payee), MIN_OUT, "payee got at least minOut");
        assertLe(usdt.balanceOf(relayer), MAX_FEE, "fee within the payee's cap");
        assertEq(usdc.balanceOf(payee), 0, "no tUSDC paid out");
        assertTrue(hub.claimed(leafSwap));
    }

    function test_claimSwap_movesEscrowAndLeavesNoApproval() public {
        hub.claimSwap(1, terms, salt, _proofSwap());
        assertEq(usdc.balanceOf(address(bridge)), 1_000e6 - AMOUNT_IN);
        assertEq(usdc.balanceOf(address(swap)), AMOUNT_IN);
        assertEq(usdc.allowance(address(bridge), address(swap)), 0, "approval must not outlive the claim");
        assertEq(usdt.balanceOf(address(bridge)), 0, "bridge keeps no output dust");
    }

    function test_claimSwap_zeroFee() public {
        bridge.setRelayerFee(0);
        vm.prank(relayer);
        hub.claimSwap(1, terms, salt, _proofSwap());
        assertEq(usdt.balanceOf(relayer), 0);
        assertEq(usdt.balanceOf(payee), 99_950_000);
    }

    // ------------------------------------------------------------ FR13: below minOut reverts

    function test_claimSwap_revertsWhenPriceMovesBelowMinOut() public {
        swap.setRate(address(usdc), address(usdt), 0.9e18); // market moved 10%
        vm.expectRevert(MockSwap.Slippage.selector);
        hub.claimSwap(1, terms, salt, _proofSwap());

        assertFalse(hub.claimed(leafSwap), "failed swap must leave the withdrawal claimable");
        assertEq(usdc.balanceOf(address(bridge)), 1_000e6, "escrow untouched");
    }

    // ------------------------------------------------------------ FR14: fallback claim

    function test_fallback_afterFailedSwapPaysOriginalToken() public {
        swap.setRate(address(usdc), address(usdt), 0.9e18);
        vm.expectRevert(MockSwap.Slippage.selector);
        hub.claimSwap(1, terms, salt, _proofSwap());

        vm.prank(payee);
        hub.claimAsInput(1, terms, salt, _proofSwap());
        assertEq(usdc.balanceOf(payee), AMOUNT_IN, "payee gets the original token, full amount");
        assertEq(usdt.balanceOf(payee), 0);
    }

    function test_fallback_onlyThePayee() public {
        vm.prank(stranger);
        vm.expectRevert(Hub.NotPayee.selector);
        hub.claimAsInput(1, terms, salt, _proofSwap());
        vm.prank(relayer);
        vm.expectRevert(Hub.NotPayee.selector);
        hub.claimAsInput(1, terms, salt, _proofSwap());
    }

    function test_swapAndFallbackCannotBothPay() public {
        hub.claimSwap(1, terms, salt, _proofSwap());
        vm.prank(payee);
        vm.expectRevert(Hub.AlreadyClaimed.selector);
        hub.claimAsInput(1, terms, salt, _proofSwap());
    }

    function test_fallbackThenSwapCannotBothPay() public {
        vm.prank(payee);
        hub.claimAsInput(1, terms, salt, _proofSwap());
        vm.expectRevert(Hub.AlreadyClaimed.selector);
        hub.claimSwap(1, terms, salt, _proofSwap());
    }

    // ------------------------------------------------------------ proof, replay, tampering

    function test_claimSwap_cannotBeReplayed() public {
        hub.claimSwap(1, terms, salt, _proofSwap());
        vm.expectRevert(Hub.AlreadyClaimed.selector);
        hub.claimSwap(1, terms, salt, _proofSwap());
    }

    function test_claimSwap_rejectsTamperedTerms() public {
        Hub.SwapWithdrawal memory t = terms;
        t.minOut = 1; // a relayer trying to accept a worse price
        vm.expectRevert(Hub.InvalidProof.selector);
        hub.claimSwap(1, t, salt, _proofSwap());

        t = terms;
        t.maxFee = 10_000_000; // a relayer trying to raise the fee cap
        vm.expectRevert(Hub.InvalidProof.selector);
        hub.claimSwap(1, t, salt, _proofSwap());

        t = terms;
        t.payee = stranger; // redirecting the payout
        vm.expectRevert(Hub.InvalidProof.selector);
        hub.claimSwap(1, t, salt, _proofSwap());

        t = terms;
        t.tokenOut = address(usdc);
        vm.expectRevert(Hub.InvalidProof.selector);
        hub.claimSwap(1, t, salt, _proofSwap());
    }

    function test_claimSwap_requiresPostedBlock() public {
        vm.expectRevert(Hub.NotPosted.selector);
        hub.claimSwap(2, terms, salt, _proofSwap());
    }

    function test_leafKindsAreDistinctAndMixedTreesWork() public {
        assertTrue(leafSwap != leafPlain);
        // the plain (kind 1) leaf in the same tree still claims through the original path
        hub.claim(1, otherPayee, address(usdc), 40e6, 0, plainSalt, _proofPlain());
        assertEq(usdc.balanceOf(otherPayee), 40e6);
    }

    // ------------------------------------------------------------ bridge-level guards

    function test_claimSwap_revertsWhenFeeExceedsPayeeCap() public {
        bridge.setRelayerFee(MAX_FEE + 1);
        vm.expectRevert(MainBridge.FeeAboveMax.selector);
        hub.claimSwap(1, terms, salt, _proofSwap());
        assertFalse(hub.claimed(leafSwap));
    }

    function test_claimSwap_revertsForDisallowedOutputToken() public {
        bridge.setTokenAllowed(address(usdt), false);
        vm.expectRevert(MainBridge.TokenNotAllowed.selector);
        hub.claimSwap(1, terms, salt, _proofSwap());
    }

    function test_releaseAndSwap_onlyHub() public {
        vm.prank(stranger);
        vm.expectRevert(MainBridge.NotHub.selector);
        bridge.releaseAndSwap(payee, address(usdc), address(usdt), 1e6, 0, MAX_FEE, stranger);
    }

    function test_releaseAndSwap_requiresAdapterAndDistinctTokens() public {
        MainBridge fresh = new MainBridge();
        fresh.setHub(address(this)); // act as the hub
        fresh.setTokenAllowed(address(usdc), true);
        fresh.setTokenAllowed(address(usdt), true);
        vm.expectRevert(MainBridge.NoSwapAdapter.selector);
        fresh.releaseAndSwap(payee, address(usdc), address(usdt), 1e6, 0, MAX_FEE, relayer);

        vm.prank(address(hub));
        vm.expectRevert(MainBridge.SameToken.selector);
        bridge.releaseAndSwap(payee, address(usdc), address(usdc), 1e6, 0, MAX_FEE, relayer);
    }

    function test_bridgeTrustsBalancesNotAdapterReturnValue() public {
        bridge.setSwapAdapter(address(new LyingAdapter()));
        vm.expectRevert(MainBridge.OutputBelowMin.selector);
        hub.claimSwap(1, terms, salt, _proofSwap());
        assertEq(usdc.balanceOf(address(bridge)), 1_000e6, "escrow intact after the lie");
    }

    function test_setters_onlyOwner() public {
        vm.startPrank(stranger);
        vm.expectRevert(MainBridge.NotOwner.selector);
        bridge.setSwapAdapter(address(swap));
        vm.expectRevert(MainBridge.NotOwner.selector);
        bridge.setRelayerFee(1);
        vm.stopPrank();
        vm.expectRevert(MainBridge.ZeroAddress.selector);
        bridge.setSwapAdapter(address(0));
    }

    // ------------------------------------------------------------ FR15: MockSwap access

    function test_mockSwap_onlyBridgeMaySwap() public {
        vm.prank(stranger);
        vm.expectRevert(MockSwap.NotBridge.selector);
        swap.swapExactIn(address(usdc), address(usdt), 1e6, 0, stranger);
        vm.expectRevert(MockSwap.NotBridge.selector); // not even the owner
        swap.swapExactIn(address(usdc), address(usdt), 1e6, 0, address(this));
    }

    function test_mockSwap_onlyOwnerSetsRates_andNeedsARate() public {
        vm.prank(stranger);
        vm.expectRevert(MockSwap.NotOwner.selector);
        swap.setRate(address(usdc), address(usdt), 2e18);
        vm.expectRevert(MockSwap.NoRate.selector);
        swap.quote(address(usdt), address(usdc), 1e6); // reverse pair has no rate
        assertEq(swap.quote(address(usdc), address(usdt), 100e6), 99_950_000);
    }
}

contract DomainSwapRequestTest is Test {
    DomainToken token;
    address relayer = makeAddr("relayer");
    address monadUsdc = makeAddr("monadUSDC");
    address monadUsdt = makeAddr("monadUSDT");
    address alice = makeAddr("alice");
    address stranger = makeAddr("stranger");

    event SwapWithdrawalRequested(
        address indexed payee,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 maxFee,
        uint256 nonce
    );

    function setUp() public {
        token = new DomainToken(relayer, monadUsdc);
        vm.prank(relayer);
        token.mintDeposit(1, alice, 1_000e6);
    }

    function test_requestSwapWithdrawal_burnsAndEmitsTerms() public {
        vm.expectEmit(true, false, false, true);
        emit SwapWithdrawalRequested(alice, monadUsdc, monadUsdt, 100e6, 99e6, 100_000, 0);
        vm.prank(alice);
        uint256 nonce = token.requestSwapWithdrawal(100e6, monadUsdt, 99e6, 100_000);

        assertEq(nonce, 0);
        vm.prank(alice);
        assertEq(token.balanceOf(alice), 900e6);
        assertEq(token.totalSupply(), 900e6);
    }

    function test_requestSwapWithdrawal_sharesNonceWithPlainWithdrawals() public {
        vm.startPrank(alice);
        assertEq(token.requestWithdrawal(1e6), 0);
        assertEq(token.requestSwapWithdrawal(1e6, monadUsdt, 0, 0), 1);
        assertEq(token.requestWithdrawal(1e6), 2);
        vm.stopPrank();
    }

    function test_requestSwapWithdrawal_validates() public {
        vm.startPrank(alice);
        vm.expectRevert(DomainToken.ZeroAmount.selector);
        token.requestSwapWithdrawal(0, monadUsdt, 0, 0);
        vm.expectRevert(DomainToken.BadTokenOut.selector);
        token.requestSwapWithdrawal(1e6, address(0), 0, 0);
        vm.expectRevert(DomainToken.BadTokenOut.selector);
        token.requestSwapWithdrawal(1e6, monadUsdc, 0, 0); // same token: use requestWithdrawal
        vm.expectRevert(); // more than the balance
        token.requestSwapWithdrawal(1_000e6 + 1, monadUsdt, 0, 0);
        vm.stopPrank();
    }

    function test_payoutPreference_isPrivate() public {
        vm.prank(alice);
        token.setPayoutPreference(monadUsdt);

        vm.prank(alice);
        assertEq(token.payoutPreference(alice), monadUsdt);
        vm.prank(stranger);
        vm.expectRevert(DomainToken.Denied.selector);
        token.payoutPreference(alice);

        vm.prank(alice);
        token.grantReader(stranger);
        vm.prank(stranger);
        assertEq(token.payoutPreference(alice), monadUsdt);
    }
}
