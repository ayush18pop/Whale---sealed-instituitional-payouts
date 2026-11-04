// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Hub} from "../src/Hub.sol";
import {MainBridge} from "../src/MainBridge.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {TestUSDT} from "../src/TestUSDT.sol";

/// @notice SIMULATION ONLY (never pass --broadcast). Runs deposit -> postResult -> claimSwap against
/// the DEPLOYED testnet bytecode on a fork, so it consumes no real Hub block number.
/// Doubles as a reference for how the operator must build digests, leaves and signatures.
contract SmokeSwapFork is Script {
    Hub hub;
    MainBridge bridge;
    TestUSDC usdc;
    TestUSDT usdt;
    address swapAddr;

    address payee;
    address relayer;
    Hub.SwapWithdrawal terms;
    bytes32 salt = keccak256("smoke");

    function run() external {
        hub = Hub(vm.envAddress("HUB"));
        bridge = MainBridge(vm.envAddress("BRIDGE"));
        usdc = TestUSDC(vm.envAddress("USDC"));
        usdt = TestUSDT(vm.envAddress("USDT"));
        swapAddr = vm.envAddress("SWAP");
        payee = makeAddr("payee");
        relayer = makeAddr("relayer");

        _deposit();
        terms = Hub.SwapWithdrawal({
            payee: payee,
            tokenIn: address(usdc),
            tokenOut: address(usdt),
            amountIn: 100e6,
            minOut: 99e6,
            maxFee: 100_000,
            nonce: 0
        });
        bytes32 leaf = hub.swapWithdrawalLeaf(terms, salt); // single-leaf tree: root == leaf, empty proof
        _attest(leaf);

        vm.prank(relayer);
        hub.claimSwap(1, terms, salt, new bytes32[](0));
        _report();
    }

    function _deposit() internal {
        address funder = makeAddr("funder");
        vm.startPrank(funder);
        usdc.mint(funder, 1_000e6);
        usdc.approve(address(bridge), type(uint256).max);
        bridge.deposit(address(usdc), 1_000e6, makeAddr("treasuryInDomain"));
        vm.stopPrank();
    }

    /// @dev Two operators sign the result for domain block 1; signatures sorted by ascending signer.
    function _attest(bytes32 msgRoot) internal {
        uint64 monadBlock = uint64(block.number);
        bytes32 stateRoot = keccak256("state");
        bytes32 digest = hub.resultDigest(1, monadBlock, stateRoot, msgRoot);
        uint256 pk1 = vm.envUint("OPERATOR_PK_1");
        uint256 pk2 = vm.envUint("OPERATOR_PK_2");
        (uint256 lo, uint256 hi) = vm.addr(pk1) < vm.addr(pk2) ? (pk1, pk2) : (pk2, pk1);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(lo, digest);
        sigs[1] = _sign(hi, digest);
        hub.postResult(1, monadBlock, stateRoot, msgRoot, sigs);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _report() internal view {
        console2.log("payee tUSDT   :", usdt.balanceOf(payee));
        console2.log("relayer fee   :", usdt.balanceOf(relayer));
        console2.log("payee tUSDC   :", usdc.balanceOf(payee));
        console2.log("bridge tUSDC  :", usdc.balanceOf(address(bridge)));
        require(usdt.balanceOf(payee) == 99_900_000, "payee amount");
        require(usdt.balanceOf(relayer) == 50_000, "relayer fee");
        require(usdc.allowance(address(bridge), swapAddr) == 0, "approval left open");
        console2.log("SMOKE OK (simulated on fork, nothing broadcast)");
    }
}
