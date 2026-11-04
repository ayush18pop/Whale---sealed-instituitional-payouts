// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Hub} from "../src/Hub.sol";
import {MainBridge} from "../src/MainBridge.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {TestUSDT} from "../src/TestUSDT.sol";

/// @notice SIMULATION ONLY (never --broadcast). On a fork of the LIVE testnet: switch the real bridge to the
/// Uniswap adapter (as its owner), then run a full claim-and-swap through the real Hub, bridge and pool.
contract SmokeUniswapFork is Script {
    Hub hub;
    MainBridge bridge;
    TestUSDC usdc;
    TestUSDT usdt;
    address payee;
    address relayer;
    Hub.SwapWithdrawal terms;
    bytes32 salt = keccak256("smoke-uniswap");
    uint64 domainBlock;

    function run() external {
        hub = Hub(vm.envAddress("HUB"));
        bridge = MainBridge(vm.envAddress("BRIDGE"));
        usdc = TestUSDC(vm.envAddress("USDC"));
        usdt = TestUSDT(vm.envAddress("USDT"));
        payee = makeAddr("payee");
        relayer = makeAddr("relayer");

        vm.prank(bridge.owner());
        bridge.setSwapAdapter(vm.envAddress("ADAPTER")); // simulated switch, on the fork only
        console2.log("bridge adapter now:", address(bridge.swapAdapter()));

        address funder = makeAddr("funder");
        vm.startPrank(funder);
        usdc.mint(funder, 1_000e6);
        usdc.approve(address(bridge), type(uint256).max);
        bridge.deposit(address(usdc), 1_000e6, makeAddr("treasuryInDomain"));
        vm.stopPrank();

        terms = Hub.SwapWithdrawal({
            payee: payee, tokenIn: address(usdc), tokenOut: address(usdt),
            amountIn: 100e6, minOut: 99e6, maxFee: 100_000, nonce: 0
        });
        bytes32 leaf = hub.swapWithdrawalLeaf(terms, salt);
        domainBlock = hub.lastDomainBlock() + 1;
        _attest(leaf);

        uint256 escrowBefore = usdc.balanceOf(address(bridge));
        vm.prank(relayer);
        hub.claimSwap(domainBlock, terms, salt, new bytes32[](0));

        console2.log("payee tUSDT       :", usdt.balanceOf(payee));
        console2.log("relayer fee (tUSDT):", usdt.balanceOf(relayer));
        console2.log("escrow tUSDC spent :", escrowBefore - usdc.balanceOf(address(bridge)));
        require(usdt.balanceOf(relayer) == 50_000, "relayer fee");
        require(usdt.balanceOf(payee) > 99_800_000 && usdt.balanceOf(payee) < 99_950_000, "payee amount");
        require(escrowBefore - usdc.balanceOf(address(bridge)) == 100e6, "escrow accounting");
        require(usdc.allowance(address(bridge), vm.envAddress("ADAPTER")) == 0, "approval left open");
        console2.log("SMOKE OK through the real Hub + bridge + Uniswap v4 pool (simulated on fork)");
    }

    function _attest(bytes32 msgRoot) internal {
        uint64 monadBlock = uint64(block.number);
        bytes32 stateRoot = keccak256("state");
        bytes32 digest = hub.resultDigest(domainBlock, monadBlock, stateRoot, msgRoot);
        uint256 pk1 = vm.envUint("OPERATOR_PK_1");
        uint256 pk2 = vm.envUint("OPERATOR_PK_2");
        (uint256 lo, uint256 hi) = vm.addr(pk1) < vm.addr(pk2) ? (pk1, pk2) : (pk2, pk1);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(lo, digest);
        sigs[1] = _sign(hi, digest);
        hub.postResult(domainBlock, monadBlock, stateRoot, msgRoot, sigs);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
