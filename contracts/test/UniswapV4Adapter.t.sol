// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {UniswapV4Adapter} from "../src/UniswapV4Adapter.sol";
import {PoolSeeder} from "../src/PoolSeeder.sol";
import {PoolKey} from "../src/interfaces/IPoolManagerLite.sol";

/// @dev Offline tests: configuration and access control only (nothing here reaches a PoolManager).
contract UniswapV4AdapterOfflineTest is Test {
    address pm = makeAddr("poolManager");
    address bridge = makeAddr("bridge");
    address tokenLow = address(0x1000);
    address tokenHigh = address(0x2000);
    address stranger = makeAddr("stranger");
    UniswapV4Adapter adapter;
    PoolSeeder seeder;

    function setUp() public {
        adapter = new UniswapV4Adapter(pm, bridge, tokenHigh, tokenLow, 500, 10); // given out of order on purpose
        seeder = new PoolSeeder(pm, tokenHigh, tokenLow, 500, 10);
    }

    function test_constructor_sortsCurrencies() public view {
        assertEq(adapter.currency0(), tokenLow);
        assertEq(adapter.currency1(), tokenHigh);
        PoolKey memory k = adapter.poolKey();
        assertEq(k.currency0, tokenLow);
        assertEq(k.currency1, tokenHigh);
        assertEq(k.fee, 500);
        assertEq(k.tickSpacing, 10);
        assertEq(k.hooks, address(0));
        assertEq(seeder.currency0(), tokenLow);
    }

    function test_constructor_rejectsBadConfig() public {
        vm.expectRevert(UniswapV4Adapter.BadConfig.selector);
        new UniswapV4Adapter(address(0), bridge, tokenLow, tokenHigh, 500, 10);
        vm.expectRevert(UniswapV4Adapter.BadConfig.selector);
        new UniswapV4Adapter(pm, address(0), tokenLow, tokenHigh, 500, 10);
        vm.expectRevert(UniswapV4Adapter.BadConfig.selector);
        new UniswapV4Adapter(pm, bridge, tokenLow, tokenLow, 500, 10); // same token
        vm.expectRevert(UniswapV4Adapter.BadConfig.selector);
        new UniswapV4Adapter(pm, bridge, address(0), tokenHigh, 500, 10); // native not supported
        vm.expectRevert(PoolSeeder.BadConfig.selector);
        new PoolSeeder(pm, tokenLow, tokenLow, 500, 10);
    }

    function test_swap_onlyBridge() public {
        vm.prank(stranger);
        vm.expectRevert(UniswapV4Adapter.NotBridge.selector);
        adapter.swapExactIn(tokenLow, tokenHigh, 1e6, 0, stranger);
    }

    function test_swap_rejectsWrongPairAndZeroAmount() public {
        vm.startPrank(bridge);
        vm.expectRevert(UniswapV4Adapter.WrongPair.selector);
        adapter.swapExactIn(tokenLow, address(0x3000), 1e6, 0, bridge); // output not in the pool
        vm.expectRevert(UniswapV4Adapter.WrongPair.selector);
        adapter.swapExactIn(tokenLow, tokenLow, 1e6, 0, bridge); // same token
        vm.expectRevert(UniswapV4Adapter.PartialFill.selector);
        adapter.swapExactIn(tokenLow, tokenHigh, 0, 0, bridge); // zero amount
        vm.stopPrank();
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.prank(stranger);
        vm.expectRevert(UniswapV4Adapter.NotPoolManager.selector);
        adapter.unlockCallback("");
        vm.prank(bridge); // not even the bridge
        vm.expectRevert(UniswapV4Adapter.NotPoolManager.selector);
        adapter.unlockCallback("");
        vm.expectRevert(PoolSeeder.NotPoolManager.selector);
        seeder.unlockCallback("");
    }

    function test_seeder_onlyOwner() public {
        vm.startPrank(stranger);
        vm.expectRevert(PoolSeeder.NotOwner.selector);
        seeder.initializePool(1);
        vm.expectRevert(PoolSeeder.NotOwner.selector);
        seeder.addLiquidity(-10, 10, 1);
        vm.expectRevert(PoolSeeder.NotOwner.selector);
        seeder.swapExactIn(true, 1);
        vm.expectRevert(PoolSeeder.NotOwner.selector);
        seeder.sweep(tokenLow, stranger);
        vm.stopPrank();
    }
}
