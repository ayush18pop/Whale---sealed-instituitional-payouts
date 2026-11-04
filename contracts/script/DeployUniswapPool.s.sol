// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TestUSDC} from "../src/TestUSDC.sol";
import {TestUSDT} from "../src/TestUSDT.sol";
import {UniswapV4Adapter} from "../src/UniswapV4Adapter.sol";
import {PoolSeeder} from "../src/PoolSeeder.sol";
import {PoolKey} from "../src/interfaces/IPoolManagerLite.sol";

/// @notice Creates the tUSDT/tUSDC pool on the Monad-maintained Uniswap v4 testnet deployment, seeds it, and
///         deploys the adapter. It does NOT call MainBridge.setSwapAdapter: switching the venue is a separate,
///         deliberate step (see docs/UNISWAP.md).
/// Env: DEPLOYER_PRIVATE_KEY, BRIDGE, USDC, USDT.
contract DeployUniswapPool is Script {
    address constant POOL_MANAGER = 0x451D64ab3b650040d2aE1886602b97ed6eDc643d;
    uint160 constant SQRT_PRICE_1_TO_1 = 79228162514264337593543950336; // 2**96 (both tokens have 6 decimals)
    uint24 constant FEE = 500; // 0.05%
    int24 constant TICK_SPACING = 10;
    int24 constant TICK_LOWER = -1000; // about -10% .. +10% around 1:1
    int24 constant TICK_UPPER = 1000;
    uint256 constant LIQUIDITY = 4e12; // roughly 195,000 of each token

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address bridge = vm.envAddress("BRIDGE");
        TestUSDC usdc = TestUSDC(vm.envAddress("USDC"));
        TestUSDT usdt = TestUSDT(vm.envAddress("USDT"));

        vm.startBroadcast(pk);
        PoolSeeder seeder = new PoolSeeder(POOL_MANAGER, address(usdc), address(usdt), FEE, TICK_SPACING);
        UniswapV4Adapter adapter =
            new UniswapV4Adapter(POOL_MANAGER, bridge, address(usdc), address(usdt), FEE, TICK_SPACING);

        usdc.mint(address(seeder), 2_000_000e6); // extra headroom so the seeder can also move the price for demos
        usdt.mint(address(seeder), 2_000_000e6);
        seeder.initializePool(SQRT_PRICE_1_TO_1);
        seeder.addLiquidity(TICK_LOWER, TICK_UPPER, LIQUIDITY);
        vm.stopBroadcast();

        PoolKey memory k = adapter.poolKey();
        console2.log("PoolSeeder         :", address(seeder));
        console2.log("UniswapV4Adapter   :", address(adapter));
        console2.log("currency0          :", k.currency0);
        console2.log("currency1          :", k.currency1);
        console2.log("poolId             :");
        console2.logBytes32(keccak256(abi.encode(k)));
    }
}
