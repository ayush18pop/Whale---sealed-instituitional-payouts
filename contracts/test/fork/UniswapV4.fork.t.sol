// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {UniswapV4Adapter} from "../../src/UniswapV4Adapter.sol";
import {PoolSeeder} from "../../src/PoolSeeder.sol";
import {TestUSDC} from "../../src/TestUSDC.sol";
import {TestUSDT} from "../../src/TestUSDT.sol";

/// @dev Fork tests against the REAL Monad testnet Uniswap v4 PoolManager. Gated: they only run when
///      RUN_FORK_TESTS=1 and MONAD_TESTNET_RPC are set, so a plain `forge test` stays offline and fast.
///      Fresh mock tokens are deployed on the fork, so each run creates its own pool.
contract UniswapV4ForkTest is Test {
    address constant POOL_MANAGER = 0x451D64ab3b650040d2aE1886602b97ed6eDc643d; // Monad-maintained v4 testnet
    uint160 constant SQRT_PRICE_1_TO_1 = 79228162514264337593543950336; // 2**96

    TestUSDC tokenA;
    TestUSDT tokenB;
    PoolSeeder seeder;
    UniswapV4Adapter adapter;
    address recipient = makeAddr("recipient");

    function setUp() public {
        if (!vm.envOr("RUN_FORK_TESTS", false)) vm.skip(true);
        vm.createSelectFork(vm.envString("MONAD_TESTNET_RPC"));

        tokenA = new TestUSDC();
        tokenB = new TestUSDT();
        seeder = new PoolSeeder(POOL_MANAGER, address(tokenA), address(tokenB), 500, 10);
        adapter = new UniswapV4Adapter(POOL_MANAGER, address(this), address(tokenA), address(tokenB), 500, 10);

        tokenA.mint(address(seeder), 5_000_000e6);
        tokenB.mint(address(seeder), 5_000_000e6);
        seeder.initializePool(SQRT_PRICE_1_TO_1);
        seeder.addLiquidity(-1000, 1000, 4e12); // roughly 195k of each token, +-10% around 1:1
    }

    function _mint(address token, uint256 amt) internal {
        TestUSDC(token).mint(address(this), amt); // both mock tokens share the same open mint
        TestUSDC(token).approve(address(adapter), type(uint256).max);
    }

    function test_swap_forward_paysAboutAmountMinusPoolFee() public {
        address tin = adapter.currency0();
        address tout = adapter.currency1();
        _mint(tin, 100e6);
        uint256 out = adapter.swapExactIn(tin, tout, 100e6, 0, recipient);
        console2.log("100 in -> out (6 decimals):", out);
        assertEq(TestUSDC(tout).balanceOf(recipient), out);
        assertGt(out, 99_900_000, "fee 0.05% + tiny impact");
        assertLt(out, 100_000_000, "cannot exceed the input at a 1:1 price");
        assertEq(TestUSDC(tin).balanceOf(address(adapter)), 0, "adapter keeps no input");
        assertEq(TestUSDC(tout).balanceOf(address(adapter)), 0, "adapter keeps no output");
    }

    function test_swap_reverse() public {
        address tin = adapter.currency1();
        address tout = adapter.currency0();
        _mint(tin, 100e6);
        uint256 out = adapter.swapExactIn(tin, tout, 100e6, 0, recipient);
        console2.log("reverse 100 in -> out:", out);
        assertGt(out, 99_900_000);
        assertEq(TestUSDC(tout).balanceOf(recipient), out);
    }

    function test_swap_revertsBelowMinOut() public {
        address tin = adapter.currency0();
        address tout = adapter.currency1(); // read before expectRevert: it attaches to the NEXT external call
        _mint(tin, 100e6);
        vm.expectRevert(UniswapV4Adapter.Slippage.selector);
        adapter.swapExactIn(tin, tout, 100e6, 100e6, recipient); // cannot get >= 100 back after fees
        assertEq(TestUSDC(tin).balanceOf(address(this)), 100e6, "revert returns the input");
    }

    function test_swap_revertsInsteadOfPartialFill() public {
        address tin = adapter.currency0();
        address tout = adapter.currency1();
        _mint(tin, 5_000_000e6);
        vm.expectRevert(UniswapV4Adapter.PartialFill.selector); // far more than the +-10% range can absorb
        adapter.swapExactIn(tin, tout, 5_000_000e6, 0, recipient);
    }

    function test_priceMover_makesALaterSwapFailItsMinOut() public {
        address tin = adapter.currency0();
        address tout = adapter.currency1();
        _mint(tin, 200e6);

        uint256 before = adapter.swapExactIn(tin, tout, 100e6, 0, recipient);

        seeder.swapExactIn(true, 60_000e6); // push the price (tin -> tout) by selling 60k of tin
        uint256 afterMove = adapter.swapExactIn(tin, tout, 100e6, 0, recipient);
        console2.log("100 in -> out BEFORE the move:", before);
        console2.log("100 in -> out AFTER the move :", afterMove);
        assertLt(afterMove, before, "price moved against the seller");

        // the payee's minOut (as used in claim-and-swap) now rejects the same trade
        _mint(tin, 100e6);
        vm.expectRevert(UniswapV4Adapter.Slippage.selector);
        adapter.swapExactIn(tin, tout, 100e6, before - 1, recipient);
    }
}
