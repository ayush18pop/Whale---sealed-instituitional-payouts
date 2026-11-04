// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {MainBridge} from "../src/MainBridge.sol";
import {Hub} from "../src/Hub.sol";
import {IMainBridge} from "../src/interfaces/IMainBridge.sol";

/// @notice Deploys the Monad-side contracts: TestUSDC, MainBridge, Hub, then wires them.
/// Env: DEPLOYER_PRIVATE_KEY, OPERATOR_ADDR_1..3, ENC_PUBLIC_KEY (65-byte uncompressed secp256k1).
contract DeployMonad is Script {
    uint256 internal constant DOMAIN_CHAIN_ID = 7777;
    uint8 internal constant THRESHOLD = 2;

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
        MainBridge bridge = new MainBridge();
        Hub hub = new Hub(IMainBridge(address(bridge)), DOMAIN_CHAIN_ID, ops, THRESHOLD, encKey);
        bridge.setHub(address(hub));
        bridge.setTokenAllowed(address(usdc), true);
        vm.stopBroadcast();

        console2.log("TestUSDC  :", address(usdc));
        console2.log("MainBridge:", address(bridge));
        console2.log("Hub       :", address(hub));
    }
}
