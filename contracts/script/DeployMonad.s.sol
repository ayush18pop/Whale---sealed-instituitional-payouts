// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {TestUSDT} from "../src/TestUSDT.sol";
import {MainBridge} from "../src/MainBridge.sol";
import {MockSwap} from "../src/MockSwap.sol";
import {Hub} from "../src/Hub.sol";
import {IMainBridge} from "../src/interfaces/IMainBridge.sol";

/// @notice Deploys and wires the Monad-side contracts: TestUSDC, TestUSDT, MainBridge, MockSwap, Hub.
/// Env: DEPLOYER_PRIVATE_KEY, OPERATOR_ADDR_1..3, ENC_PUBLIC_KEY (65-byte uncompressed secp256k1).
contract DeployMonad is Script {
    uint256 internal constant DOMAIN_CHAIN_ID = 7777;
    uint8 internal constant THRESHOLD = 2;
    uint256 internal constant RELAYER_FEE = 50_000; // 0.05 token (6 decimals), flat, in the output token
    uint256 internal constant POOL_LIQUIDITY = 1_000_000e6; // simulated liquidity per token

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address[] memory ops = new address[](3);
        ops[0] = vm.envAddress("OPERATOR_ADDR_1");
        ops[1] = vm.envAddress("OPERATOR_ADDR_2");
        ops[2] = vm.envAddress("OPERATOR_ADDR_3");
        bytes memory encKey = vm.envBytes("ENC_PUBLIC_KEY");
        require(encKey.length == 65 && encKey[0] == 0x04, "ENC_PUBLIC_KEY must be 65-byte uncompressed");

        vm.startBroadcast(deployerKey);
        TestUSDC usdc = new TestUSDC();
        TestUSDT usdt = new TestUSDT();
        MainBridge bridge = new MainBridge();
        MockSwap swap = new MockSwap(address(bridge));
        Hub hub = new Hub(IMainBridge(address(bridge)), DOMAIN_CHAIN_ID, ops, THRESHOLD, encKey);

        bridge.setHub(address(hub));
        bridge.setTokenAllowed(address(usdc), true);
        bridge.setTokenAllowed(address(usdt), true);
        bridge.setSwapAdapter(address(swap));
        bridge.setRelayerFee(RELAYER_FEE);

        // SIMULATED venue: 1:1 both ways (minus the pool's 0.05% fee), pre-funded.
        swap.setRate(address(usdc), address(usdt), 1e18);
        swap.setRate(address(usdt), address(usdc), 1e18);
        usdc.mint(address(swap), POOL_LIQUIDITY);
        usdt.mint(address(swap), POOL_LIQUIDITY);
        vm.stopBroadcast();

        console2.log("TestUSDC  :", address(usdc));
        console2.log("TestUSDT  :", address(usdt));
        console2.log("MainBridge:", address(bridge));
        console2.log("MockSwap  :", address(swap));
        console2.log("Hub       :", address(hub));
    }
}
